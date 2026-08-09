/**
 * VaultService: the write path (Frontend Part B). See docs/DECISIONS.md D12.
 *
 * The only place the API touches the chain to move state. Owner-only calls (create, fund) go
 * through the Circle treasury wallet, which signs internally and holds the entity secret. The
 * permissionless release goes through the deployer EOA, the way a keeper would. This mirrors the
 * demo scripts exactly; nothing new is trusted, the operations are wrapped, not rewritten.
 *
 * It returns plain result records (policyId, txHash, explorerUrl), never a raw provider object, so
 * the signing boundary in DECISIONS.md D12 holds: no SDK internals or key material can leak into an
 * HTTP response through this layer.
 *
 * Every lifecycle write names its vault. The vault is immutable, so more than one deployment is
 * live, and policy ids restart at 0 on each of them: policy 4 on v2 and policy 4 on v3 are
 * different policies with different recipients. A write that carried only the id would land on
 * whichever deployment this service happened to be pointed at. See vaults.ts.
 *
 * Creation is the exception, and deliberately so: new policies are only ever minted on the primary
 * (newest) deployment.
 */
import { createPublicClient, createWalletClient, decodeEventLog, http, parseAbi, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRequire } from "node:module";
import { chainFor, ARC_DOMAIN } from "../config.js";
import { CircleWalletProvider } from "../wallet/CircleWalletProvider.js";
import { HermesPythClient } from "../oracle/HermesPythClient.js";
import { isWritable, PRIMARY_VAULT_LABEL, VAULT_ENV_VAR, VAULT_LABELS, VAULTS, type VaultLabel } from "./vaults.js";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const CONDITION = { Timelock: 0, Approval: 1, Attestation: 2, Oracle: 3, Schedule: 4, OraclePull: 5 } as const;
const CURRENCY = { USDC: 0, EURC: 1 } as const;
const COMPARATOR = { Gte: 0, Lte: 1 } as const;

