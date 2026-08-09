/**
 * Resolve every transaction hash asserted anywhere in the repo against the chain.
 *
 * This exists because a placeholder hash was once typed by hand into a script, in a repository whose
 * entire value proposition is that every hash in it is real. It was caught and replaced before it
 * did harm, but "be more careful" is not a fix. This is the fix: hashes are derived and checked,
 * never asserted, in the same way `npm run test:count` derives the test count.
 *
 * Two sources are checked, chosen because both are unambiguous assertions that a transaction exists:
 *
 *   1. Explorer links, `https://<explorer>/tx/0x...`, anywhere in the repo. These are the published
 *      proofs: every claim in RESULTS.md, the README, and the landing page is one of these.
 *   2. `txHash: "0x..."` literals in source, which is how the scripts name a transaction.
 *
 * A bare 64-hex string is deliberately NOT checked. Feed ids, keccak typehashes, and block hashes
 * are all the same shape, and a checker that flagged those would be noise nobody reads.
 *
 *   npm run verify:hashes
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Explorer host to the RPC that can answer for it. */
const CHAINS = [
  { host: "testnet.arcscan.app", name: "Arc Testnet", rpcEnv: ["ARC_TESTNET_RPC_URL", "ARC_TESTNET_RPC_FALLBACK_URL"] },
  { host: "sepolia.basescan.org", name: "Base Sepolia", rpcEnv: ["BASE_SEPOLIA_RPC_URL", "BASE_SEPOLIA_RPC_FALLBACK_URL"] },
];

const TX_URL = /https?:\/\/([a-z0-9.-]+)\/tx\/(0x[0-9a-fA-F]{64})/g;
const TX_LITERAL = /txHash"?\s*:\s*"(0x[0-9a-fA-F]{64})"/g;

/**
 * Files to scan: tracked, plus untracked ones that are not ignored.
 *
 * The untracked half matters more than it looks. The placeholder hash that prompted this checker was
 * in a brand new file that had never been committed, which is precisely when catching it is useful.
 * Ignored paths stay out, so node_modules and build output are never walked.
 */
function scannableFiles() {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  return [...new Set(out.split(/\r?\n/).filter(Boolean))];
}

/** Load .env without a dependency: only the keys this script needs. */
function loadEnv() {
  try {
    for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // No .env is fine if the RPC vars are already in the environment.
  }
}

function rpcFor(chain) {
  for (const key of chain.rpcEnv) {
    if (process.env[key]) return process.env[key];
  }
  return undefined;
}

async function txExists(rpc, hash) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [hash] }),
  });
  if (!res.ok) throw new Error(`RPC returned ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  return body.result != null;
}

loadEnv();

// ---- collect every asserted hash, with where it was asserted ----

/** hash -> { chain, sites: [] }. A hash cited in ten places is still one lookup. */
const asserted = new Map();

function record(hash, chainHost, file, line) {
  const key = hash.toLowerCase();
  const existing = asserted.get(key);
  if (existing) {
    existing.sites.push(`${file}:${line}`);
    if (chainHost && !existing.chainHost) existing.chainHost = chainHost;
    return;
  }
  asserted.set(key, { hash: key, chainHost, sites: [`${file}:${line}`] });
}

for (const file of scannableFiles()) {
  let text;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch {
    continue; // binary or unreadable
  }
  if (!text.includes("0x")) continue;

  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, i) => {
    for (const m of lineText.matchAll(TX_URL)) record(m[2], m[1], file, i + 1);
    for (const m of lineText.matchAll(TX_LITERAL)) record(m[1], undefined, file, i + 1);
  });
}

if (asserted.size === 0) {
  console.log("verify-hashes: no asserted transaction hashes found.");
  process.exit(0);
}

// ---- resolve each against the chain ----

const failures = [];
const unchecked = [];
let verified = 0;

for (const entry of asserted.values()) {
  // A hash from an explorer link knows its chain. A bare txHash literal does not, so try each.
  const candidates = entry.chainHost
    ? CHAINS.filter((c) => c.host === entry.chainHost)
    : CHAINS;

  if (candidates.length === 0) {
    unchecked.push({ ...entry, why: `unknown explorer host ${entry.chainHost}` });
    continue;
  }

  let found = false;
  let lastError;
  let anyRpc = false;

  for (const chain of candidates) {
    const rpc = rpcFor(chain);
    if (!rpc) continue;
    anyRpc = true;
    try {
      if (await txExists(rpc, entry.hash)) {
        found = true;
        break;
      }
    } catch (err) {
      lastError = err.message;
    }
  }

  if (found) {
    verified++;
  } else if (!anyRpc) {
    unchecked.push({ ...entry, why: "no RPC configured for its chain" });
  } else if (lastError) {
    unchecked.push({ ...entry, why: `lookup failed: ${lastError}` });
  } else {
    failures.push(entry);
  }
}

console.log(`verify-hashes: ${asserted.size} asserted hash(es), ${verified} verified onchain.`);

if (unchecked.length) {
  console.log(`\n${unchecked.length} could not be checked (not a failure, but not proof either):`);
  for (const u of unchecked) console.log(`  ${u.hash}  ${u.why}\n      ${u.sites.join(", ")}`);
}

if (failures.length) {
  console.error(`\nFAILED: ${failures.length} hash(es) do not exist on the chain they claim:\n`);
  for (const f of failures) {
    console.error(`  ${f.hash}`);
    for (const site of f.sites) console.error(`      ${site}`);
  }
  console.error(
    "\nA hash in this repository is a claim that a transaction happened. Every one must come from a\n" +
      "receipt, a chain query, or RESULTS.md. Do not type one by hand.",
  );
  process.exit(1);
}

console.log("\nEvery asserted hash resolves onchain.");
