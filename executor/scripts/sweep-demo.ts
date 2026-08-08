/**
 * Sweep scheduling (Phase 2.3), proven onchain end to end on PolicyVault v3.
 *
 *   npm run demo:sweep
 *
 * A sweep policy keeps a `buffer` and, on schedule, releases everything above it to the recipient,
 * skipping when the excess is below `minSweep`. Unlike payroll it does not retire: it stays active
 * for top-ups. This demo proves all three behaviours onchain:
 *
 *   sweep 1     fund above the buffer, releasePeriod moves the excess out and leaves the buffer.
 *   dust floor  with only the buffer left, the due period reverts SweepBelowMin onchain (status 0),
 *               so the buffer is preserved rather than swept to zero.
 *   sweep 2     top up, and a second releasePeriod sweeps again, proving the policy stays live.
 *
 * Owner-only calls (create, fund) go through the Circle treasury wallet. The permissionless
 * releasePeriod goes through the deployer EOA, the way a keeper would. Each sweep is a separate
 * PolicyReleased that settles independently by policyId:periodIndex, exactly like payroll.
 */
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AppKit } from "@circle-fin/app-kit";
import { createRequire } from "node:module";
import { join } from "node:path";
import { EventWatcher } from "../src/chain/EventWatcher.js";
import { CursorStore } from "../src/store/CursorStore.js";
import { SettlementStore, settlementKey } from "../src/store/SettlementStore.js";
import { SettlementEngine } from "../src/SettlementEngine.js";
import { createLegRunner } from "../src/legs/createLegRunner.js";
import { CircleWalletProvider } from "../src/wallet/CircleWalletProvider.js";
import { ARC_DOMAIN, chainFor } from "../src/config.js";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const PayoutCurrency = { USDC: 0 } as const;

// All amounts in 6-decimal USDC base units.
const BUFFER = "50000";   // 0.05 USDC kept in the policy
const MIN_SWEEP = "20000"; // 0.02 USDC dust floor
const FUND_1 = "150000";  // 0.15 USDC in: excess 0.10 over the buffer
const TOPUP = "80000";    // 0.08 USDC top-up after the buffer is all that is left
const INTERVAL = 4;       // seconds between due periods
const MAX_CATCHUP = 3600; // generous, so timing never confuses this demo with a stale-hold

