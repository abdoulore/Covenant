/**
 * Fund an Arc policy from USDC that starts on Base Sepolia, end to end, via Circle Gateway.
 *
 *   npm run demo:gateway
 *
 * The story: the treasury's USDC lives on Base Sepolia. Gateway mints it onto Arc (no manual bridge),
 * the treasury funds a policy with it, and the policy settles to the recipient. Gateway is upstream
 * of the vault; the vault and its lock are unchanged (Integration 1, D11, V23).
 *
 * Uses the dedicated delegate key (DELEGATE_PRIVATE_KEY), never the deployer. If the delegate was
 * only just authorized, GatewayFunder retries through its Base Sepolia hard-finality window.
 */
import { createPublicClient, http, parseAbi } from "viem";
import { AppKit } from "@circle-fin/app-kit";
import { createRequire } from "node:module";
import { join } from "node:path";
import { GatewayFunder } from "../src/gateway/GatewayFunder.js";
import { EventWatcher } from "../src/chain/EventWatcher.js";
import { CursorStore } from "../src/store/CursorStore.js";
import { SettlementStore } from "../src/store/SettlementStore.js";
import { SettlementEngine } from "../src/SettlementEngine.js";
import { createLegRunner } from "../src/legs/createLegRunner.js";
import { toDecimalString } from "../src/legs/legs.js";
import { CircleWalletProvider } from "../src/wallet/CircleWalletProvider.js";
import { ARC_DOMAIN, chainFor } from "../src/config.js";
import { currentVaultAddress } from "../src/api/vaults.js";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const env = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set.`);
  return v;
};

const VAULT = currentVaultAddress();
const RPC = env("ARC_TESTNET_RPC_URL");
const TREASURY_ARC = env("TREASURY_WALLET_ADDRESS") as `0x${string}`;
const AMOUNT = 30_000n; // 0.03 USDC, sourced from Base Sepolia (sized to the current unified balance)

const ConditionType = { Timelock: 0, Approval: 1 } as const;
const PayoutCurrency = { USDC: 0 } as const;

const arc = chainFor(ARC_DOMAIN);
const chain = { id: arc.chainId, name: arc.name, nativeCurrency: arc.nativeCurrency, rpcUrls: { default: { http: [RPC] } } };
const publicClient = createPublicClient({ chain, transport: http(RPC, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 }) });
const circle = initiateDeveloperControlledWalletsClient({ apiKey: env("CIRCLE_API_KEY"), entitySecret: env("CIRCLE_ENTITY_SECRET") });
const vaultAbi = parseAbi(["function nextPolicyId() view returns (uint256)"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);
const TERMINAL_OK = new Set(["COMPLETE", "CONFIRMED"]);

async function send(walletId: string, contractAddress: string, signature: string, params: unknown[]) {
  const created = await circle.createContractExecutionTransaction({
    walletId, contractAddress, abiFunctionSignature: signature, abiParameters: params,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const id = created.data?.id;
  const deadline = Date.now() + 180_000;
  for (;;) {
    const tx = (await circle.getTransaction({ id })).data?.transaction;
    if (tx && TERMINAL_OK.has(tx.state)) return tx.txHash as string;
    if (tx && ["FAILED", "DENIED", "CANCELLED"].includes(tx.state)) {
      throw new Error(`${signature} ended ${tx.state}: ${[tx.errorReason, tx.errorDetails].filter(Boolean).join(" - ")}`);
    }
    if (Date.now() > deadline) throw new Error(`${signature} did not settle within 180s`);
    await sleep(2_000);
  }
}

async function main() {
  const wallets = CircleWalletProvider.fromEnv();
  const treasury = await wallets.getWallet("treasury", ARC_DOMAIN);
  const recipient = env("RECIPIENT_WALLET_ADDRESS");
  const amountStr = AMOUNT.toString();

  console.log("=== Fund an Arc policy from USDC on Base Sepolia (Circle Gateway) ===");
  console.log(`vault v3   ${VAULT}`);
  console.log(`recipient  ${recipient}\n`);

  const head = await publicClient.getBlockNumber();

  // 1. Bring USDC from Base Sepolia to the treasury's Arc wallet via Gateway.
  log("GATEWAY: minting 0.03 USDC onto Arc from the unified balance (source: Base Sepolia)");
  const funder = GatewayFunder.fromEnv();
  const { mintTx, delivered, depositTx } = await funder.fundArcAddress(AMOUNT, TREASURY_ARC);
  log(`gateway mint on Arc ${mintTx}, delivered ${delivered} base units${depositTx ? `, topped up via ${depositTx}` : ""}`);

  // 2. Create and fund a policy with that USDC. The vault pulls it via the normal deposit().
  // Names the vault it actually resolved rather than a version baked into the string: this line
  // said "v3" for one run after the target moved to v4, which is a log that lies quietly.
  log(`creating an approval policy on ${VAULT} and funding it with the Gateway-sourced USDC`);
  const policyId = (await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "nextPolicyId" })) as bigint;
  const createTx = await send(
    treasury.walletId, VAULT,
    "createPolicy(address,uint256,uint8,uint32,uint8,uint64,address[],uint8)",
    [recipient, amountStr, PayoutCurrency.USDC, ARC_DOMAIN, ConditionType.Approval, "0", [TREASURY_ARC], "1"],
  );
  log(`created policy ${policyId} in ${createTx}`);
  await send(treasury.walletId, env("ARC_USDC_ADDRESS"), "approve(address,uint256)", [VAULT, amountStr]);
  await send(treasury.walletId, VAULT, "deposit(uint256,uint256)", [policyId.toString(), amountStr]);
  log(`funded policy ${policyId} with ${toDecimalString(amountStr)} USDC that started on Base Sepolia`);

  // 3. Satisfy the condition and let the executor settle to the recipient.
  await send(treasury.walletId, VAULT, "approve(uint256)", [policyId.toString()]);
  const releaseTx = await send(treasury.walletId, VAULT, "release(uint256)", [policyId.toString()]);
  log(`approved and released in ${releaseTx}`);

  const cursors = new CursorStore(join(process.cwd(), ".state", "gateway-cursor.json"));
  await cursors.set(head);
  const store = new SettlementStore(join(process.cwd(), ".state", "gateway-settlements.json"));
  const engine = new SettlementEngine({ store, wallets, runLeg: createLegRunner(wallets, { kit: new AppKit(), kitKey: process.env.CIRCLE_KIT_KEY }), log });
  const watcher = new EventWatcher({ client: publicClient, vaultAddress: VAULT, cursors, deployBlock: head, confirmations: 1n });

  log("settling to the recipient by watching the chain");
  let record: any;
  const deadline = Date.now() + 8 * 60_000;
  while (!record && Date.now() < deadline) {
    await watcher.scanOnce(async (policy) => {
      const r = await engine.settle(policy);
      if (r && r.policyId?.toString() === policyId.toString()) record = r;
    });
    if (!record) await sleep(3_000);
  }
  if (!record) throw new Error("policy did not settle before the deadline");

  console.log("\n=== result ===\n");
  console.log(`0.03 USDC sourced on Base Sepolia funded Arc policy ${policyId} and reached the recipient.`);
  for (const leg of record.legs) console.log(`  ${leg.kind.padEnd(7)} ${leg.status}  ${leg.txHash ?? ""}`);

  console.log("\n--- markdown for RESULTS.md ---\n");
  console.log(`| gateway mint on Arc | ${mintTx} | 0.03 USDC minted on Arc from USDC deposited on Base Sepolia |`);
  console.log(`| create + fund | ${createTx} | policy ${policyId} funded from the Gateway-sourced USDC |`);
  console.log(`| release | ${releaseTx} | condition met |`);
  for (const leg of record.legs) console.log(`| ${leg.kind} | ${leg.txHash ?? "-"} | ${leg.status} |`);
}

main().catch((err) => {
  console.error("\nGATEWAY FUNDING DEMO FAILED:", err?.message ?? err);
  process.exit(1);
});

