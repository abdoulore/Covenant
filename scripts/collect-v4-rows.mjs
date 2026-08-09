/**
 * Emit the v4 re-proof rows for RESULTS.md, generated from chain events and the settlement store.
 *
 * The twelve rows produced their hashes in terminal output, and copying them from there into
 * RESULTS.md would be typing hashes by hand: the exact thing DECISIONS D14 forbids. verify:hashes
 * would catch a mistyped hash, because it would not resolve, but it would NOT catch a real hash
 * pasted against the wrong row. Only generating from the source fixes that.
 *
 * Two sources, both authoritative:
 *   - PolicyCreated and PolicyReleased logs on the v4 vault, for creates and releases.
 *   - the executor's settlement store, whose leg hashes were read from receipts when they landed.
 *
 *   node scripts/collect-v4-rows.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, fallback, http, parseAbiItem } from "viem";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  try {
    for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
}
loadEnv();

const RPC = process.env.ARC_TESTNET_RPC_URL;
const VAULT = process.env.POLICY_VAULT_V4_ADDRESS;
if (!RPC || !VAULT) throw new Error("ARC_TESTNET_RPC_URL and POLICY_VAULT_V4_ADDRESS must be set.");

const client = createPublicClient({
  chain: { id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: fallback([RPC, process.env.ARC_TESTNET_RPC_FALLBACK_URL].filter(Boolean).map((u) => http(u, { retryCount: 3, retryDelay: 2000, timeout: 30000 }))),
});

const CREATED = parseAbiItem("event PolicyCreated(uint256 indexed policyId, address indexed recipient, uint256 amount, uint8 payoutCurrency, uint32 destinationDomain, uint8 conditionType)");
const RELEASED = parseAbiItem("event PolicyReleased(uint256 indexed policyId, address indexed recipient, uint256 amount, uint8 payoutCurrency, uint32 destinationDomain, address executor, uint256 periodIndex)");

const CONDITION = ["Timelock", "Approval", "Attestation", "Oracle", "Schedule", "OraclePull"];
const arcTx = (h) => `https://testnet.arcscan.app/tx/${h}`;
const baseTx = (h) => `https://sepolia.basescan.org/tx/${h}`;
const usdc = (v) => (Number(v) / 1e6).toFixed(6);

/** Scan an event across the vault's whole life, in chunks Arc will serve. */
async function scan(event) {
  const latest = await client.getBlockNumber();
  const SPAN = 9000n;
  const out = [];
  // The vault is new, so a bounded look-back covers it without walking the chain.
  let from = latest > 120_000n ? latest - 120_000n : 0n;
  for (; from <= latest; from += SPAN) {
    const to = from + SPAN - 1n > latest ? latest : from + SPAN - 1n;
    const logs = await client.getLogs({ address: VAULT, event, fromBlock: from, toBlock: to });
    out.push(...logs);
  }
  return out;
}

const creates = await scan(CREATED);
const releases = await scan(RELEASED);

/** Settlement legs, whose hashes were recorded from receipts as each leg landed. */
function settlements() {
  const dir = join(root, "executor", ".state");
  if (!existsSync(dir)) return {};
  const merged = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith("-settlements.json"))) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8"));
      Object.assign(merged, data.settlements ?? {});
    } catch {}
  }
  return merged;
}

const settled = settlements();

console.log(`v4 vault ${VAULT}`);
console.log(`${creates.length} policies created, ${releases.length} releases, ${Object.keys(settled).length} settlement records\n`);

console.log("## Policies created on v4\n");
console.log("| Policy | Condition | Amount | Create tx |");
console.log("| --- | --- | --- | --- |");
for (const c of creates) {
  const id = Number(c.args.policyId);
  const type = CONDITION[Number(c.args.conditionType)] ?? `#${c.args.conditionType}`;
  console.log(`| ${id} | ${type} | ${usdc(c.args.amount)} | [\`${c.transactionHash.slice(0, 10)}…\`](${arcTx(c.transactionHash)}) |`);
}

console.log("\n## Releases on v4\n");
console.log("| Policy | Period | Amount | Currency | Domain | Release tx |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const r of releases) {
  const id = Number(r.args.policyId);
  const period = Number(r.args.periodIndex);
  const currency = Number(r.args.payoutCurrency) === 1 ? "EURC" : "USDC";
  console.log(
    `| ${id} | ${period || "single"} | ${usdc(r.args.amount)} | ${currency} | ${r.args.destinationDomain} | ` +
      `[\`${r.transactionHash.slice(0, 10)}…\`](${arcTx(r.transactionHash)}) |`,
  );
}

/**
 * Only settlements belonging to a v4 release.
 *
 * The store is shared across deployments and its key is `policyId:periodIndex` with NO vault
 * component, so it holds v2, v3, and v4 records together and a key alone cannot say which. Listing
 * everything would present a v3 payout as v4 evidence. Cross-referencing against the v4 release
 * events is the only way to tell them apart, so that is what decides membership here.
 */
const v4Keys = new Set(releases.map((r) => `${Number(r.args.policyId)}:${Number(r.args.periodIndex)}`));

console.log("\n## Settlement legs for v4 releases, from the executor's store\n");
console.log("| Key | Status | Leg | Tx | Custody |");
console.log("| --- | --- | --- | --- | --- |");
for (const key of Object.keys(settled).sort()) {
  if (!v4Keys.has(key)) continue;
  const s = settled[key];
  const gap = s.custodyGapMs != null ? `${(s.custodyGapMs / 1000).toFixed(1)}s` : "";
  for (const leg of s.legs ?? []) {
    if (!leg.txHash) continue;
    const link = leg.kind === "bridge" ? baseTx(leg.txHash) : arcTx(leg.txHash);
    console.log(`| ${key} | ${s.status} | ${leg.kind} | [\`${leg.txHash.slice(0, 10)}…\`](${link}) | ${gap} |`);
  }
}

const excluded = Object.keys(settled).filter((k) => !v4Keys.has(k));
console.log(`\nExcluded ${excluded.length} settlement record(s) from earlier deployments: ${excluded.sort().join(", ")}`);
