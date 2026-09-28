/**
 * Pay a release the keeper never settled.
 *
 *   npm run settle-release -- <releaseTx>          what would be paid, and nothing more
 *   npm run settle-release -- <releaseTx> --send   pay it
 *
 * For the case the reconciler alerts on: a release whose funds reached the executor wallet and were
 * never paid on, because no keeper was running when it happened.
 *
 * Every guard here is against paying twice, since that is the mistake a hand-run payment makes:
 *
 * - The release must be in the ledger. The ledger is where a person records "this was already paid
 *   another way", so a release it has never seen cannot be checked, and is refused.
 * - A resolved release is refused. That is the record of a payment made outside the settlement
 *   store, a demo script or a receipt lost with its disk.
 * - A release with any settlement row is refused. Settled is done; in progress or failed has its own
 *   recovery (resume, or reopen after a person checks the chain), and paying it fresh would repeat
 *   whatever leg already went through.
 * - The payment itself goes through the same Postgres claim the keeper uses. Two people running this
 *   at once, or this racing a keeper, pays once.
 *
 * The release is decoded from its own transaction receipt, by the same function the keeper uses,
 * so recipient, amount, and route are the chain's and not something typed on a command line.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { AppKit } from "@circle-fin/app-kit";
import { decodeReleaseLog, POLICY_RELEASED_TOPIC } from "../src/chain/EventWatcher.js";
import { PostgresSettlementStore } from "../src/store/PostgresSettlementStore.js";
import { ReleaseLedger } from "../src/store/ReleaseLedger.js";
import { SettlementEngine } from "../src/SettlementEngine.js";
import { createLegRunner } from "../src/legs/createLegRunner.js";
import { CircleWalletProvider } from "../src/wallet/CircleWalletProvider.js";
import { chainFor, planLegs, ARC_DOMAIN } from "../src/config.js";
import { VAULT_ENV_VAR, VAULT_LABELS, VAULTS, labelForAddress } from "../src/api/vaults.js";
import { toDecimalString } from "../src/legs/legs.js";

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set; see .env.example`);
  return v;
};

const args = process.argv.slice(2);
const tx = args.find((a) => /^0x[0-9a-fA-F]{64}$/.test(a))?.toLowerCase();
const send = args.includes("--send");
if (!tx) {
  console.error("Usage: npm run settle-release -- <releaseTx> [--send]");
  process.exit(2);
}

const arc = chainFor(ARC_DOMAIN);
// Needs an RPC that still serves old receipts. drpc does; Arc's public RPC answers "not found"
// for older transactions, which would read as a release that never happened.
const url = env("ARC_TESTNET_RPC_URL");
const client = createPublicClient({
  chain: { id: arc.chainId, name: arc.name, nativeCurrency: arc.nativeCurrency, rpcUrls: { default: { http: [url] } } },
  transport: http(url, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 }),
}) as PublicClient;

// Only vaults whose releases the executor pays. A self-custody vault (v5) has already paid the
// recipient when it released, so settling one of its releases here would pay them twice.
const known = new Set(
  VAULT_LABELS.filter((l) => !VAULTS[l].selfCustody).map((l) => process.env[VAULT_ENV_VAR[l]]?.toLowerCase()).filter(Boolean),
);
const ledger = new ReleaseLedger({ connectionString: env("DATABASE_URL") });
const store = new PostgresSettlementStore({ connectionString: env("DATABASE_URL") });

function refuse(reason: string): never {
  console.error(`Refusing: ${reason}`);
  process.exitCode = 1;
  throw new Error("refused");
}

try {
  const receipt = await client.getTransactionReceipt({ hash: tx as `0x${string}` });
  if (receipt.status !== "success") refuse("that transaction reverted, so it released nothing.");

  const releases = receipt.logs
    .filter((l) => l.topics[0] === POLICY_RELEASED_TOPIC && known.has(l.address.toLowerCase()))
    .map((l) => decodeReleaseLog(l));
  if (releases.length !== 1) refuse(`expected exactly one PolicyReleased from a known vault in that transaction, found ${releases.length}.`);
  const policy = releases[0]!;

  const where = `policy ${policy.policyId}${policy.periodIndex ? ` period ${policy.periodIndex}` : ""} on ${labelForAddress(policy.vault)}`;
  const legs = planLegs(policy.payoutCurrency, policy.destinationDomain);

  const [entry] = (await ledger.byTx(tx)).filter((r) => r.policyId === policy.policyId && r.vault === policy.vault);
  if (!entry) refuse(`${where} is not in the ledger yet. Run \`npm run reconcile -- backfill\` first, so any record of it being paid another way can be checked.`);
  if (entry.resolution) refuse(`${where} was already accounted for: ${entry.resolution}`);
  if (entry.settlementStatus === "settled") refuse(`${where} is already settled.`);
  if (entry.settlementStatus) refuse(`${where} has a settlement ${entry.settlementStatus}. That needs resuming or reopening after checking the chain, not a fresh payment.`);

  const wallets = CircleWalletProvider.fromEnv();
  const executor = await wallets.getWallet("executor", ARC_DOMAIN);
  const balance = await wallets.getBalance(executor, "USDC");

  console.log(`${where}`);
  console.log(`  pay        ${toDecimalString(policy.amount)} USDC to ${policy.recipient}, as ${policy.payoutCurrency} on ${chainFor(policy.destinationDomain).name}`);
  console.log(`  legs       ${legs.join(" -> ")}`);
  console.log(`  from       executor ${executor.address}, holding ${toDecimalString(balance)} USDC`);
  console.log(`  release    ${arc.explorerTxUrl(tx)}`);
  if (BigInt(balance) < BigInt(policy.amount)) refuse("the executor wallet holds less than the amount owed.");

  if (!send) {
    console.log("\nDry run. Nothing was paid. Add --send to pay it.");
  } else {
    const engine = new SettlementEngine({
      store,
      wallets,
      runLeg: createLegRunner(wallets, {
        kit: new AppKit(),
        ...(process.env.CIRCLE_KIT_KEY ? { kitKey: process.env.CIRCLE_KIT_KEY } : {}),
      }),
      log: (m) => console.log(`  ${m}`),
    });
    const record = await engine.settle(policy);
    if (!record) refuse("something else claimed this release first. Nothing was paid by this run.");
    console.log(`\n${record.status === "settled" ? "Paid" : `Stopped: ${record.status}`}.`);
    for (const leg of record.legs) console.log(`  ${leg.kind.padEnd(7)} ${leg.status}  ${leg.explorerUrl ?? leg.error ?? ""}`);
  }
} catch (err) {
  if (!(err instanceof Error && err.message === "refused")) throw err;
} finally {
  await ledger.end();
  await store.end();
}
