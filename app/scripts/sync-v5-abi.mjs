/**
 * Copy PolicyVaultV5's ABI from the Foundry build into the app.
 *
 * The app signs v5 transactions itself, so it needs the whole ABI: every function it calls, and every
 * error, so a refusal shows as the contract's own name ("DeadlineTooSoon") rather than raw bytes.
 * Copied rather than imported because the app builds without the contracts. The executor suite checks
 * the copy against the build, so a contract change that is not synced here fails CI.
 *
 * Run after `forge build`: node app/scripts/sync-v5-abi.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const artifact = join(here, "..", "..", "contracts", "out", "PolicyVaultV5.sol", "PolicyVaultV5.json");
const target = join(here, "..", "src", "v5", "vaultAbi.json");

const { abi } = JSON.parse(readFileSync(artifact, "utf8"));
writeFileSync(target, JSON.stringify(abi, null, 1) + "\n");
console.log(`PolicyVaultV5 ABI: ${abi.length} entries written to ${target}`);
