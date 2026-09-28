/**
 * One pass of the v5 monitor: record new cross-chain releases, then announce what needs a person.
 *
 *   npm run v5:monitor
 *
 * The API process runs the same pass every five minutes when COVENANT_KEEPER is on.
 */
import { v5MonitorFromEnv } from "../src/v5/v5MonitorFromEnv.js";

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set; see .env.example`);
  return v;
};

const m = await v5MonitorFromEnv({
  rpcUrl: need("ARC_TESTNET_RPC_URL"),
  logsRpcUrl: process.env.ARC_LOGS_RPC_URL || process.env.ARC_TESTNET_RPC_FALLBACK_URL,
  vault: need("POLICY_VAULT_V5_ADDRESS") as `0x${string}`,
  vaultLabel: "v5",
  deployBlock: BigInt(need("POLICY_VAULT_V5_DEPLOY_BLOCK")),
  databaseUrl: need("DATABASE_URL"),
});
try {
  console.log(`v5 monitor: ${m.describe}`);
  const r = await m.runOnce();
  console.log(`recorded ${r.crossChainRecorded} new cross-chain release(s); announced ${r.announced}, cleared ${r.cleared}`);
} finally {
  await m.end();
}
