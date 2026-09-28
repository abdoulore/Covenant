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
  v5Address: process.env.POLICY_VAULT_V5_ADDRESS,
  v4Address: process.env.POLICY_VAULT_V4_ADDRESS,
  v3Address: process.env.POLICY_VAULT_V3_ADDRESS,
  v2Address: process.env.POLICY_VAULT_ADDRESS,
  feedId: process.env.PYTH_USDC_USD_FEED_ID ?? "",
  stateDir,
  databaseUrl: process.env.DATABASE_URL,
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
  keeperFromEnv({
    stateDir,
    databaseUrl: process.env.DATABASE_URL,
    rpcUrl: process.env.ARC_TESTNET_RPC_URL ?? "",
    logsRpcUrl: process.env.ARC_LOGS_RPC_URL || process.env.ARC_TESTNET_RPC_FALLBACK_URL || undefined,
    vaultDeployBlock: process.env.POLICY_VAULT_V4_DEPLOY_BLOCK ? BigInt(process.env.POLICY_VAULT_V4_DEPLOY_BLOCK) : undefined,
  })
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

/**
 * The v5 releaser, alongside the v4 keeper and independent of it: it needs no Circle credentials and
 * no database, only a gas key, because it moves no money of its own. It asks the vault to pay.
 */
if (/^(1|true|on|yes)$/i.test(process.env.COVENANT_KEEPER ?? "") && process.env.POLICY_VAULT_V5_ADDRESS) {
  if (!process.env.V5_KEEPER_PRIVATE_KEY) {
    console.log("v5 releaser: not started, V5_KEEPER_PRIVATE_KEY is not set");
  } else {
    const { v5ReleaserFromEnv } = await import("../v5/v5ReleaserFromEnv.js");
    const { releaser, keeper } = v5ReleaserFromEnv({
      rpcUrl: process.env.ARC_TESTNET_RPC_URL ?? "",
      vault: process.env.POLICY_VAULT_V5_ADDRESS as `0x${string}`,
      keeperKey: process.env.V5_KEEPER_PRIVATE_KEY as `0x${string}`,
    });
    console.log(`v5 releaser: releasing for ${process.env.POLICY_VAULT_V5_ADDRESS} as ${keeper}, every 15 s`);
    let running = false;
    const timer = setInterval(async () => {
      if (running) return; // a slow pass must not overlap the next
      running = true;
      try {
        await releaser.runOnce();
      } catch (err) {
        console.log(`v5 releaser: pass failed, will retry: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        running = false;
      }
    }, 15_000);
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => clearInterval(timer));
  }

  // The v5 monitor: stalled releases, near deadlines, unminted cross-chain payouts. Needs the
  // database for its memory, so each problem is announced once even across restarts.
  if (!process.env.DATABASE_URL || !process.env.POLICY_VAULT_V5_DEPLOY_BLOCK) {
    console.log("v5 monitor: not started, DATABASE_URL and POLICY_VAULT_V5_DEPLOY_BLOCK are both needed");
  } else {
    const { v5MonitorFromEnv } = await import("../v5/v5MonitorFromEnv.js");
    v5MonitorFromEnv({
      rpcUrl: process.env.ARC_TESTNET_RPC_URL ?? "",
      logsRpcUrl: process.env.ARC_LOGS_RPC_URL || process.env.ARC_TESTNET_RPC_FALLBACK_URL || undefined,
      vault: process.env.POLICY_VAULT_V5_ADDRESS as `0x${string}`,
      vaultLabel: "v5",
      deployBlock: BigInt(process.env.POLICY_VAULT_V5_DEPLOY_BLOCK),
      databaseUrl: process.env.DATABASE_URL,
    })
      .then((m) => {
        console.log(`v5 monitor: every 5 min, ${m.describe}`);
        const pass = () => m.runOnce().catch((err) => console.log(`v5 monitor: pass failed, will retry: ${err instanceof Error ? err.message : String(err)}`));
        void pass();
        const t = setInterval(pass, 5 * 60_000);
        for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => clearInterval(t));
      })
      .catch((err) => console.log(`v5 monitor: failed to start, the API continues without it: ${err?.message ?? err}`));
  }
}
