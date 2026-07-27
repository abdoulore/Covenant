/**
 * Verify EventWatcher against the live chain.
 *
 *   node --env-file=.env executor/scripts/scan-releases.ts
 *
 * Scans from the vault deploy block and prints every PolicyReleased it decodes. Read only: it
 * uses a throwaway cursor under .state/ so it never disturbs the executor's real scan position.
 */

import { createPublicClient, http } from "viem";
import { join } from "node:path";
import { EventWatcher } from "../src/chain/EventWatcher.js";
import { CursorStore } from "../src/store/CursorStore.js";
import { chainFor } from "../src/config.js";

const env = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set`);
  return v;
};

const arcTestnet = {
  id: Number(process.env.ARC_CHAIN_ID ?? 5042002),
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [env("ARC_TESTNET_RPC_URL")] } },
} as const;

const client = createPublicClient({
  chain: arcTestnet,
  transport: http(env("ARC_TESTNET_RPC_URL"), { retryCount: 3, retryDelay: 1_500, timeout: 30_000 }),
});

const watcher = new EventWatcher({
  client,
  vaultAddress: env("POLICY_VAULT_ADDRESS") as `0x${string}`,
  cursors: new CursorStore(join(process.cwd(), ".state", "scan-check-cursor.json")),
  deployBlock: BigInt(env("POLICY_VAULT_DEPLOY_BLOCK")),
});

const head = await client.getBlockNumber();
console.log(`vault  ${env("POLICY_VAULT_ADDRESS")}`);
console.log(`from   ${env("POLICY_VAULT_DEPLOY_BLOCK")}`);
console.log(`head   ${head}  (${head - BigInt(env("POLICY_VAULT_DEPLOY_BLOCK"))} blocks to scan)\n`);

const started = Date.now();
const count = await watcher.scanOnce(async (policy) => {
  const chain = chainFor(policy.destinationDomain);
  console.log(`PolicyReleased  policy ${policy.policyId}`);
  console.log(`  amount       ${(Number(policy.amount) / 1e6).toFixed(6)} ${policy.payoutCurrency}`);
  console.log(`  recipient    ${policy.recipient}`);
  console.log(`  destination  ${chain.name} (domain ${policy.destinationDomain})`);
  console.log(`  release tx   ${chain.explorerTxUrl(policy.releaseTxHash)}`);
  console.log(`  block        ${policy.releaseBlockNumber}\n`);
});

console.log(`${count} release(s) found in ${((Date.now() - started) / 1000).toFixed(1)}s`);
