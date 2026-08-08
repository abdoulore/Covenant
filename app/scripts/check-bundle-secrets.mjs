/**
 * Grep the built client bundle for secret material and fail the build if any is found.
 *
 * This is the enforcement behind the signing boundary (DECISIONS.md D12, B2.1): the app talks only to
 * the API and holds nothing, and this makes that provable rather than asserted. It runs as the last
 * step of `npm run build`, so a bundle that ever embedded a key cannot ship.
 *
 * Two checks: the exact secret VALUES from the repo `.env` (the real "provably absent" test) and a
 * set of generic markers that must never reach a browser. It prints only key NAMES on a violation,
 * never a secret value.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const envPath = join(here, "..", "..", ".env");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

if (!existsSync(distDir)) {
  console.error("check-bundle-secrets: dist/ not found. Run `vite build` first.");
  process.exit(1);
}

const files = walk(distDir);
const contents = files.map((f) => ({ f, text: readFileSync(f, "utf8") }));
const violations = [];

// 1) Exact secret values from .env. Only keys whose NAME looks sensitive, and only non-trivial values.
const sensitiveKey = /(SECRET|PRIVATE_KEY|API_KEY|ENTITY|MNEMONIC|SEED)/i;
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim().replace(/^["']|["']$/g, "");
    if (!sensitiveKey.test(key) || val.length < 12) continue;
    for (const { f, text } of contents) {
      if (text.includes(val)) violations.push(`the value of ${key} appears in ${f}`);
    }
  }
}

// 2) Generic markers that should never appear in a client bundle.
const forbidden = ["entitySecret", "-----BEGIN", "CIRCLE_ENTITY_SECRET", "DEPLOYER_PRIVATE_KEY", "DELEGATE_PRIVATE_KEY"];
for (const { f, text } of contents) {
  for (const needle of forbidden) {
    if (text.includes(needle)) violations.push(`forbidden marker "${needle}" appears in ${f}`);
  }
}

if (violations.length) {
  console.error("BUNDLE SECRET CHECK FAILED:");
  for (const v of violations) console.error("  - " + v);
  process.exit(1);
}

console.log(`Bundle secret check: scanned ${files.length} files in dist/, no secret material found.`);
