/**
 * Covenant dashboard: a READ-ONLY monitor over the treasury engine (Phase 2.4, read-first).
 *
 * This process holds the Circle entity secret (it is the executor), so v1 mounts NO write endpoints
 * at all, at the routing level, not by convention. There is nothing to gate wrongly: the write path
 * does not exist in this code. See docs/specs/PHASE2_DASHBOARD.md.
 *
 * Serves policy state (from chain), settlement receipts (from the executor's .state stores), and a
 * live Pyth price for the depeg panel (from Hermes). One origin: the API and the static page are
 * served together, so there is no CORS surface either.
 */
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type PublicClient } from "viem";
import { chainFor, ARC_DOMAIN } from "../config.js";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, "public");
const STATE_DIR = join(process.cwd(), ".state");

const CONDITION = ["Timelock", "Approval", "Attestation", "Oracle"];
const STATUS = ["Pending", "Releasable", "Executed", "Cancelled"];
const COMPARATOR = ["Gte", "Lte"];
const CURRENCY = ["USDC", "EURC"];

// v2's Policy struct. v3 appends the recurring/sweep fields, so the two vaults decode with different
// output tuples; reading v2 with the v3 tuple would over-read and revert.
const BASE = [
  { name: "recipient", type: "address" }, { name: "amount", type: "uint256" }, { name: "funded", type: "uint256" },
  { name: "payoutCurrency", type: "uint8" }, { name: "destinationDomain", type: "uint32" }, { name: "conditionType", type: "uint8" },
  { name: "releaseTime", type: "uint64" }, { name: "threshold", type: "uint8" }, { name: "approvalCount", type: "uint8" },
  { name: "status", type: "uint8" }, { name: "attester", type: "address" }, { name: "attested", type: "bool" },
  { name: "feed", type: "address" }, { name: "comparator", type: "uint8" }, { name: "maxStaleSeconds", type: "uint64" },
  { name: "oracleThreshold", type: "int256" },
] as const;
const RECURRING = [
  { name: "recurring", type: "bool" }, { name: "isSweep", type: "bool" }, { name: "amountPerPeriod", type: "uint256" },
  { name: "buffer", type: "uint256" }, { name: "minSweep", type: "uint256" }, { name: "interval", type: "uint64" },
  { name: "nextDue", type: "uint64" }, { name: "maxCatchUp", type: "uint64" }, { name: "periods", type: "uint32" },
  { name: "periodsReleased", type: "uint32" },
] as const;

const policyAbi = (components: readonly unknown[]) =>
  [
    { type: "function", name: "nextPolicyId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "function", name: "statusOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint8" }] },
    { type: "function", name: "getPolicy", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }], outputs: [{ type: "tuple", components }] },
  ] as const;

const env = (n: string, fallback?: string): string => {
  const v = process.env[n] ?? fallback;
  if (!v) throw new Error(`${n} is not set.`);
  return v;
};

const RPC = env("ARC_TESTNET_RPC_URL");
const FEED_ID = env("PYTH_USDC_USD_FEED_ID", "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a");
const arc = chainFor(ARC_DOMAIN);
const client = createPublicClient({
  chain: { id: arc.chainId, name: arc.name, nativeCurrency: arc.nativeCurrency, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC, { retryCount: 2, retryDelay: 1_500, timeout: 20_000 }),
}) as PublicClient;

const VAULTS = [
  { label: "v3", address: process.env.POLICY_VAULT_V3_ADDRESS, abi: policyAbi([...BASE, ...RECURRING]) },
  { label: "v2", address: process.env.POLICY_VAULT_ADDRESS, abi: policyAbi(BASE) },
].filter((v) => v.address) as { label: string; address: `0x${string}`; abi: any }[];

const explorerTx = (h: string) => arc.explorerTxUrl(h);
const jsonSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

