/**
 * Oracle condition via Pyth, proven onchain end to end (permissionless oracle plan, Option 1).
 *
 *   npm run demo:oracle
 *
 * Uses the official PythAggregatorV3 wrapper over Arc's Pyth contract, so the existing PolicyVault
 * Oracle condition reads a live Pyth price with no vault change. Three paths, all onchain:
 *
 *   happy      USDC/USD >= 0.995 (pay while the peg holds): refresh, condition met, release, settle
 *   negative-1 USDC/USD <= 0.99  (the depeg trigger): fresh price, condition unmet, release reverts
 *   negative-2 stale: do not refresh past maxStaleSeconds, release reverts (fail closed)
 *
 * Owner-only calls (create, fund) go through the Circle treasury wallet. The permissionless calls
 * (update the Pyth feed, release) go through the deployer EOA, because the update is payable and the
 * Pyth update fee is 1 wei of native USDC. The fee-saving pre-check reads the free Hermes price and
 * only pays to refresh when the threshold actually crosses.
 */
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AppKit } from "@circle-fin/app-kit";
import { createRequire } from "node:module";
import { join } from "node:path";
import { EventWatcher } from "../src/chain/EventWatcher.js";
import { CursorStore } from "../src/store/CursorStore.js";
import { SettlementStore } from "../src/store/SettlementStore.js";
import { SettlementEngine } from "../src/SettlementEngine.js";
import { createLegRunner } from "../src/legs/createLegRunner.js";
import { toDecimalString } from "../src/legs/legs.js";
import { CircleWalletProvider } from "../src/wallet/CircleWalletProvider.js";
import { ARC_DOMAIN, chainFor } from "../src/config.js";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const PayoutCurrency = { USDC: 0, EURC: 1 } as const;
const Comparator = { Gte: 0, Lte: 1 } as const;
const AMOUNT = "100000"; // 0.10 USDC

const env = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set.`);
  return v;
};

const VAULT = env("POLICY_VAULT_ADDRESS") as `0x${string}`;
const RPC = env("ARC_TESTNET_RPC_URL");
const PYTH = env("ARC_PYTH_ADDRESS") as `0x${string}`;
const WRAPPER = env("ARC_PYTH_WRAPPER_USDC") as `0x${string}`;
const FEED_ID = env("PYTH_USDC_USD_FEED_ID");
const arc = chainFor(ARC_DOMAIN);
const chain = { id: arc.chainId, name: arc.name, nativeCurrency: arc.nativeCurrency, rpcUrls: { default: { http: [RPC] } } };

const publicClient = createPublicClient({ chain, transport: http(RPC, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 }) });
const eoa = privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY") as `0x${string}`);
const walletClient = createWalletClient({ account: eoa, chain, transport: http(RPC, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 }) });

const circle = initiateDeveloperControlledWalletsClient({ apiKey: env("CIRCLE_API_KEY"), entitySecret: env("CIRCLE_ENTITY_SECRET") });

const vaultAbi = parseAbi([
  "function nextPolicyId() view returns (uint256)",
  "function checkCondition(uint256) view returns (bool)",
  "function release(uint256)",
]);
const pythAbi = parseAbi(["function getUpdateFee(bytes[]) view returns (uint256)"]);
const wrapperAbi = parseAbi(["function updateFeeds(bytes[]) payable"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);
const TERMINAL_OK = new Set(["COMPLETE", "CONFIRMED"]);

// Circle contract execution for owner-only calls (create, fund).
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

type Hermes = { updateData: `0x${string}`[]; price: number };
async function fetchHermes(): Promise<Hermes> {
  const res = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${FEED_ID}&encoding=hex`);
  if (!res.ok) throw new Error(`Hermes ${res.status}`);
  const j: any = await res.json();
  const updateData = (j.binary.data as string[]).map((d) => `0x${d}` as `0x${string}`);
  const p = j.parsed[0].price;
  return { updateData, price: Number(p.price) * 10 ** p.expo };
}

// Refresh the onchain Pyth price through the wrapper. Payable: the fee is 1 wei of native USDC.
async function updateFeed(h: Hermes) {
  const fee = await publicClient.readContract({ address: PYTH, abi: pythAbi, functionName: "getUpdateFee", args: [h.updateData] });
  const hash = await walletClient.writeContract({ address: WRAPPER, abi: wrapperAbi, functionName: "updateFeeds", args: [h.updateData], value: fee });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash, fee };
}

