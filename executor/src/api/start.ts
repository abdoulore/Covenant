/**
 * Entrypoint for the Covenant write API (Frontend Part B). Wires the real dependencies and listens.
 * Kept separate from server.ts so that file stays import-safe and unit-testable. See DECISIONS.md D12.
 *
 *   npm run api
 *
 * Optionally runs the keeper in this same process, so a deployment produces its own settlement
 * receipts rather than serving an empty Settlements tab. They share one process because they must
 * share one directory: a platform volume attaches to a single service, so splitting them would
 * leave the API reading a directory the keeper cannot write.
 */
import { join } from "node:path";
import { loadApiConfig } from "./apiConfig.js";
import { createCachedReadState, readModelFromOptions } from "./readModel.js";
import { VaultService } from "./vaultService.js";
import { createApiServer, type VaultServiceLike } from "./server.js";

const config = loadApiConfig(process.env);

/**
 * Where settlement records and the scan cursor live.
 *
 * Explicit rather than derived from the working directory, because a deployed run mounts a volume
 * at a fixed path and the process's cwd is whatever the platform chose to start it in. Local runs
 * keep the old default so nothing moves.
 */
const stateDir = process.env.COVENANT_STATE_DIR ?? join(process.cwd(), ".state");

const readDeps = readModelFromOptions({
  rpcUrl: process.env.ARC_TESTNET_RPC_URL ?? "",
  v4Address: process.env.POLICY_VAULT_V4_ADDRESS,
  v3Address: process.env.POLICY_VAULT_V3_ADDRESS,
  v2Address: process.env.POLICY_VAULT_ADDRESS,
  feedId: process.env.PYTH_USDC_USD_FEED_ID ?? "",
  stateDir,
  // The operator app is an operational surface: it lists what can be acted on, plus the deployment
  // being drained. v2 is history and lives in the monitor. See vaults.ts.
  surface: "app",
});

// The write service is resolved lazily and once: a read-only or unconfigured run never needs Circle
// credentials, and the first write pays the wallet-resolution cost, not startup.
let servicePromise: Promise<VaultServiceLike> | undefined;
const getService = () => (servicePromise ??= VaultService.fromEnv());

const server = createApiServer({
  config,
  readState: createCachedReadState(readDeps),
  getService,
});

server.listen(config.port, () => {
  console.log(`Covenant API on http://localhost:${config.port} (writes gated${config.devMode ? ", dev mode" : ""})`);
  console.log(`state directory: ${stateDir}`);
});

/**
 * The keeper, off unless asked for.
 *
 * Opt-in rather than automatic because it needs Circle credentials and it moves real funds: a local
 * API run, or one started without wallet credentials, should serve reads and nothing else rather
 * than start a payment loop nobody asked for.
 *
 * Its failure is isolated. If it cannot start, the API keeps serving; an operator loses new
 * receipts, which is the same position they were in before the keeper existed, rather than losing
 * the whole service.
 */
if (/^(1|true|on|yes)$/i.test(process.env.COVENANT_KEEPER ?? "")) {
  const { keeperFromEnv } = await import("../keeper/keeperFromEnv.js");
  keeperFromEnv({ stateDir, rpcUrl: process.env.ARC_TESTNET_RPC_URL ?? "" })
    .then(async (keeper) => {
      await keeper.start();
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        process.once(signal, () => {
          console.log(`keeper: ${signal} received, stopping the watch loop`);
          keeper.stop();
        });
      }
    })
    .catch((err) => {
      console.error(`keeper: failed to start, the API continues without it: ${err?.message ?? err}`);
    });
} else {
  console.log("keeper: not enabled (set COVENANT_KEEPER=on to settle releases from this process)");
}
