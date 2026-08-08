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
 * Stage 1 exposes the two condition types the build starts with, timelock and approval, plus fund
 * and release. Attestation, oracle, recurring, and sweep slot in behind the same shape.
 */
import { createPublicClient, createWalletClient, http, parseAbi, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRequire } from "node:module";
import { chainFor, ARC_DOMAIN } from "../config.js";
import { CircleWalletProvider } from "../wallet/CircleWalletProvider.js";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const CONDITION = { Timelock: 0, Approval: 1, Attestation: 2, Oracle: 3 } as const;
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

const vaultAbi = parseAbi([
  "function nextPolicyId() view returns (uint256)",
  "function release(uint256)",
]);

export class VaultService {
  private constructor(
    private readonly circle: any,
    private readonly treasuryWalletId: string,
    private readonly vault: `0x${string}`,
    private readonly usdc: `0x${string}`,
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly explorerTxUrl: (h: string) => string,
    /** The deployed PythAggregatorV3 wrapper for USDC/USD, the only oracle feed supported in v1. */
    private readonly pythWrapperUsdc: string,
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

    return new VaultService(
      circle, treasury.walletId,
      need("POLICY_VAULT_V3_ADDRESS") as `0x${string}`,
      need("ARC_USDC_ADDRESS") as `0x${string}`,
      publicClient, walletClient, arc.explorerTxUrl,
      process.env.ARC_PYTH_WRAPPER_USDC ?? "",
    );
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

  private async nextPolicyId(): Promise<bigint> {
    return (await this.publicClient.readContract({ address: this.vault, abi: vaultAbi, functionName: "nextPolicyId" })) as bigint;
  }

  private result(txHash: string): WriteResult {
    return { txHash, explorerUrl: this.explorerTxUrl(txHash) };
  }

  async createTimelock(input: CreateTimelockInput): Promise<CreateResult> {
    const policyId = await this.nextPolicyId();
    const txHash = await this.ownerSend(
      this.vault,
      "createPolicy(address,uint256,uint8,uint32,uint8,uint64,address[],uint8)",
      [input.recipient, input.amount, CURRENCY[input.payoutCurrency], input.destinationDomain, CONDITION.Timelock, input.releaseTime.toString(), [], 0],
    );
    return { policyId: policyId.toString(), ...this.result(txHash) };
  }

  async createApproval(input: CreateApprovalInput): Promise<CreateResult> {
    const policyId = await this.nextPolicyId();
    const txHash = await this.ownerSend(
      this.vault,
      "createPolicy(address,uint256,uint8,uint32,uint8,uint64,address[],uint8)",
      [input.recipient, input.amount, CURRENCY[input.payoutCurrency], input.destinationDomain, CONDITION.Approval, 0, input.approvers, input.threshold],
    );
    return { policyId: policyId.toString(), ...this.result(txHash) };
  }

  async createAttestation(input: CreateAttestationInput): Promise<CreateResult> {
    const policyId = await this.nextPolicyId();
    const txHash = await this.ownerSend(
      this.vault,
      "createAttestationPolicy(address,uint256,uint8,uint32,address)",
      [input.recipient, input.amount, CURRENCY[input.payoutCurrency], input.destinationDomain, input.attester],
    );
    return { policyId: policyId.toString(), ...this.result(txHash) };
  }

  async createOracle(input: CreateOracleInput): Promise<CreateResult> {
    if (!this.pythWrapperUsdc) throw new Error("ARC_PYTH_WRAPPER_USDC is not set; the oracle feed is unavailable.");
    const policyId = await this.nextPolicyId();
    const txHash = await this.ownerSend(
      this.vault,
      "createOraclePolicy(address,uint256,uint8,uint32,address,uint8,int256,uint64)",
      [input.recipient, input.amount, CURRENCY[input.payoutCurrency], input.destinationDomain,
        this.pythWrapperUsdc, COMPARATOR[input.comparator], input.threshold, input.maxStaleSeconds.toString()],
    );
    return { policyId: policyId.toString(), ...this.result(txHash) };
  }

  async createRecurring(input: CreateRecurringInput): Promise<CreateResult> {
    const policyId = await this.nextPolicyId();
    const txHash = await this.ownerSend(
      this.vault,
      "createRecurringPolicy(address,uint8,uint32,uint256,uint64,uint64,uint32,uint64)",
      [input.recipient, CURRENCY[input.payoutCurrency], input.destinationDomain, input.amountPerPeriod,
        input.interval.toString(), input.startTime.toString(), input.periods.toString(), input.maxCatchUp.toString()],
    );
    return { policyId: policyId.toString(), ...this.result(txHash) };
  }

  async createSweep(input: CreateSweepInput): Promise<CreateResult> {
    const policyId = await this.nextPolicyId();
    const txHash = await this.ownerSend(
      this.vault,
      "createSweepPolicy(address,uint8,uint32,uint256,uint256,uint64,uint64,uint64)",
      [input.recipient, CURRENCY[input.payoutCurrency], input.destinationDomain, input.buffer, input.minSweep,
        input.interval.toString(), input.startTime.toString(), input.maxCatchUp.toString()],
    );
    return { policyId: policyId.toString(), ...this.result(txHash) };
  }

  /** Fund a policy from the treasury: approve then deposit. */
  async fund(policyId: string, amount: string): Promise<WriteResult> {
    await this.ownerSend(this.usdc, "approve(address,uint256)", [this.vault, amount]);
    const txHash = await this.ownerSend(this.vault, "deposit(uint256,uint256)", [policyId, amount]);
    return this.result(txHash);
  }

  /** Approve an approval-type policy, as an authorized approver, through the treasury wallet. */
  async approve(policyId: string): Promise<WriteResult> {
    const txHash = await this.ownerSend(this.vault, "approve(uint256)", [policyId]);
    return this.result(txHash);
  }

  /** Release a policy. Permissionless onchain; sent from the deployer EOA like a keeper. */
  async release(policyId: string): Promise<WriteResult> {
    const hash = await this.walletClient.writeContract({
      address: this.vault, abi: vaultAbi, functionName: "release", args: [BigInt(policyId)],
      account: this.walletClient.account!, chain: this.walletClient.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return this.result(hash);
  }
}
