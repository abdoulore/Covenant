/**
 * Real wiring for the keeper. Kept out of Keeper.ts so that file stays import-safe and testable
 * with stubs, exactly as start.ts is kept out of server.ts. See DECISIONS.md D12 for the pattern.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { AppKit } from "@circle-fin/app-kit";
import { join } from "node:path";
import { EventWatcher } from "../chain/EventWatcher.js";
import { CursorStore } from "../store/CursorStore.js";
import { SettlementStore } from "../store/SettlementStore.js";
import { SettlementEngine } from "../SettlementEngine.js";
import { createLegRunner } from "../legs/createLegRunner.js";
import { CircleWalletProvider } from "../wallet/CircleWalletProvider.js";
import { chainFor, ARC_DOMAIN } from "../config.js";
import { currentVaultAddress } from "../api/vaults.js";
import { coldStartBlock, createKeeper, type Keeper } from "./Keeper.js";

export interface KeeperEnvOptions {
  /** Where the cursor and settlement records live. Backed by a volume in a deployed run. */
  stateDir: string;
  rpcUrl: string;
  log?: (message: string) => void;
  pollIntervalMs?: number;
}

/**
 * Build the keeper from the environment.
 *
 * The settlement store is named `keeper-settlements.json` because the read model unions every
 * `*-settlements.json` in the state directory and tags each record with the file it came from. A
 * receipt this process produced therefore shows up in the app labelled `keeper`, distinguishable
 * from the demo-script runs that produced the archive on a developer's machine.
 */
export async function keeperFromEnv(opts: KeeperEnvOptions): Promise<Keeper> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const arc = chainFor(ARC_DOMAIN);

  const client = createPublicClient({
    chain: {
      id: arc.chainId, name: arc.name, nativeCurrency: arc.nativeCurrency,
      rpcUrls: { default: { http: [opts.rpcUrl] } },
    },
    transport: http(opts.rpcUrl, { retryCount: 3, retryDelay: 1_500, timeout: 30_000 }),
  }) as PublicClient;

  const wallets = CircleWalletProvider.fromEnv();
  const cursors = new CursorStore(join(opts.stateDir, "keeper-cursor.json"));
  const store = new SettlementStore(join(opts.stateDir, "keeper-settlements.json"));

  const engine = new SettlementEngine({
    store,
    wallets,
    runLeg: createLegRunner(wallets, {
      kit: new AppKit(),
      ...(process.env.CIRCLE_KIT_KEY ? { kitKey: process.env.CIRCLE_KIT_KEY } : {}),
    }),
    log,
  });

  const watcher = new EventWatcher({
    client,
    vaultAddress: currentVaultAddress(),
    cursors,
    // Only consulted when no cursor exists yet. See coldStartBlock for why this is the head.
    deployBlock: await coldStartBlock(() => client.getBlockNumber(), log),
    confirmations: 2n,
    ...(opts.pollIntervalMs === undefined ? {} : { pollIntervalMs: opts.pollIntervalMs }),
  });

  return createKeeper({ watcher, engine, log });
}
