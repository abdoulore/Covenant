/**
 * Real wiring for the keeper. Kept out of Keeper.ts so that file stays import-safe and testable
 * with stubs, exactly as start.ts is kept out of server.ts. See DECISIONS.md D12 for the pattern.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { AppKit } from "@circle-fin/app-kit";
import { join } from "node:path";
import { EventWatcher } from "../chain/EventWatcher.js";
import { CursorStore } from "../store/CursorStore.js";
import { PostgresSettlementStore } from "../store/PostgresSettlementStore.js";
import { SettlementEngine } from "../SettlementEngine.js";
import { createLegRunner } from "../legs/createLegRunner.js";
import { CircleWalletProvider } from "../wallet/CircleWalletProvider.js";
import { chainFor, ARC_DOMAIN } from "../config.js";
import { currentVaultAddress } from "../api/vaults.js";
import { coldStartBlock, createKeeper, type Keeper } from "./Keeper.js";

export interface KeeperEnvOptions {
  /** Where the scan cursor lives. Settlement records live in Postgres. */
  stateDir: string;
  /** Postgres holding the settlement records. Required: see keeperFromEnv. */
  databaseUrl: string | undefined;
  rpcUrl: string;
  log?: (message: string) => void;
  pollIntervalMs?: number;
}

/**
 * Build the keeper from the environment.
 *
 * Settlement records go to Postgres, keyed on (vault, policy, period). There is deliberately no
 * fallback to the JSON store when DATABASE_URL is missing: that store keys without the vault, so a
 * keeper running on it would reintroduce the exact collision D15 removed, where a policy on a new
 * vault is mistaken for an already-paid one and silently skipped. Refusing to start is the safe
 * failure; the API catches it and keeps serving reads.
 */
export async function keeperFromEnv(opts: KeeperEnvOptions): Promise<Keeper> {
  const log = opts.log ?? ((m: string) => console.log(m));
  if (!opts.databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. The keeper stores settlements in Postgres, keyed by vault, and will " +
        "not fall back to the JSON store, whose key has no vault (D15).",
    );
  }
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
  const store = new PostgresSettlementStore({ connectionString: opts.databaseUrl });
  await store.migrate();
  log("keeper: settlement store is Postgres, keyed by vault, policy, and period");

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
    log,
    ...(opts.pollIntervalMs === undefined ? {} : { pollIntervalMs: opts.pollIntervalMs }),
  });

  return createKeeper({ watcher, engine, log });
}
