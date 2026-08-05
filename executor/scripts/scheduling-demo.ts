/**
 * Scheduling (Phase 2.3), proven onchain end to end on PolicyVault v3.
 *
 *   npm run demo:scheduling
 *
 * Two paths:
 *   payroll     a recurring policy releases a fixed slice each interval, three periods, each one a
 *               separate PolicyReleased that settles independently by policyId:periodIndex.
 *   stale-hold  a period overdue beyond maxCatchUp reverts CatchUpStale for the keeper, and the
 *               owner clears it deliberately with approveStalePeriod.
 *
 * Owner-only calls (create, fund, approveStalePeriod) go through the Circle treasury wallet. The
 * permissionless releasePeriod goes through the deployer EOA, the way a keeper would.
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
import { toDecimalString } from "../src/legs/legs.js";
import { CircleWalletProvider } from "../src/wallet/CircleWalletProvider.js";
import { ARC_DOMAIN, chainFor } from "../src/config.js";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const PayoutCurrency = { USDC: 0 } as const;
const PER_PERIOD = "10000"; // 0.01 USDC per period

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
  "function releasePeriod(uint256)",
]);

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

async function createRecurring(
  treasuryWalletId: string, recipient: string,
  interval: number, periods: number, maxCatchUp: number,
) {
  const policyId = (await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "nextPolicyId" })) as bigint;
  const now = Math.floor(Date.now() / 1000);
  const createTx = await send(
    treasuryWalletId, VAULT,
    "createRecurringPolicy(address,uint8,uint32,uint256,uint64,uint64,uint32,uint64)",
    [recipient, PayoutCurrency.USDC, ARC_DOMAIN, PER_PERIOD, interval.toString(), now.toString(), periods.toString(), maxCatchUp.toString()],
  );
  return { policyId, createTx };
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

async function releasePeriodExpectingRevert(policyId: bigint) {
  try {
    const hash = await walletClient.writeContract({ address: VAULT, abi: vaultAbi, functionName: "releasePeriod", args: [policyId], gas: 300_000n });
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    return { hash, status: rcpt.status as string };
  } catch (e: any) {
    return { hash: null as string | null, status: "rejected", error: e.shortMessage ?? e.message };
  }
}

async function statusOf(policyId: bigint): Promise<number> {
  return Number(await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "statusOf", args: [policyId] }));
}

async function main() {
  const wallets = CircleWalletProvider.fromEnv();
  const treasury = await wallets.getWallet("treasury", ARC_DOMAIN);
  const recipient = env("RECIPIENT_WALLET_ADDRESS");

  console.log("=== Scheduling demo (recurring payroll + stale-hold) ===");
  console.log(`vault v3  ${VAULT}`);
  console.log(`recipient ${recipient}`);
  console.log(`caller    ${eoa.address}  (deployer EOA, calls releasePeriod like a keeper)`);
  console.log();

  const head = await publicClient.getBlockNumber();

  // ---- PAYROLL: 3 periods of 0.01 USDC, interval 4s ----
  log("PAYROLL: create a 3-period recurring policy, 0.01 USDC every 4s");
  const pay = await createRecurring(treasury.walletId, recipient, 4, 3, 3600);
  log(`created policy ${pay.policyId} in ${pay.createTx}`);
  await fund(treasury.walletId, pay.policyId, "30000"); // 3 * 0.01
  log(`funded 0.03 USDC`);

  const periodHashes: string[] = [];
  for (let i = 1; i <= 3; i++) {
    if (i > 1) await sleep(5_000); // let the interval elapse so the next period is due
    const tx = await releasePeriod(pay.policyId);
    periodHashes.push(tx);
    log(`released period ${i} in ${tx}`);
  }
  const payStatus = await statusOf(pay.policyId);
  log(`payroll status after 3 periods: ${payStatus} (2 = Executed, retired)`);

  // ---- STALE-HOLD: overdue beyond maxCatchUp is held for the owner ----
  // maxCatchUp must exceed the create+fund latency, or period 1 itself reads as overdue. 25s clears
  // it; then a 30s wait pushes period 2 past the bound so it is held for the owner.
  log("STALE-HOLD: create a policy with maxCatchUp 25s, interval 2s");
  const stale = await createRecurring(treasury.walletId, recipient, 2, 5, 25);
  log(`created policy ${stale.policyId} in ${stale.createTx}`);
  await fund(treasury.walletId, stale.policyId, "20000"); // 2 periods' worth
  const staleP1 = await releasePeriod(stale.policyId);
  log(`released period 1 in ${staleP1}`);

  log(`waiting 30s so period 2 is overdue beyond maxCatchUp`);
  await sleep(30_000);
  const staleAttempt = await releasePeriodExpectingRevert(stale.policyId);
  log(`keeper releasePeriod on the overdue period: ${staleAttempt.status}${staleAttempt.hash ? " in " + staleAttempt.hash : ""} (expected reverted, CatchUpStale)`);

  const staleApprove = await send(treasury.walletId, VAULT, "approveStalePeriod(uint256)", [stale.policyId.toString()]);
  log(`owner approveStalePeriod released the held period in ${staleApprove}`);

  // ---- settle every release through the executor ----
  log("settling all released periods by watching the chain");
  const cursors = new CursorStore(join(process.cwd(), ".state", "scheduling-cursor.json"));
  await cursors.set(head);
  const store = new SettlementStore(join(process.cwd(), ".state", "scheduling-settlements.json"));
  const engine = new SettlementEngine({
    store, wallets,
    runLeg: createLegRunner(wallets, { kit: new AppKit(), kitKey: process.env.CIRCLE_KIT_KEY }),
    log,
  });
  const watcher = new EventWatcher({ client: publicClient, vaultAddress: VAULT, cursors, deployBlock: head, confirmations: 1n });

  const settled = new Map<string, string>(); // key -> payout tx
  const expected = 5; // payroll 3 + stale period 1 + stale approved period
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

  console.log("\n=== result ===\n");
  console.log(`Payroll policy ${pay.policyId}: 3 periods, each settled independently by policyId:periodIndex`);
  for (let i = 1; i <= 3; i++) {
    console.log(`  period ${i}  release ${periodHashes[i - 1]}  payout ${settled.get(settlementKey(pay.policyId.toString(), i)) ?? "pending"}`);
  }
  console.log(`  status ${payStatus === 2 ? "Executed (retired after the last period)" : payStatus}`);
  console.log(`\nStale-hold policy ${stale.policyId}:`);
  console.log(`  overdue keeper attempt: ${staleAttempt.status} (${staleAttempt.hash ?? "no hash"})`);
  console.log(`  owner approveStalePeriod: ${staleApprove}`);

  console.log("\n--- markdown for RESULTS.md ---\n");
  console.log(`| create | ${pay.createTx} | recurring policy ${pay.policyId}, 3 x 0.01 USDC every 4s |`);
  for (let i = 1; i <= 3; i++) {
    console.log(`| period ${i} | ${periodHashes[i - 1]} | payout ${settled.get(settlementKey(pay.policyId.toString(), i)) ?? "-"} |`);
  }
  console.log(`| stale revert | ${staleAttempt.hash ?? "-"} | overdue period, releasePeriod ${staleAttempt.status} (CatchUpStale) |`);
  console.log(`| owner approve | ${staleApprove} | approveStalePeriod released the held period |`);
}

main().catch((err) => {
  console.error("\nSCHEDULING DEMO FAILED:", err?.message ?? err);
  process.exit(1);
});