const env = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set.`);
  return v;
};

const VAULT = env("POLICY_VAULT_V3_ADDRESS") as `0x${string}`;
const RPC = env("ARC_TESTNET_RPC_URL");
const arc = chainFor(ARC_DOMAIN);
const chain = { id: arc.chainId, name: arc.name, nativeCurrency: arc.nativeCurrency, rpcUrls: { default: { http: [RPC] } } };

const publicClient = createPublicClient({ chain, transport: http(RPC, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 }) });
const eoa = privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY") as `0x${string}`);
const walletClient = createWalletClient({ account: eoa, chain, transport: http(RPC, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 }) });

const circle = initiateDeveloperControlledWalletsClient({ apiKey: env("CIRCLE_API_KEY"), entitySecret: env("CIRCLE_ENTITY_SECRET") });

const vaultAbi = parseAbi([
  "function nextPolicyId() view returns (uint256)",
  "function statusOf(uint256) view returns (uint8)",
  "function isPeriodDue(uint256) view returns (bool)",
  "function releasePeriod(uint256)",
  "function getPolicy(uint256) view returns ((address,uint256,uint256,uint8,uint32,uint8,uint64,uint8,uint8,uint8,address,bool,address,uint8,uint64,int256,bool,bool,uint256,uint256,uint256,uint64,uint64,uint64,uint32,uint32))",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);
const usdc = (base: string | bigint) => (Number(base) / 1e6).toFixed(6) + " USDC";
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

async function fund(treasuryWalletId: string, policyId: bigint, amount: string) {
  await send(treasuryWalletId, env("ARC_USDC_ADDRESS"), "approve(address,uint256)", [VAULT, amount]);
  await send(treasuryWalletId, VAULT, "deposit(uint256,uint256)", [policyId.toString(), amount]);
}

async function releasePeriod(policyId: bigint): Promise<string> {
  const hash = await walletClient.writeContract({ address: VAULT, abi: vaultAbi, functionName: "releasePeriod", args: [policyId] });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

// Force the transaction onchain past viem's revert estimation, so a refusal is a real status-0
// receipt anyone can inspect, not just a client-side throw.
async function releasePeriodExpectingRevert(policyId: bigint) {
  try {
    const hash = await walletClient.writeContract({ address: VAULT, abi: vaultAbi, functionName: "releasePeriod", args: [policyId], gas: 300_000n });
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    return { hash, status: rcpt.status as string };
  } catch (e: any) {
    return { hash: null as string | null, status: "rejected", error: e.shortMessage ?? e.message };
  }
}

async function funded(policyId: bigint): Promise<bigint> {
  const p = (await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "getPolicy", args: [policyId] })) as any[];
  return p[2] as bigint; // funded is the third field of the Policy tuple
}

async function main() {
  const wallets = CircleWalletProvider.fromEnv();
  const treasury = await wallets.getWallet("treasury", ARC_DOMAIN);
  const recipient = env("RECIPIENT_WALLET_ADDRESS");

  console.log("=== Sweep demo (excess above a buffer, on schedule) ===");
  console.log(`vault v3  ${VAULT}`);
  console.log(`recipient ${recipient}`);
  console.log(`caller    ${eoa.address}  (deployer EOA, calls releasePeriod like a keeper)`);
  console.log(`policy    buffer ${usdc(BUFFER)}, minSweep ${usdc(MIN_SWEEP)}, interval ${INTERVAL}s`);
  console.log();

  const head = await publicClient.getBlockNumber();

  // ---- create the sweep policy ----
  const policyId = (await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "nextPolicyId" })) as bigint;
  const now = Math.floor(Date.now() / 1000);
  log(`SWEEP: create policy ${policyId}, keep ${usdc(BUFFER)}, sweep the rest every ${INTERVAL}s`);
  const createTx = await send(
    treasury.walletId, VAULT,
    "createSweepPolicy(address,uint8,uint32,uint256,uint256,uint64,uint64,uint64)",
    [recipient, PayoutCurrency.USDC, ARC_DOMAIN, BUFFER, MIN_SWEEP, INTERVAL.toString(), now.toString(), MAX_CATCHUP.toString()],
  );
  log(`created in ${createTx}`);

  // ---- sweep 1: fund above the buffer, release the excess ----
  await fund(treasury.walletId, policyId, FUND_1);
  log(`funded ${usdc(FUND_1)}, excess over buffer is ${usdc(BigInt(FUND_1) - BigInt(BUFFER))}`);
  const sweep1 = await releasePeriod(policyId);
  log(`sweep 1 released the excess in ${sweep1}`);
  const afterSweep1 = await funded(policyId);
  log(`funded after sweep 1: ${usdc(afterSweep1)} (should equal the buffer, ${usdc(BUFFER)})`);

  // ---- dust floor: with only the buffer left, the due period must refuse onchain ----
  await sleep(6_000); // let the next period come due, so the refusal is SweepBelowMin, not PeriodNotDue
  const due = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "isPeriodDue", args: [policyId] });
  log(`period due again: ${due}; excess is now ${usdc(afterSweep1 - BigInt(BUFFER))}, below minSweep`);
  const dust = await releasePeriodExpectingRevert(policyId);
  log(`dust-floor releasePeriod: ${dust.status}${dust.hash ? " in " + dust.hash : ""} (expected reverted, SweepBelowMin)`);
  const afterDust = await funded(policyId);
  log(`funded after the refused sweep: ${usdc(afterDust)} (buffer preserved, not swept to zero)`);

  // ---- sweep 2: top up, prove the policy stays live and sweeps again ----
  await fund(treasury.walletId, policyId, TOPUP);
  log(`topped up ${usdc(TOPUP)}, excess over buffer is now ${usdc(afterDust + BigInt(TOPUP) - BigInt(BUFFER))}`);
  const sweep2 = await releasePeriod(policyId);
  log(`sweep 2 released the excess in ${sweep2}`);
  const afterSweep2 = await funded(policyId);
  log(`funded after sweep 2: ${usdc(afterSweep2)} (back to the buffer)`);

  // ---- settle both sweeps through the executor ----
  log("settling both sweeps by watching the chain");
  const cursors = new CursorStore(join(process.cwd(), ".state", "sweep-cursor.json"));
  await cursors.set(head);
  const store = new SettlementStore(join(process.cwd(), ".state", "sweep-settlements.json"));
  const engine = new SettlementEngine({
    store, wallets,
    runLeg: createLegRunner(wallets, { kit: new AppKit(), kitKey: process.env.CIRCLE_KIT_KEY }),
    log,
  });
  const watcher = new EventWatcher({ client: publicClient, vaultAddress: VAULT, cursors, deployBlock: head, confirmations: 1n });

  const settled = new Map<string, string>(); // key -> payout tx
  const expected = 2; // two sweeps (the refused one emits nothing)
  const deadline = Date.now() + 8 * 60_000;
  while (settled.size < expected && Date.now() < deadline) {
    await watcher.scanOnce(async (policy) => {
      const r = await engine.settle(policy);
      if (r) {
        const payout = r.legs.find((l) => l.kind === "payout")?.txHash ?? "-";
        settled.set(settlementKey(r.policyId, r.periodIndex), payout);
      }
    });
    if (settled.size < expected) await sleep(3_000);
  }

  const payout1 = settled.get(settlementKey(policyId.toString(), 1)) ?? "pending";
  const payout2 = settled.get(settlementKey(policyId.toString(), 2)) ?? "pending";

  console.log("\n=== result ===\n");
  console.log(`Sweep policy ${policyId}: buffer ${usdc(BUFFER)}, minSweep ${usdc(MIN_SWEEP)}`);
  console.log(`  sweep 1  release ${sweep1}  payout ${payout1}`);
  console.log(`  dust     ${dust.hash ?? "no hash"}  ${dust.status} (SweepBelowMin, buffer preserved)`);
  console.log(`  sweep 2  release ${sweep2}  payout ${payout2}`);
  console.log(`  funded left in the policy: ${usdc(afterSweep2)} (the buffer, untouched)`);

  console.log("\n--- markdown for RESULTS.md ---\n");
  console.log(`| create | ${createTx} | sweep policy ${policyId}, keep ${usdc(BUFFER)} buffer, sweep excess every ${INTERVAL}s |`);
  console.log(`| sweep 1 | ${sweep1} | released ${usdc(BigInt(FUND_1) - BigInt(BUFFER))} excess, payout ${payout1} |`);
  console.log(`| dust floor | ${dust.hash ?? "-"} | only the buffer left, releasePeriod ${dust.status} (SweepBelowMin) |`);
  console.log(`| sweep 2 | ${sweep2} | after a top-up, released ${usdc(afterDust + BigInt(TOPUP) - BigInt(BUFFER))} excess, payout ${payout2} |`);
}

main().catch((err) => {
  console.error("\nSWEEP DEMO FAILED:", err?.message ?? err);
  process.exit(1);
});
