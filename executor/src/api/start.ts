/**
 * Entrypoint for the Covenant write API (Frontend Part B). Wires the real dependencies and listens.
 * Kept separate from server.ts so that file stays import-safe and unit-testable. See DECISIONS.md D12.
 *
 *   npm run api
 */
import { join } from "node:path";
import { loadApiConfig } from "./apiConfig.js";
import { buildReadState, readModelFromOptions } from "./readModel.js";
import { VaultService } from "./vaultService.js";
import { createApiServer, type VaultServiceLike } from "./server.js";

const config = loadApiConfig(process.env);

const readDeps = readModelFromOptions({
  rpcUrl: process.env.ARC_TESTNET_RPC_URL ?? "",
  v3Address: process.env.POLICY_VAULT_V3_ADDRESS,
  v2Address: process.env.POLICY_VAULT_ADDRESS,
  feedId: process.env.PYTH_USDC_USD_FEED_ID ?? "",
  stateDir: join(process.cwd(), ".state"),
});

// The write service is resolved lazily and once: a read-only or unconfigured run never needs Circle
// credentials, and the first write pays the wallet-resolution cost, not startup.
let servicePromise: Promise<VaultServiceLike> | undefined;
const getService = () => (servicePromise ??= VaultService.fromEnv());

const server = createApiServer({
  config,
  readState: () => buildReadState(readDeps),
  getService,
});

server.listen(config.port, () => {
  console.log(`Covenant API on http://localhost:${config.port} (writes gated${config.devMode ? ", dev mode" : ""})`);
});
