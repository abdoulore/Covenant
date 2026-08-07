/**
 * Circle Gateway funding rail (Integration 1). Lets a treasury fund an Arc policy from a unified
 * USDC balance sourced on any Gateway chain, with no manual bridge. Gateway is upstream of the vault:
 * this puts USDC on Arc, and the caller then funds the policy through the vault's normal deposit().
 * The vault and its lock are unchanged. See docs/specs/PHASE2_GATEWAY.md, DECISIONS D11, V23.
 *
 * THE HAZARD. USDC enters the unified balance ONLY through GatewayWallet.deposit(token, amount). A
 * bare ERC-20 transfer to the GatewayWallet address is unrecoverable. To make that mistake
 * unrepresentable, the GatewayWallet address literal lives in exactly one place, GATEWAY_WALLET
 * below, and the only operation this module performs on it is deposit(), never transfer(). The
 * gateway-no-bare-transfer test asserts the literal appears nowhere else. If you reach for the
 * address to move USDC any other way, you are doing something wrong.
 *
 * THE DELEGATE. Spends are signed by a dedicated delegate key that can move the entire unified
 * balance, so it is never the deployer (D11). A freshly authorized delegate is honored by the
 * Gateway API only after Base Sepolia hard finality (~10 to 15 min, V23); requestAttestation retries
 * through that window rather than treating a fresh addDelegate as immediately usable.
 */
