/**
 * What the vault released that nobody paid, and the tools for a person to deal with it.
 *
 *   npm run reconcile                                   every release needing attention
 *   npm run reconcile -- backfill                       record the vault's releases into the ledger now
 *   npm run reconcile -- show <releaseTx>               one release, and what the ledger knows about it
 *   npm run reconcile -- resolve <releaseTx> --note ".."  mark a release as accounted for another way
 *   npm run reconcile -- import-archive [--write]       mark releases the demo scripts settled
 *   npm run reconcile -- alert                          one reconciliation pass, sending alerts
 *
 * The keeper runs the same reconciliation every few minutes and sends alerts. This is the manual
 * view of it, and the place to record decisions a person made.
 *
 * `resolve` is for a release that was paid but whose receipt is not in the settlement store, such
 * as one paid by a demo script, or one whose receipt was lost with the disk it lived on. It changes
 * no money. It exists so a paid release stops being reported, and, just as importantly, so the
 * settle-release command refuses to pay it a second time.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ReleaseLedger } from "../src/store/ReleaseLedger.js";
import { EventWatcher } from "../src/chain/EventWatcher.js";
import { CursorStore } from "../src/store/CursorStore.js";
import { chainFor, ARC_DOMAIN } from "../src/config.js";
import { currentVaultAddress, labelForAddress } from "../src/api/vaults.js";
import { formatAge, Reconciler } from "../src/keeper/Reconciler.js";
import { notifierFromEnv } from "../src/alerts/Notifier.js";

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set; see .env.example`);
  return v;
};

const arc = chainFor(ARC_DOMAIN);
const client = (url: string) =>
  createPublicClient({
    chain: { id: arc.chainId, name: arc.name, nativeCurrency: arc.nativeCurrency, rpcUrls: { default: { http: [url] } } },
    transport: http(url, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 }),
  }) as PublicClient;

const stateDir = process.env.COVENANT_STATE_DIR ?? join(process.cwd(), ".state");
const usdc = (base: string) => (Number(base) / 1e6).toFixed(6);
const ledger = new ReleaseLedger({ connectionString: env("DATABASE_URL") });

const [cmd = "report", ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
};
const txArg = () => {
  const tx = rest.find((a) => /^0x[0-9a-fA-F]{64}$/.test(a));
  if (!tx) throw new Error("Give the release transaction hash, 0x followed by 64 hex characters.");
  return tx;
};

async function report() {
  const open = await ledger.unsettled();
  const total = await ledger.count();
  console.log(`Ledger holds ${total} release(s).`);
  if (total === 0) console.log("It is empty: run `npm run reconcile -- backfill` to record the vault's history.");
  if (!open.length) {
    console.log("Nothing needs attention.");
    return;
  }
  console.log(`\n${open.length} release(s) need attention:\n`);
  for (const u of open) {
    console.log(
      `  ${u.kind.padEnd(7)} policy ${u.policyId}${u.periodIndex ? ` p${u.periodIndex}` : ""} on ${labelForAddress(u.vault)}  ` +
        `${usdc(u.amount)} USDC  ${formatAge(u.ageSeconds)} ago  ${arc.explorerTxUrl(u.releaseTxHash)}`,
    );
  }
  console.log(
    "\nPay an unpaid one:          npm run settle-release -- <releaseTx>" +
      "\nRecord one paid another way: npm run reconcile -- resolve <releaseTx> --note \"how\"",
  );
}

async function backfill() {
  const from = BigInt(env("POLICY_VAULT_V4_DEPLOY_BLOCK"));
  const url = process.env.ARC_LOGS_RPC_URL || process.env.ARC_TESTNET_RPC_FALLBACK_URL || env("ARC_TESTNET_RPC_URL");
  const logs = client(url);
  const times = client(env("ARC_TESTNET_RPC_URL"));
  // The same cursor file the keeper's ledger watcher uses, so progress is shared either way.
  const watcher = new EventWatcher({
    client: logs, vaultAddress: currentVaultAddress(), deployBlock: from, confirmations: 2n,
    cursors: new CursorStore(join(stateDir, "ledger-cursor.json")),
    log: (m) => console.log(`  ${m}`),
  });
  console.log(`Recording releases from block ${from}. A full history takes several minutes on a public RPC.`);
  let recorded = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      await watcher.scanOnce(async (p) => {
        let at: Date | null = null;
        try { at = new Date(Number((await times.getBlock({ blockNumber: p.releaseBlockNumber })).timestamp) * 1000); } catch { /* best effort */ }
        await ledger.record(p, at);
        recorded++;
      });
      break;
    } catch (err) {
      // Progress is kept per chunk, so a transient error costs a pause, never a rescan.
      const wait = Math.min(2_000 * 2 ** attempt, 60_000);
      console.log(`  ${err instanceof Error ? (err as { details?: string }).details ?? err.message : String(err)}; retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  console.log(`Done: ${recorded} release(s) seen in this run; the ledger now holds ${await ledger.count()}.`);
}

async function show() {
  const rows = await ledger.byTx(txArg());
  if (!rows.length) {
    console.log("The ledger has no release with that transaction. If it is recent or the ledger is new, run backfill first.");
    return;
  }
  for (const r of rows) {
    console.log(`policy ${r.policyId} period ${r.periodIndex} on ${labelForAddress(r.vault)}`);
    console.log(`  released   ${r.releasedAt ?? "(time unknown)"}  block ${r.blockNumber}`);
    console.log(`  amount     ${usdc(r.amount)} USDC to ${r.recipient}, paid as ${r.payoutCurrency} on domain ${r.destinationDomain}`);
    console.log(`  settlement ${r.settlementStatus ?? "none"}`);
    console.log(`  resolution ${r.resolution ?? "none"}`);
  }
}

async function resolve() {
  const note = flag("--note");
  if (!note) throw new Error('resolve needs --note "how the release was accounted for"');
  const done = await ledger.resolve(txArg(), note);
  console.log(done.length ? `Resolved ${done.length} release(s).` : "Nothing resolved: not in the ledger, or already resolved.");
}

/**
 * Releases settled by the demo scripts, whose receipts sit in JSON files rather than Postgres.
 * Matched by release transaction, which names exactly one release. Dry run unless --write.
 */
async function importArchive() {
  const write = rest.includes("--write");
  const files = (() => {
    try { return readdirSync(stateDir).filter((f) => f.endsWith("-settlements.json")); } catch { return []; }
  })();
  let matched = 0;
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(stateDir, f), "utf8"));
    for (const r of Object.values(data.settlements ?? {}) as Array<{ status: string; releaseTxHash: string; legs?: Array<{ txHash?: string }> }>) {
      if (r.status !== "settled" || !r.releaseTxHash) continue;
      const rows = await ledger.byTx(r.releaseTxHash);
      if (!rows.length || rows.every((x) => x.resolution || x.settlementStatus === "settled")) continue;
      const payout = [...(r.legs ?? [])].reverse().find((l) => l.txHash)?.txHash;
      const note = `settled by the ${f.replace("-settlements.json", "")} demo script; receipt in ${f}${payout ? `, payout ${payout}` : ""}`;
      matched++;
      console.log(`  ${write ? "resolving" : "would resolve"} ${r.releaseTxHash}: ${note}`);
      if (write) await ledger.resolve(r.releaseTxHash, note);
    }
  }
  console.log(matched ? `${matched} release(s) ${write ? "resolved" : "to resolve; rerun with --write"}.` : "Nothing to import.");
}

/**
 * One pass of exactly what the keeper runs every few minutes: alert on anything new, and on anything
 * that cleared. Safe to repeat, since each problem is announced once. Also usable from cron on a
 * host that runs no keeper, so stranded funds still reach a person.
 */
async function alert() {
  const notifier = notifierFromEnv();
  const r = await new Reconciler({
    ledger,
    notifier,
    txUrl: (h) => arc.explorerTxUrl(h),
    labelFor: (v) => labelForAddress(v),
    log: (m) => console.log(`  ${m}`),
  }).runOnce();
  console.log(`Sent ${r.alerted} alert(s) and ${r.cleared} all-clear(s) to ${notifier.describe}.`);
}

try {
  const run = { report, backfill, show, resolve, "import-archive": importArchive, alert }[cmd];
  if (!run) throw new Error(`Unknown command "${cmd}". Try: report, backfill, show, resolve, import-archive, alert.`);
  await run();
} finally {
  await ledger.end();
}