async function createPolicy(treasuryWalletId: string, recipient: string, comparator: number, threshold: string, maxStaleSeconds: number) {
  const policyId = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "nextPolicyId" });
  const createTx = await send(
    treasuryWalletId, VAULT,
    "createOraclePolicy(address,uint256,uint8,uint32,address,uint8,int256,uint64)",
    [recipient, AMOUNT, PayoutCurrency.USDC, ARC_DOMAIN, WRAPPER, comparator, threshold, maxStaleSeconds.toString()],
  );
  return { policyId: policyId as bigint, createTx };
}

async function fund(treasuryWalletId: string, policyId: bigint) {
  await send(treasuryWalletId, env("ARC_USDC_ADDRESS"), "approve(address,uint256)", [VAULT, AMOUNT]);
  await send(treasuryWalletId, VAULT, "deposit(uint256,uint256)", [policyId.toString(), AMOUNT]);
}

// Send release with an explicit gas limit so viem skips estimation and the reverting tx actually
// mines, giving us an onchain revert (status "reverted") with a hash, not a pre-flight throw.
async function releaseExpectingRevert(policyId: bigint) {
  try {
    const hash = await walletClient.writeContract({ address: VAULT, abi: vaultAbi, functionName: "release", args: [policyId], gas: 300_000n });
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    return { hash, status: rcpt.status as string };
  } catch (e: any) {
    return { hash: null as string | null, status: "rejected", error: e.shortMessage ?? e.message };
  }
}

