/**
 * The keeper: the process that turns a release on chain into a paid recipient, continuously.
 *
 * Everything it needs already existed. EventWatcher polls for PolicyReleased from a persisted
 * cursor, and SettlementEngine settles one release with claim-before-work ordering. What was
 * missing was something to hold them together and keep running, because until now the engine was
 * only ever driven by a demo script that created its own policy, settled it, and exited. A deployed
 * API therefore served an empty Settlements tab: nothing on the server ever wrote a receipt.
 *
 * The whole file is dependency-injected. `createKeeper` takes an already-built watcher and engine
 * so the loop can be tested with stubs and no chain, and `keeperFromEnv` does the real wiring.
 */
import type { ReleasedPolicy, SettlementRecord } from "../types.js";

/** The slice of EventWatcher the keeper uses. */
export interface WatcherLike {
  run(onRelease: (policy: ReleasedPolicy) => Promise<void>, onError?: (err: unknown) => void): Promise<void>;
  stop(): void;
}

/** The slice of SettlementEngine the keeper uses. */
export interface EngineLike {
  settle(policy: ReleasedPolicy): Promise<SettlementRecord | undefined>;
  resumeInterrupted(): Promise<number>;
}

export interface KeeperDeps {
  watcher: WatcherLike;
  engine: EngineLike;
  log?: (message: string) => void;
}

export interface Keeper {
  /** Resume anything a crash left mid-flight, then watch until stopped. Resolves once watching starts. */
  start(): Promise<void>;
  stop(): void;
  /** Resolves when the watch loop exits, so a caller can await a clean shutdown. */
  readonly finished: Promise<void>;
}

export function createKeeper(deps: KeeperDeps): Keeper {
  const log = deps.log ?? (() => {});
  let resolveFinished: () => void;
  const finished = new Promise<void>((r) => { resolveFinished = r; });

  return {
    async start() {
      /**
       * Before watching, not after.
       *
       * A settlement interrupted by a restart has funds sitting in the executor wallet and a record
       * marked in progress. Resuming first means those are finished before any new release competes
       * for the same wallet balance.
       */
      const resumed = await deps.engine.resumeInterrupted();
      if (resumed > 0) log(`keeper: resumed ${resumed} interrupted settlement(s)`);

      /**
       * The loop is deliberately not awaited here: it runs until stop(). A settle that throws is
       * logged and the watch continues, because one unroutable release must not stop every later
       * one from being paid. The engine has already recorded the failure and will not silently
       * retry it.
       */
      void deps.watcher
        .run(
          async (policy) => {
            try {
              const record = await deps.engine.settle(policy);
              if (record) log(`keeper: policy ${policy.policyId} settled in ${record.durationMs}ms`);
            } catch (err) {
              log(`keeper: policy ${policy.policyId} failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          },
          (err) => log(`keeper: scan error, will retry: ${err instanceof Error ? err.message : String(err)}`),
        )
        .catch((err) => log(`keeper: watch loop exited: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => resolveFinished());

      log("keeper: watching for releases");
    },

    stop() {
      deps.watcher.stop();
    },

    finished,
  };
}

/**
 * Where a cold keeper starts scanning.
 *
 * At the chain head, never at the vault's deploy block, and this is the single most dangerous
 * decision in the file. The settlement store is per-deployment state: a keeper starting on a fresh
 * host has an empty one. Scanning from the deploy block would find every release the vault has ever
 * emitted, `tryClaim` would succeed on all of them because this store has never seen them, and the
 * engine would run the legs again. That is not a duplicated record, it is a second real payment to
 * every recipient already paid.
 *
 * The cost of starting at the head is that settlements completed before the keeper existed never
 * appear in its store. They are already published in docs/RESULTS.md with their hashes; a receipt
 * is not worth re-paying for.
 *
 * Only the first start is affected. Once a cursor exists it wins, so a restart resumes exactly
 * where it stopped and misses nothing.
 */
export async function coldStartBlock(
  getBlockNumber: () => Promise<bigint>,
  log: (message: string) => void = () => {},
): Promise<bigint> {
  const head = await getBlockNumber();
  log(`keeper: cold start would begin at block ${head} (the head, not the vault's deploy block)`);
  return head;
}