import { createPublicClient, createWalletClient, http, parseAbi, pad, maxUint256, type Account, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { chainFor } from "../config.js";

import { GATEWAY_WALLET, GATEWAY_MINTER } from "./addresses.js";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

export { GATEWAY_WALLET, GATEWAY_MINTER };

const TRANSFER_API = "https://gateway-api-testnet.circle.com/v1/transfer";
const BALANCES_API = "https://gateway-api-testnet.circle.com/v1/balances";

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const minterAbi = parseAbi(["function gatewayMint(bytes,bytes)"]);

const BURN_INTENT_TYPES = {
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
} as const;

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const toB32 = (a: string) => pad(a.toLowerCase() as `0x${string}`, { size: 32 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL_OK = new Set(["COMPLETE", "CONFIRMED"]);

export interface GatewayFunderConfig {
  circle: any;
  /** Circle walletId of the depositor SCA on the source chain. */
  depositorWalletId: string;
  depositorAddress: `0x${string}`;
  sourceUsdc: `0x${string}`;
  arcUsdc: `0x${string}`;
  /** Dedicated delegate; signs burn intents. Never the deployer. */
  delegate: Account;
  arcPublic: PublicClient;
  arcWallet: WalletClient;
  /** Funded Arc account that sends the gatewayMint tx. The delegate only signs burn intents off-chain. */
  arcMinter: Account;
  sourceDomain?: number;
  destinationDomain?: number;
  /** Cap on the fee taken from a spend, base units. */
  maxFee?: bigint;
  log?: (m: string) => void;
}

export class GatewayFunder {
  private readonly c: Required<GatewayFunderConfig>;

  constructor(config: GatewayFunderConfig) {
    this.c = {
      sourceDomain: 6,
      destinationDomain: 26,
      maxFee: 100_000n,
      log: () => {},
      ...config,
    } as Required<GatewayFunderConfig>;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): GatewayFunder {
    const need = (n: string): string => {
      const v = env[n];
      if (!v) throw new Error(`${n} is not set.`);
      return v;
    };
    const arc = chainFor(26);
    const arcRpc = need("ARC_TESTNET_RPC_URL");
    const arcChain = { id: arc.chainId, name: arc.name, nativeCurrency: arc.nativeCurrency, rpcUrls: { default: { http: [arcRpc] } } };
    const delegate = privateKeyToAccount(need("DELEGATE_PRIVATE_KEY") as `0x${string}`);
    // The mint tx pays gas on Arc, so it is sent by a funded account, not the fresh delegate.
    const minter = privateKeyToAccount(need("DEPLOYER_PRIVATE_KEY") as `0x${string}`);
    return new GatewayFunder({
      circle: initiateDeveloperControlledWalletsClient({ apiKey: need("CIRCLE_API_KEY"), entitySecret: need("CIRCLE_ENTITY_SECRET") }),
      depositorWalletId: need("GATEWAY_DEPOSITOR_WALLET_ID"),
      depositorAddress: need("GATEWAY_DEPOSITOR_ADDRESS") as `0x${string}`,
      sourceUsdc: need("BASE_SEPOLIA_USDC_ADDRESS") as `0x${string}`,
      arcUsdc: need("ARC_USDC_ADDRESS") as `0x${string}`,
      delegate,
      arcMinter: minter,
      arcPublic: createPublicClient({ chain: arcChain, transport: http(arcRpc, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 }) }) as PublicClient,
      arcWallet: createWalletClient({ account: minter, chain: arcChain, transport: http(arcRpc, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 }) }),
      maxFee: 50_000n,
      log: (m: string) => console.log(`  [gateway] ${m}`),
    });
  }

  /** Fund an Arc address from the unified balance: top up if needed, then spend and mint on Arc. */
  async fundArcAddress(amount: bigint, arcRecipient: `0x${string}`): Promise<{ mintTx: string; delivered: bigint; depositTx?: string }> {
    const depositTx = await this.ensureUnifiedBalance(amount);
    const { mintTx, delivered } = await this.spendToArc(amount, arcRecipient);
    return { mintTx, delivered, depositTx };
  }

  /** Unified USDC balance on the source domain, base units. */
  async unifiedBalance(): Promise<bigint> {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(BALANCES_API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: "USDC", sources: [{ domain: this.c.sourceDomain, depositor: this.c.depositorAddress }] }),
        });
        if (!res.ok) throw new Error(`balances API ${res.status}: ${await res.text()}`);
        const j: any = await res.json();
        const human = j.balances?.[0]?.balance ?? "0";
        return BigInt(Math.round(Number(human) * 1e6));
      } catch (e) {
        if (attempt >= 4) throw e;
        await sleep(3_000); // transient network error, retry
      }
    }
  }

  /** Deposit the shortfall into the unified balance if it cannot cover `amount`. */
  async ensureUnifiedBalance(amount: bigint): Promise<string | undefined> {
    // The Gateway fee is charged on top of the spend value, so reserve headroom for it (V23/V5).
    const target = amount + this.c.maxFee;
    let have = await this.unifiedBalance();
    if (have >= target) return undefined;
    const shortfall = target - have;
    this.c.log(`unified balance ${have} < ${target}, depositing ${shortfall}`);
    const tx = await this.depositToGateway(shortfall);
    // Wait for the credit to finalize before spending, or the spend fails on insufficient balance.
    const deadline = Date.now() + 5 * 60_000;
    while (have < target && Date.now() < deadline) {
      await sleep(15_000);
      have = await this.unifiedBalance();
      this.c.log(`waiting for deposit credit: ${have}/${target}`);
    }
    if (have < target) throw new Error(`deposit did not credit in time: ${have} < ${target}`);
    return tx;
  }

  /**
   * The ONLY place USDC is moved into the GatewayWallet. approve, then deposit(token, amount). Never
   * a transfer. Returns the deposit tx hash. The credit finalizes shortly after (soft finality).
   */
  private async depositToGateway(amount: bigint): Promise<string> {
    await this.circleSend(this.c.sourceUsdc, "approve(address,uint256)", [GATEWAY_WALLET, amount.toString()]);
    return this.circleSend(GATEWAY_WALLET, "deposit(address,uint256)", [this.c.sourceUsdc, amount.toString()]);
  }

  /** Spend `amount` from the unified balance and mint it on Arc to `recipient`. */
  async spendToArc(amount: bigint, recipient: `0x${string}`): Promise<{ mintTx: string; delivered: bigint }> {
    const signature = await this.signBurnIntent(amount, recipient);
    const { attestation, opSig } = await this.requestAttestation(amount, recipient, signature);

    const before = (await this.c.arcPublic.readContract({ address: this.c.arcUsdc, abi: erc20, functionName: "balanceOf", args: [recipient] })) as bigint;
    const mintTx = await this.c.arcWallet.writeContract({
      address: GATEWAY_MINTER, abi: minterAbi, functionName: "gatewayMint", args: [attestation, opSig], account: this.c.arcMinter, chain: null,
    } as any);
    await this.c.arcPublic.waitForTransactionReceipt({ hash: mintTx });
    const after = (await this.c.arcPublic.readContract({ address: this.c.arcUsdc, abi: erc20, functionName: "balanceOf", args: [recipient] })) as bigint;
    return { mintTx, delivered: after - before };
  }

  private burnIntent(amount: bigint, recipient: `0x${string}`) {
    const spec = {
      version: 1,
      sourceDomain: this.c.sourceDomain,
      destinationDomain: this.c.destinationDomain,
      sourceContract: toB32(GATEWAY_WALLET),
      destinationContract: toB32(GATEWAY_MINTER),
      sourceToken: toB32(this.c.sourceUsdc),
      destinationToken: toB32(this.c.arcUsdc),
      sourceDepositor: toB32(this.c.depositorAddress),
      destinationRecipient: toB32(recipient),
      sourceSigner: toB32(this.c.delegate.address),
      destinationCaller: toB32(ZERO),
      value: amount,
      salt: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
      hookData: "0x" as `0x${string}`,
    };
    return { maxBlockHeight: maxUint256, maxFee: this.c.maxFee, spec };
  }

  private async signBurnIntent(amount: bigint, recipient: `0x${string}`): Promise<`0x${string}`> {
    this.lastIntent = this.burnIntent(amount, recipient);
    if (!this.c.delegate.signTypedData) throw new Error("delegate account cannot signTypedData");
    return this.c.delegate.signTypedData({
      domain: { name: "GatewayWallet", version: "1" },
      types: BURN_INTENT_TYPES,
      primaryType: "BurnIntent",
      message: this.lastIntent as any,
    });
  }
  private lastIntent: ReturnType<GatewayFunder["burnIntent"]> | undefined;

  /** POST the burn intent, retrying through the delegate's hard-finality window (V23). */
  private async requestAttestation(amount: bigint, recipient: `0x${string}`, signature: `0x${string}`): Promise<{ attestation: `0x${string}`; opSig: `0x${string}` }> {
    const body = JSON.stringify([{ burnIntent: this.lastIntent, signature }], (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(TRANSFER_API, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const text = await res.text();
      if (res.ok) {
        const j: any = JSON.parse(text);
        const attestation = j.attestation ?? j.transfers?.[0]?.attestation;
        const opSig = j.signature ?? j.transfers?.[0]?.signature;
        if (!attestation || !opSig) throw new Error(`no attestation in response: ${text.slice(0, 300)}`);
        return { attestation, opSig };
      }
      if (res.status === 400 && text.includes("authorized") && attempt <= 20) {
        this.c.log(`delegate not yet finalized on the source chain, retrying (${attempt})...`);
        await sleep(15_000);
        continue;
      }
      throw new Error(`transfer API ${res.status}: ${text}`);
    }
  }

  private async circleSend(contractAddress: string, signature: string, params: unknown[]): Promise<string> {
    const created = await this.c.circle.createContractExecutionTransaction({
      walletId: this.c.depositorWalletId, contractAddress, abiFunctionSignature: signature, abiParameters: params,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const id = created.data?.id;
    const deadline = Date.now() + 180_000;
    for (;;) {
      const tx = (await this.c.circle.getTransaction({ id })).data?.transaction;
      if (tx && TERMINAL_OK.has(tx.state)) return tx.txHash as string;
      if (tx && ["FAILED", "DENIED", "CANCELLED"].includes(tx.state)) {
        throw new Error(`${signature} ended ${tx.state}: ${[tx.errorReason, tx.errorDetails].filter(Boolean).join(" - ")}`);
      }
      if (Date.now() > deadline) throw new Error(`${signature} did not settle within 180s`);
      await sleep(2_500);
    }
  }
}