async function main() {
  const wallets = CircleWalletProvider.fromEnv();
  const treasury = await wallets.getWallet("treasury", ARC_DOMAIN);
  const recipient = env("RECIPIENT_WALLET_ADDRESS");

  console.log("=== Pyth oracle demo (USDC/USD depeg protection) ===");
  console.log(`vault    ${VAULT}`);
  console.log(`wrapper  ${WRAPPER}  (PythAggregatorV3 over Arc Pyth)`);
  console.log(`feed     USDC/USD ${FEED_ID.slice(0, 10)}...`);
  console.log(`caller   ${eoa.address}  (deployer EOA, updates and releases)`);
  console.log();

  const head = await publicClient.getBlockNumber();

  // ---- HAPPY: Gte 0.995, pay while USDC holds peg ----
  log("HAPPY: create oracle policy, release while USDC/USD >= 0.995");
  const happy = await createPolicy(treasury.walletId, recipient, Comparator.Gte, "99500000", 60);
  log(`created policy ${happy.policyId} in ${happy.createTx}`);
  await fund(treasury.walletId, happy.policyId);
  log(`funded ${toDecimalString(AMOUNT)} USDC`);

  const h = await fetchHermes();
  log(`Hermes USDC/USD = ${h.price.toFixed(6)} (pre-check: ${h.price >= 0.995 ? "crosses 0.995, refreshing" : "below 0.995, would skip"})`);
  if (h.price < 0.995) throw new Error("live USDC/USD is below 0.995 right now; the happy path cannot be shown honestly");
  const up = await updateFeed(h);
  log(`refreshed feed onchain, fee ${up.fee} wei, ${up.hash}`);

  const met = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "checkCondition", args: [happy.policyId] });
  if (!met) throw new Error(`happy policy ${happy.policyId} not releasable after a fresh update`);
  log(`checkCondition = true`);
  const releaseHash = await walletClient.writeContract({ address: VAULT, abi: vaultAbi, functionName: "release", args: [happy.policyId] });
  await publicClient.waitForTransactionReceipt({ hash: releaseHash });
  log(`released in ${releaseHash}`);

  // ---- NEGATIVE 1: Lte 0.99, depeg trigger, unmet against a healthy live price ----
  log("NEG-1: create policy, release only if USDC/USD <= 0.99 (depeg trigger)");
  const neg1 = await createPolicy(treasury.walletId, recipient, Comparator.Lte, "99000000", 60);
  // Not funded on purpose: release() checks the condition before the funding check, so an unmet
  // condition reverts with ConditionNotMet. That is exactly what this path proves, and it keeps
  // the demo from locking USDC in policies that will never release.
  const h2 = await fetchHermes();
  await updateFeed(h2); // fresh, so the only reason to fail is the threshold, not staleness
  const neg1Met = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "checkCondition", args: [neg1.policyId] });
  log(`NEG-1 checkCondition = ${neg1Met} (expected false; ${h2.price.toFixed(6)} is not <= 0.99)`);
  const neg1Rel = await releaseExpectingRevert(neg1.policyId);
  log(`NEG-1 release ${neg1Rel.status}${neg1Rel.hash ? " in " + neg1Rel.hash : ""}`);

  // ---- NEGATIVE 2: stale, fail closed ----
  log("NEG-2: create policy Gte 0.995 with maxStaleSeconds=1, then do not refresh");
  const neg2 = await createPolicy(treasury.walletId, recipient, Comparator.Gte, "99500000", 1);
  // Not funded, same reason as NEG-1: the staleness guard fails the condition before funding matters.
  log("waiting so the onchain price ages past maxStaleSeconds");
  await sleep(4_000);
  const neg2Met = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "checkCondition", args: [neg2.policyId] });
  log(`NEG-2 checkCondition = ${neg2Met} (expected false; price older than maxStaleSeconds)`);
  const neg2Rel = await releaseExpectingRevert(neg2.policyId);
  log(`NEG-2 release ${neg2Rel.status}${neg2Rel.hash ? " in " + neg2Rel.hash : ""}`);

  // ---- settle the happy release through the normal executor path ----
  const cursors = new CursorStore(join(process.cwd(), ".state", "oracle-cursor.json"));
  await cursors.set(head);
  const store = new SettlementStore(join(process.cwd(), ".state", "oracle-settlements.json"));
  const engine = new SettlementEngine({
    store, wallets,
    runLeg: createLegRunner(wallets, { kit: new AppKit(), kitKey: process.env.CIRCLE_KIT_KEY }),
    log,
  });
  const watcher = new EventWatcher({ client: publicClient, vaultAddress: VAULT, cursors, deployBlock: head, confirmations: 1n });

  log("settling the happy release by watching the chain");
  let record: any;
  const deadline = Date.now() + 10 * 60_000;
  while (!record && Date.now() < deadline) {
    await watcher.scanOnce(async (policy) => {
      const r = await engine.settle(policy);
      if (r && r.policyId?.toString() === happy.policyId.toString()) record = r;
    });
    if (!record) await sleep(3_000);
  }
  if (!record) throw new Error("happy policy did not settle before the deadline");

  console.log("\n=== result ===\n");
  console.log(`Happy oracle policy ${record.policyId}: ${toDecimalString(record.amount)} USDC on Arc, USDC/USD held the peg`);
  for (const leg of record.legs) console.log(`  ${leg.kind.padEnd(7)} ${leg.status}  ${leg.txHash ?? ""}`);
  console.log(`  duration ${((record.durationMs ?? 0) / 1000).toFixed(1)}s`);
  console.log(`\nNegatives: NEG-1 ${neg1Rel.status} (${neg1Rel.hash ?? "no hash"}), NEG-2 ${neg2Rel.status} (${neg2Rel.hash ?? "no hash"})`);

  console.log("\n--- markdown for RESULTS.md ---\n");
  console.log(`| create | ${happy.createTx} | oracle policy ${happy.policyId}, Gte 0.995 |`);
  console.log(`| update | ${up.hash} | Pyth USDC/USD ${h.price.toFixed(5)}, fee ${up.fee} wei |`);
  console.log(`| release | ${releaseHash} | condition met |`);
  for (const leg of record.legs) console.log(`| ${leg.kind} | ${leg.txHash ?? "-"} | ${leg.status} |`);
  console.log(`| neg-1 revert | ${neg1Rel.hash ?? "-"} | Lte 0.99 unmet, release ${neg1Rel.status} |`);
  console.log(`| neg-2 revert | ${neg2Rel.hash ?? "-"} | stale price, release ${neg2Rel.status} |`);
}

main().catch((err) => {
  console.error("\nPYTH ORACLE DEMO FAILED:", err?.message ?? err);
  process.exit(1);
});
