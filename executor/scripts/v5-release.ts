/**
 * Release every v5 policy that can be released.
 *
 *   npm run v5:release            one pass
 *   npm run v5:release -- --watch every 15 seconds, until stopped
 *
 * The same releaser the API process runs when COVENANT_KEEPER is on. Needs POLICY_VAULT_V5_ADDRESS
 * and V5_KEEPER_PRIVATE_KEY, a key holding a little USDC for gas and nothing else.
 */
import { v5ReleaserFromEnv } from "../src/v5/v5ReleaserFromEnv.js";

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set; see .env.example`);
  return v;
};

const { releaser, keeper } = v5ReleaserFromEnv({
  rpcUrl: need("ARC_TESTNET_RPC_URL"),
  vault: need("POLICY_VAULT_V5_ADDRESS") as `0x${string}`,
  keeperKey: need("V5_KEEPER_PRIVATE_KEY") as `0x${string}`,
  log: (m) => console.log(m),
});
console.log(`v5 releaser as ${keeper}`);

const pass = async () => {
  const r = await releaser.runOnce();
  if (r.paused) console.log("vault is paused; nothing released");
  else console.log(`released ${r.released.length}`);
};

if (process.argv.includes("--watch")) {
  for (;;) {
    await pass().catch((err) => console.log(`pass failed, will retry: ${err instanceof Error ? err.message : String(err)}`));
    await new Promise((r) => setTimeout(r, 15_000));
  }
} else {
  await pass();
}
