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
import { currentVaultAddress, labelForAddress } from "../api/vaults.js";
import { ReleaseLedger } from "../store/ReleaseLedger.js";
import { notifierFromEnv } from "../alerts/Notifier.js";
import { Reconciler } from "./Reconciler.js";
import { coldStartBlock, createKeeper, type Keeper } from "./Keeper.js";

export interface KeeperEnvOptions {
  /** Where the scan cursor lives. Settlement records live in Postgres. */
  stateDir: string;
  /** Postgres holding the settlement records. Required: see keeperFromEnv. */
  databaseUrl: string | undefined;
  rpcUrl: string;
  /**
   * RPC for the ledger's history scan, which reads the vault's whole life rather than the last few
   * seconds. Falls back to rpcUrl. On testnet, drpc serves about 100 blocks per log query and Arc's
   * own RPC serves 10,000, so pointing this at Arc's cuts a backfill from hours to minutes.
   */
  logsRpcUrl?: string | undefined;
  /** The block the current vault was deployed in, where the ledger's history starts. */
  vaultDeployBlock?: bigint | undefined;
  /** How often to reconcile. Five minutes by default. */
  reconcileIntervalMs?: number;
  log?: (message: string) => void;
  pollIntervalMs?: number;
}

function arcClient(url: string): PublicClient {
  const arc = chainFor(ARC_DOMAIN);
  return createPublicClient({
    chain: { id: arc.chainId, name: arc.name, nativeCurrency: arc.nativeCurrency, rpcUrls: { default: { http: [url] } } },
    transport: http(url, { retryCount: 3, retryDelay: 1_500, timeout: 30_000 }),
  }) as PublicClient;
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
  const client = arcClient(opts.rpcUrl);

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

  const settling = createKeeper({ watcher, engine, log });

  // ---- the ledger and the reconciler -----------------------------------------------------------
  //
  // The settling watcher starts at the head, deliberately, so it never re-pays history. That also
  // means it never sees a release that happened while no keeper ran. The ledger watcher covers that
  // gap: its own cursor, starting at the vault's deploy block, recording releases and paying nothing.
  const vault = currentVaultAddress();
  const ledger = new ReleaseLedger({ connectionString: opts.databaseUrl });
  await ledger.migrate();
  const logsClient = opts.logsRpcUrl ? arcClient(opts.logsRpcUrl) : client;
  let ledgerFrom = opts.vaultDeployBlock;
  if (ledgerFrom === undefined) {
    ledgerFrom = await client.getBlockNumber();
    log(
      `ledger: vault deploy block not configured, so history before block ${ledgerFrom} is not checked. ` +
        `Set POLICY_VAULT_V4_DEPLOY_BLOCK to cover releases made while no keeper was running.`,
    );
  }
  const ledgerWatcher = new EventWatcher({
    client: logsClient,
    vaultAddress: vault,
    cursors: new CursorStore(join(opts.stateDir, "ledger-cursor.json")),
    deployBlock: ledgerFrom,
    confirmations: 2n,
    // Not latency critical: reconciliation runs every few minutes anyway.
    pollIntervalMs: 15_000,
    log: (m) => log(`ledger: ${m}`),
  });
  /** Block time for the ledger, best effort. A missing time only delays an alert by the grace period. */
  const blockTime = async (n: bigint) => {
    try {
      return new Date(Number((await client.getBlock({ blockNumber: n })).timestamp) * 1000);
    } catch {
      return null;
    }
  };

  const notifier = notifierFromEnv(process.env, log);
  const reconciler = new Reconciler({
    ledger,
    notifier,
    txUrl: (h) => chainFor(ARC_DOMAIN).explorerTxUrl(h),
    labelFor: (v) => labelForAddress(v),
    keeperLag: async () => {
      const at = cursors.peek();
      if (at === undefined) return null;
      const head = await client.getBlockNumber();
      return head > at ? head - at : 0n;
    },
    log,
  });

  const interval = opts.reconcileIntervalMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let first: ReturnType<typeof setTimeout> | undefined;
  const reconcile = async () => {
    try {
      const r = await reconciler.runOnce();
      if (r.alerted || r.cleared || r.lag === "alerted" || r.lag === "recovered") {
        log(`reconciler: ${r.alerted} new alert(s), ${r.cleared} cleared, keeper lag ${r.lag}`);
      }
    } catch (err) {
      log(`reconciler: pass failed, will retry: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    async start() {
      await settling.start();
      log(`reconciler: every ${Math.round(interval / 60_000)} min, alerts to ${notifier.describe}`);
      void ledgerWatcher.run(
        async (p) => ledger.record(p, await blockTime(p.releaseBlockNumber)),
        (err) => log(`ledger: scan error, will retry: ${err instanceof Error ? err.message : String(err)}`),
      );
      // The first pass waits a minute, so it reports a ledger the backfill has had time to fill.
      first = setTimeout(reconcile, 60_000);
      timer = setInterval(reconcile, interval);
    },
    stop() {
      settling.stop();
      ledgerWatcher.stop();
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
    },
    finished: settling.finished,
  };
}