export type ComparatorName = keyof typeof COMPARATOR;
const TERMINAL_OK = new Set(["COMPLETE", "CONFIRMED"]);
const TERMINAL_BAD = ["FAILED", "DENIED", "CANCELLED"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type PayoutCurrencyName = keyof typeof CURRENCY;

export interface CreateTimelockInput {
  recipient: `0x${string}`;
  amount: string; // base units, 6 decimals
  payoutCurrency: PayoutCurrencyName;
  destinationDomain: number;
  releaseTime: number; // unix seconds
}

export interface CreateApprovalInput {
  recipient: `0x${string}`;
  amount: string;
  payoutCurrency: PayoutCurrencyName;
  destinationDomain: number;
  approvers: `0x${string}`[];
  threshold: number;
}

export interface CreateAttestationInput {
  recipient: `0x${string}`; amount: string; payoutCurrency: PayoutCurrencyName; destinationDomain: number;
  attester: `0x${string}`;
}

export interface CreateOracleInput {
  recipient: `0x${string}`; amount: string; payoutCurrency: PayoutCurrencyName; destinationDomain: number;
  comparator: ComparatorName; threshold: string; /* int256 in the feed's 8 decimals, as a string */ maxStaleSeconds: number;
}

export interface CreateOraclePullInput {
  recipient: `0x${string}`; amount: string; payoutCurrency: PayoutCurrencyName; destinationDomain: number;
  comparator: ComparatorName;
  /** int256 normalized to 1e18, as a string. NOT the feed's own decimals: the adapter normalizes. */
  threshold1e18: string;
  maxStaleSeconds: number;
  /** Reject when conf/price exceeds this many basis points. 0 disables the guard. */
  maxConfBps: number;
}

export interface CreateRecurringInput {
  recipient: `0x${string}`; payoutCurrency: PayoutCurrencyName; destinationDomain: number;
  amountPerPeriod: string; interval: number; startTime: number; periods: number; maxCatchUp: number;
}

export interface CreateSweepInput {
  recipient: `0x${string}`; payoutCurrency: PayoutCurrencyName; destinationDomain: number;
  buffer: string; minSweep: string; interval: number; startTime: number; maxCatchUp: number;
}

export interface WriteResult {
  txHash: string;
  explorerUrl: string;
}

export interface CreateResult extends WriteResult {
  policyId: string;
}

/**
 * The vault surface this service calls, and every custom error it can revert with.
 *
 * The errors are not decoration. viem decodes a revert only against the ABI it was handed, so
 * without them a refusal reaches the operator as `reverted with the following signature:
 * 0x1f0c1db7` — which is `ConditionNotMet`, unreadably. The API's contract with the app is that a
 * revert arrives verbatim plus a human sentence, and a bare selector honours neither half.
 *
 * A refusal is the most important thing this system does. It has to say what it refused.
 */
const vaultAbi = parseAbi([
  "function nextPolicyId() view returns (uint256)",
  "function release(uint256)",
  "function releaseWithProof(uint256 policyId, bytes proof) payable",
  "event PolicyCreated(uint256 indexed policyId, address indexed recipient, uint256 amount, uint8 payoutCurrency, uint32 destinationDomain, uint8 conditionType)",
  "error ConditionNotMet(uint256 policyId)",
  "error Underfunded(uint256 policyId, uint256 funded, uint256 required)",
  "error PolicyNotPending(uint256 policyId, uint8 status)",
  "error UnknownPolicy(uint256 policyId)",
  "error UseReleasePeriod(uint256 policyId)",
  "error UseReleaseWithProof(uint256 policyId)",
  "error ConfidenceTooWide(uint256 policyId, uint256 conf, uint256 value, uint16 maxConfBps)",
  "error CatchUpStale(uint256 policyId, uint64 nextDue)",
  "error SweepBelowMin(uint256 policyId, uint256 slice, uint256 minSweep)",
  "error PeriodNotDue(uint256 policyId, uint64 nextDue, uint256 nowTs)",
  "error NotAnApprover(uint256 policyId, address caller)",
  "error InsufficientFee(uint256 required, uint256 sent)",
]);

const adapterAbi = parseAbi(["function quoteFee(bytes proof) view returns (uint256)"]);

/** Raised for a vault label this deployment does not serve. The API turns it into a 400, not a 503. */
export class UnknownVaultError extends Error {}

/** Raised for a write aimed at a superseded deployment. Also a 400: the request is wrong, not the service. */
export class ReadOnlyVaultError extends Error {}

export class VaultService {
  private constructor(
    private readonly circle: any,
    private readonly treasuryWalletId: string,
    /** Every live deployment, by label. Writes name one; creation always uses the primary. */
    private readonly vaults: Partial<Record<VaultLabel, `0x${string}`>>,
    private readonly usdc: `0x${string}`,
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly explorerTxUrl: (h: string) => string,
    /** The deployed PythAggregatorV3 wrapper for USDC/USD, backing the pushed-feed Oracle condition. */
    private readonly pythWrapperUsdc: string,
    /** The deployed PythAdapter, backing the pull-oracle condition. */
    private readonly pythAdapter: string,
    /** Pyth's feed id for USDC/USD, which OraclePull stores per policy. */
    private readonly pythFeedId: string,
  ) {}

  /** Build the service from the environment, resolving the Circle treasury wallet. */
  static async fromEnv(): Promise<VaultService> {
    const need = (n: string): string => {
      const v = process.env[n];
      if (!v) throw new Error(`${n} is not set.`);
      return v;
    };
    const arc = chainFor(ARC_DOMAIN);
    const rpc = need("ARC_TESTNET_RPC_URL");
    const chain = { id: arc.chainId, name: arc.name, nativeCurrency: arc.nativeCurrency, rpcUrls: { default: { http: [rpc] } } };
    const transport = http(rpc, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 });

    const publicClient = createPublicClient({ chain, transport }) as PublicClient;
    const eoa = privateKeyToAccount(need("DEPLOYER_PRIVATE_KEY") as `0x${string}`);
    const walletClient = createWalletClient({ account: eoa, chain, transport });

    const circle = initiateDeveloperControlledWalletsClient({ apiKey: need("CIRCLE_API_KEY"), entitySecret: need("CIRCLE_ENTITY_SECRET") });
    const treasury = await CircleWalletProvider.fromEnv().getWallet("treasury", ARC_DOMAIN);

    // The primary must be configured; superseded deployments are optional, and simply absent from
    // the registry when their address is unset.
    const vaults: Partial<Record<VaultLabel, `0x${string}`>> = {};
    for (const label of VAULT_LABELS) {
      const address = label === PRIMARY_VAULT_LABEL
        ? need(VAULT_ENV_VAR[label])
        : process.env[VAULT_ENV_VAR[label]];
      if (address) vaults[label] = address as `0x${string}`;
    }

    return new VaultService(
      circle, treasury.walletId,
      vaults,
      need("ARC_USDC_ADDRESS") as `0x${string}`,
      publicClient, walletClient, arc.explorerTxUrl,
      process.env.ARC_PYTH_WRAPPER_USDC ?? "",
      process.env.ARC_PYTH_ADAPTER_ADDRESS ?? "",
      process.env.PYTH_USDC_USD_FEED_ID ?? "",
    );
  }

  /** Resolve a label to its deployment address, refusing anything not configured. */
  private addressOf(label: VaultLabel): `0x${string}` {
    const address = this.vaults[label];
    if (!address) {
      throw new UnknownVaultError(
        `No vault is configured for "${label}". Set ${VAULT_ENV_VAR[label] ?? "its address"} to write to it.`,
      );
    }
    return address;
  }

  /**
   * Resolve a label for a WRITE, refusing superseded deployments.
   *
   * The older vaults still hold policies and are still read, so an address alone does not mean a
   * write is welcome. Their policies were cancelled and refunded during the v4 migration and their
   * proofs are recorded; writing to them now would add state to a record that is supposed to be
   * closed. Refusing here, rather than in the UI alone, means a hand-made API call cannot do it
   * either.
   */
  private writableAddressOf(label: VaultLabel): `0x${string}` {
    if (!isWritable(label)) {
      throw new ReadOnlyVaultError(
        `${label} is read-only. ${VAULTS[label].note} Writes go to ${PRIMARY_VAULT_LABEL}.`,
      );
    }
    return this.addressOf(label);
  }

  /** The deployment new policies are minted on. */
  private get primary(): `0x${string}` {
    return this.addressOf(PRIMARY_VAULT_LABEL);
  }

  /** Owner-only contract call through the Circle treasury wallet. Polls to a terminal state. */
  private async ownerSend(contractAddress: string, signature: string, params: unknown[]): Promise<string> {
    const created = await this.circle.createContractExecutionTransaction({
      walletId: this.treasuryWalletId, contractAddress, abiFunctionSignature: signature, abiParameters: params,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const id = created.data?.id;
    const deadline = Date.now() + 180_000;
    for (;;) {
      const tx = (await this.circle.getTransaction({ id })).data?.transaction;
      if (tx && TERMINAL_OK.has(tx.state)) return tx.txHash as string;
      if (tx && TERMINAL_BAD.includes(tx.state)) {
        throw new Error(`${signature} ended ${tx.state}: ${[tx.errorReason, tx.errorDetails].filter(Boolean).join(" - ")}`);
      }
      if (Date.now() > deadline) throw new Error(`${signature} did not settle within 180s`);
      await sleep(2_000);
    }
  }

  private result(txHash: string): WriteResult {
    return { txHash, explorerUrl: this.explorerTxUrl(txHash) };
  }

  /**
   * The id of the policy a create transaction actually produced, read from its PolicyCreated log.
   *
   * Not from nextPolicyId(). Reading the counter before sending only reports the id the policy
   * WOULD have had if nothing else landed first, and any concurrent create, from another request
   * or from a demo script, silently shifts it. The caller funds whatever id it is handed, so a
   * guess that is one off funds a stranger's policy. The receipt is the only account of what was
   * created that cannot be wrong.
   */
  private async createdPolicyId(txHash: string, vault: `0x${string}`): Promise<string> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
    if (receipt.status === "reverted") {
      throw new Error(`The create transaction ${txHash} reverted onchain. No policy was created.`);
    }

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== vault.toLowerCase()) continue;
      try {
        const event = decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics });
        if (event.eventName === "PolicyCreated") {
          return (event.args as { policyId: bigint }).policyId.toString();
        }
      } catch {
        // Another event from the same contract. Keep looking.
      }
    }

    throw new Error(
      `The create transaction ${txHash} succeeded but emitted no PolicyCreated event. ` +
        `Confirm what it created before funding anything.`,
    );
  }

  /** Create a policy on the primary vault and report the id its receipt proves it produced. */
  private async create(signature: string, params: unknown[]): Promise<CreateResult> {
    const vault = this.primary;
    const txHash = await this.ownerSend(vault, signature, params);
    return { policyId: await this.createdPolicyId(txHash, vault), ...this.result(txHash) };
  }

  async createTimelock(input: CreateTimelockInput): Promise<CreateResult> {
    return this.create(
      "createPolicy(address,uint256,uint8,uint32,uint8,uint64,address[],uint8)",
      [input.recipient, input.amount, CURRENCY[input.payoutCurrency], input.destinationDomain, CONDITION.Timelock, input.releaseTime.toString(), [], 0],
    );
  }

  async createApproval(input: CreateApprovalInput): Promise<CreateResult> {
    return this.create(
      "createPolicy(address,uint256,uint8,uint32,uint8,uint64,address[],uint8)",
      [input.recipient, input.amount, CURRENCY[input.payoutCurrency], input.destinationDomain, CONDITION.Approval, 0, input.approvers, input.threshold],
    );
  }

  async createAttestation(input: CreateAttestationInput): Promise<CreateResult> {
    return this.create(
      "createAttestationPolicy(address,uint256,uint8,uint32,address)",
      [input.recipient, input.amount, CURRENCY[input.payoutCurrency], input.destinationDomain, input.attester],
    );
  }

  async createOracle(input: CreateOracleInput): Promise<CreateResult> {
    if (!this.pythWrapperUsdc) throw new Error("ARC_PYTH_WRAPPER_USDC is not set; the oracle feed is unavailable.");
    return this.create(
      "createOraclePolicy(address,uint256,uint8,uint32,address,uint8,int256,uint64)",
      [input.recipient, input.amount, CURRENCY[input.payoutCurrency], input.destinationDomain,
        this.pythWrapperUsdc, COMPARATOR[input.comparator], input.threshold, input.maxStaleSeconds.toString()],
    );
  }

  /**
   * Create a pull-oracle policy: verified atomically at release, and able to reject a price the
   * oracle itself is unsure about.
   */
  async createOraclePull(input: CreateOraclePullInput): Promise<CreateResult> {
    if (!this.pythAdapter) {
      throw new Error("ARC_PYTH_ADAPTER_ADDRESS is not set; the pull-oracle path is unavailable.");
    }
    if (!this.pythFeedId) {
      throw new Error("PYTH_USDC_USD_FEED_ID is not set; the pull-oracle path has no feed.");
    }
    return this.create(
      "createOraclePullPolicy(address,uint256,uint8,uint32,address,bytes32,uint8,int256,uint64,uint16)",
      [input.recipient, input.amount, CURRENCY[input.payoutCurrency], input.destinationDomain,
        this.pythAdapter, this.pythFeedId, COMPARATOR[input.comparator], input.threshold1e18,
        input.maxStaleSeconds.toString(), input.maxConfBps.toString()],
    );
  }

  async createRecurring(input: CreateRecurringInput): Promise<CreateResult> {
    return this.create(
      "createRecurringPolicy(address,uint8,uint32,uint256,uint64,uint64,uint32,uint64)",
      [input.recipient, CURRENCY[input.payoutCurrency], input.destinationDomain, input.amountPerPeriod,
        input.interval.toString(), input.startTime.toString(), input.periods.toString(), input.maxCatchUp.toString()],
    );
  }

  async createSweep(input: CreateSweepInput): Promise<CreateResult> {
    return this.create(
      "createSweepPolicy(address,uint8,uint32,uint256,uint256,uint64,uint64,uint64)",
      [input.recipient, CURRENCY[input.payoutCurrency], input.destinationDomain, input.buffer, input.minSweep,
        input.interval.toString(), input.startTime.toString(), input.maxCatchUp.toString()],
    );
  }

  /**
   * Fund a policy from the treasury: approve then deposit, both against the named deployment.
   *
   * The allowance is granted to the same vault the deposit goes to. Approving one deployment and
   * depositing into another is how the money ends up somewhere nobody asked for.
   */
  async fund(vault: VaultLabel, policyId: string, amount: string): Promise<WriteResult> {
    const address = this.writableAddressOf(vault);
    await this.ownerSend(this.usdc, "approve(address,uint256)", [address, amount]);
    const txHash = await this.ownerSend(address, "deposit(uint256,uint256)", [policyId, amount]);
    return this.result(txHash);
  }

  /** Approve an approval-type policy, as an authorized approver, through the treasury wallet. */
  async approve(vault: VaultLabel, policyId: string): Promise<WriteResult> {
    const txHash = await this.ownerSend(this.writableAddressOf(vault), "approve(uint256)", [policyId]);
    return this.result(txHash);
  }

  /**
   * Release a pull-oracle policy: fetch a signed price update, quote the fee, and verify-and-release
   * in one transaction.
   *
   * The proof is fetched here rather than accepted from the caller. An operator clicking "release"
   * is asking for the current price to be tested against the policy, not supplying their own view of
   * it, and a proof parameter on a public API would be an invitation to submit a chosen one. Pyth
   * signs it, the adapter verifies it, and neither trusts this process.
   */
  async releaseWithProof(vault: VaultLabel, policyId: string): Promise<WriteResult> {
    const address = this.writableAddressOf(vault);
    if (!this.pythAdapter) {
      throw new Error("ARC_PYTH_ADAPTER_ADDRESS is not set; the pull-oracle path is unavailable.");
    }

    const { updateData } = await new HermesPythClient().fetch(this.pythFeedId);
    const proof = updateData[0];
    if (!proof) throw new Error("Hermes returned no update blob for the feed.");

    const fee = (await this.publicClient.readContract({
      address: this.pythAdapter as `0x${string}`, abi: adapterAbi, functionName: "quoteFee", args: [proof],
    })) as bigint;

    const hash = await this.walletClient.writeContract({
      address, abi: vaultAbi, functionName: "releaseWithProof", args: [BigInt(policyId), proof],
      value: fee,
      account: this.walletClient.account!, chain: this.walletClient.chain,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") {
      throw new Error(
        `releaseWithProof(${policyId}) on ${vault} reverted onchain in ${hash}. The price did not ` +
          `cross the threshold, its confidence was too wide, or the proof fell outside the freshness ` +
          `window. No funds moved.`,
      );
    }
    return this.result(hash);
  }

  /** Release a policy. Permissionless onchain; sent from the deployer EOA like a keeper. */
  async release(vault: VaultLabel, policyId: string): Promise<WriteResult> {
    const hash = await this.walletClient.writeContract({
      address: this.writableAddressOf(vault), abi: vaultAbi, functionName: "release", args: [BigInt(policyId)],
      account: this.walletClient.account!, chain: this.walletClient.chain,
    });

    // waitForTransactionReceipt resolves for a reverted transaction too. Without this check a
    // release the contract refused would be reported to the operator as a success, with a link to
    // the transaction that proves it failed.
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") {
      throw new Error(
        `release(${policyId}) on ${vault} reverted onchain in ${hash}. The condition was not met, ` +
          `or the policy was already released. No funds moved.`,
      );
    }
    return this.result(hash);
  }
}