async function readPolicies() {
  const out: any[] = [];
  for (const vault of VAULTS) {
    let next = 0n;
    try {
      next = (await client.readContract({ address: vault.address, abi: vault.abi, functionName: "nextPolicyId" })) as bigint;
    } catch { continue; }
    for (let id = 0n; id < next; id++) {
      try {
        const [p, effective] = await Promise.all([
          client.readContract({ address: vault.address, abi: vault.abi, functionName: "getPolicy", args: [id] }) as Promise<any>,
          client.readContract({ address: vault.address, abi: vault.abi, functionName: "statusOf", args: [id] }) as Promise<number>,
        ]);
        out.push({
          vault: vault.label, address: vault.address, id: id.toString(),
          recipient: p.recipient, amount: p.amount.toString(), funded: p.funded.toString(),
          payoutCurrency: CURRENCY[p.payoutCurrency], destinationDomain: p.destinationDomain,
          conditionType: p.recurring ? (p.isSweep ? "Sweep" : "Recurring") : CONDITION[p.conditionType],
          status: STATUS[p.status], effectiveStatus: STATUS[effective],
          releaseTime: p.releaseTime?.toString(), threshold: p.threshold, approvalCount: p.approvalCount,
          attester: p.attester, attested: p.attested,
          feed: p.feed, comparator: COMPARATOR[p.comparator], oracleThreshold: p.oracleThreshold?.toString(),
          maxStaleSeconds: p.maxStaleSeconds?.toString(),
          recurring: p.recurring ?? false, isSweep: p.isSweep ?? false,
          amountPerPeriod: p.amountPerPeriod?.toString(), buffer: p.buffer?.toString(), minSweep: p.minSweep?.toString(),
          interval: p.interval?.toString(), nextDue: p.nextDue?.toString(), maxCatchUp: p.maxCatchUp?.toString(),
          periods: p.periods, periodsReleased: p.periodsReleased,
        });
      } catch { /* skip an unreadable policy rather than fail the whole scan */ }
    }
  }
  return out;
}

async function readSettlements() {
  const out: any[] = [];
  let files: string[] = [];
  try { files = (await readdir(STATE_DIR)).filter((f) => f.endsWith("-settlements.json")); } catch { return out; }
  for (const file of files) {
    try {
      const data = JSON.parse(await readFile(join(STATE_DIR, file), "utf8"));
      for (const key of Object.keys(data.settlements ?? {})) {
        const r = data.settlements[key];
        const payout = r.legs?.find((l: any) => l.txHash);
        out.push({
          key, source: file.replace("-settlements.json", ""), policyId: r.policyId, periodIndex: r.periodIndex,
          status: r.status, recipient: r.recipient, amount: r.amount, payoutCurrency: r.payoutCurrency,
          destinationDomain: r.destinationDomain,
          release: { txHash: r.releaseTxHash, url: r.releaseExplorerUrl, at: r.startedAt },
          payout: payout ? { txHash: payout.txHash, url: payout.explorerUrl, at: payout.completedAt } : null,
          custodyGapMs: r.custodyGapMs ?? r.durationMs, legs: r.legs?.map((l: any) => ({ kind: l.kind, status: l.status, txHash: l.txHash, url: l.explorerUrl })),
        });
      }
    } catch { /* skip a malformed store file */ }
  }
  return out.sort((a, b) => (a.release?.at ?? "").localeCompare(b.release?.at ?? ""));
}

async function readOracle() {
  // The depeg panel is the money shot, so tolerate a flaky Hermes call rather than showing "unavailable".
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${FEED_ID}&parsed=true`);
      if (!res.ok) throw new Error(String(res.status));
      const j: any = await res.json();
      const p = j.parsed?.[0]?.price;
      if (!p) throw new Error("no price");
      return { pair: "USDC/USD", price: Number(p.price) * 10 ** p.expo, conf: Number(p.conf) * 10 ** p.expo, publishTime: p.publish_time, decimals: -p.expo };
    } catch {
      if (attempt < 3) await new Promise((r) => setTimeout(r, 700));
    }
  }
  return null;
}

async function state() {
  const [policies, settlements, oracle] = await Promise.all([readPolicies(), readSettlements(), readOracle()]);
  return { generatedAt: new Date().toISOString(), vaults: VAULTS.map((v) => ({ label: v.label, address: v.address })), policies, settlements, oracle };
}

const CONTENT: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  try {
    if (url === "/api/state") {
      const body = JSON.stringify(await state(), jsonSafe);
      res.writeHead(200, { "content-type": "application/json" }).end(body);
      return;
    }
    // Static frontend. Only GET, only from the public dir. No write routes exist.
    const file = url === "/" ? "index.html" : url.replace(/^\/+/, "");
    const ext = file.slice(file.lastIndexOf("."));
    const content = await readFile(join(PUBLIC_DIR, file));
    res.writeHead(200, { "content-type": CONTENT[ext] ?? "application/octet-stream" }).end(content);
  } catch (err: any) {
    res.writeHead(url.startsWith("/api") ? 500 : 404, { "content-type": "application/json" })
      .end(JSON.stringify({ error: err?.message ?? "not found" }));
  }
});

const PORT = Number(process.env.DASHBOARD_PORT ?? 4319);
server.listen(PORT, () => console.log(`Covenant dashboard (read-only) on http://localhost:${PORT}`));
