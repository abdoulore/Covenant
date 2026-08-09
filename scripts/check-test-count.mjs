/**
 * Derive the automated test count from the suites, and check the README against it.
 *
 * The README quotes a test count as evidence. A hand-maintained number is evidence of nothing: it
 * was written once and has drifted every time a test was added since. This runs both suites, reads
 * the totals they report, and fails if the README disagrees. Every claim in this repo is supposed
 * to be reproducible, and that has to include the claims about the tests.
 *
 *   node scripts/check-test-count.mjs          check the README matches
 *   node scripts/check-test-count.mjs --write  update the README to the measured count
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = join(root, "README.md");

/** Strip ANSI colour so the totals can be matched as plain text. */
const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, "");

/** Run a command and return its combined output, whatever the exit code. */
function run(command, args, cwd) {
  const options = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  try {
    return stripAnsi(execFileSync(command, args, options));
  } catch (err) {
    // A failing suite still prints its totals, and the count is what we are after. The suites
    // themselves are the gate for pass/fail; this script only counts.
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (!output.trim()) {
      throw new Error(`\`${command} ${args.join(" ")}\` produced no output: ${err.message}`);
    }
    return stripAnsi(output);
  }
}

function contractTestCount() {
  const out = run("forge", ["test", "--root", "contracts"], root);
  // "Ran 5 test suites in 210ms: 118 tests passed, 0 failed, 0 skipped (118 total tests)"
  const m = out.match(/\((\d+)\s+total\s+tests\)/);
  if (!m) throw new Error("could not read a total from `forge test` output");
  return Number(m[1]);
}

function executorTestCount() {
  // vitest is invoked through node rather than through npm: npm is a .cmd shim on Windows, and
  // Node refuses to spawn a .cmd without a shell. Running the CLI directly needs neither.
  const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
  const out = run(process.execPath, [vitest, "run"], join(root, "executor"));
  // vitest: "      Tests  152 passed (152)"
  const m = out.match(/Tests\s+.*?\((\d+)\)/);
  if (!m) throw new Error("could not read a total from the vitest output");
  return Number(m[1]);
}

const contracts = contractTestCount();
const executor = executorTestCount();
const total = contracts + executor;

console.log(`contracts: ${contracts}`);
console.log(`executor:  ${executor}`);
console.log(`total:     ${total}`);

// The README states it as "| Automated tests | 237, across contract and executor |".
const readme = readFileSync(readmePath, "utf8");
const claimPattern = /(\|\s*Automated tests\s*\|\s*)(\d+)(, across contract and executor\s*\|)/;
const found = readme.match(claimPattern);

if (!found) {
  console.error("check-test-count: no automated-test claim found in README.md. Expected a row like:");
  console.error("  | Automated tests | 237, across contract and executor |");
  process.exit(1);
}

const claimed = Number(found[2]);

if (process.argv.includes("--write")) {
  if (claimed === total) {
    console.log(`README already states ${total}. Nothing to write.`);
    process.exit(0);
  }
  writeFileSync(readmePath, readme.replace(claimPattern, `$1${total}$3`), "utf8");
  console.log(`README updated: ${claimed} -> ${total}`);
  process.exit(0);
}

if (claimed !== total) {
  console.error(
    `check-test-count: README claims ${claimed} automated tests, the suites run ${total}. ` +
      `Run \`npm run test:count -- --write\` to correct it.`,
  );
  process.exit(1);
}

console.log(`README claim of ${claimed} matches the suites.`);
