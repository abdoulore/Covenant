/**
 * The oracle keeper.
 *
 * Oracle conditions are the one condition type that can turn releasable with no transaction: a
 * price moves and the vault's checkCondition flips to true on its own. Nothing onchain notices.
 * Chainlink Automation, which would, is not available on Arc, so this keeper is the thing that
 * notices. It watches for oracle policies, and when one becomes releasable it calls release,
 * which is permissionless. From there the existing PolicyReleased flow settles it as usual.
 *
 * With a pull oracle (Pyth on Arc) there is no live price onchain to read: the keeper must post a
 * fresh signed price before checkCondition can see it. When a Pyth client is configured, the keeper
 * fetches the price offchain, keyless, and only when it will cross the policy's threshold does it
 * pay to post it, then release. Without a Pyth client the keeper assumes a push feed and only reads.
 *
 * The keeper does not decide whether funds move. The vault does, in checkCondition. The keeper
 * only asks, and forwards a yes. If it asked wrongly, release reverts and nothing moves.
 *
 * Chain access is injected as a VaultReader so the logic here is testable without a node.
 */

import { chunkRange } from "../store/CursorStore.js";
import type { KeeperStore } from "./KeeperStore.js";

/** Mirrors PolicyVault.Status. Index is the onchain enum value. */
export enum PolicyStatus {
  Pending = 0,
  Releasable = 1,
  Executed = 2,
  Cancelled = 3,
}

/** PolicyVault.ConditionType.Oracle. */
export const ORACLE_CONDITION_TYPE = 3;

export interface CreatedPolicy {
  policyId: bigint;
  conditionType: number;
}

/** The onchain operations the keeper needs. Injected so tests use a fake, not a live chain. */
export interface VaultReader {
  blockNumber(): Promise<bigint>;
  /** PolicyCreated events in an inclusive block range. */
  scanCreatedPolicies(from: bigint, to: bigint): Promise<CreatedPolicy[]>;
  /** Effective status, which resolves to Releasable only when condition-met AND funded. */
  statusOf(policyId: bigint): Promise<PolicyStatus>;
  /** Send a release transaction, returning its hash. Permissionless onchain. */
  release(policyId: bigint): Promise<string>;
  /**
   * Oracle configuration for a policy. `priceId` is the Pyth feed id when the policy's feed is a
   * Pyth wrapper (PythAggregatorV3), or null for a plain push feed, which needs no offchain refresh.
   */
  oracleParams(policyId: bigint): Promise<OracleParams>;
  /** Refresh a Pyth-backed feed onchain (updateFeeds, paying the update fee), returning the tx hash. */
  refreshFeed(feed: `0x${string}`, updateData: `0x${string}`[]): Promise<string>;
}

/** PolicyVault.Comparator.Gte. Lte is 1. */
export const COMPARATOR_GTE = 0;

export interface OracleParams {
  feed: `0x${string}`;
  /** Pyth feed id if the feed is a Pyth wrapper, else null. */
  priceId: `0x${string}` | null;
  comparator: number;
  /** Threshold in the feed's own decimals, the same scale Pyth reports the price in. */
  threshold: bigint;
}

export interface PythPrice {
  /** Latest price in the feed's decimals (the raw Pyth integer). */
  price: bigint;
  /** The signed update blob to submit onchain. */
  updateData: `0x${string}`[];
}

/** Offchain Pyth price source, keyless (Hermes in production, a fake in tests). */
export interface PythClient {
  fetch(priceId: string): Promise<PythPrice>;
}

export interface OracleKeeperOptions {
  reader: VaultReader;
  store: KeeperStore;
  deployBlock: bigint;
  maxSpan?: bigint;
  confirmations?: bigint;
  pollIntervalMs?: number;
  log?: (message: string) => void;
  /** Offchain price source for pull oracles. When absent, the keeper only reads (push-feed mode). */
  pyth?: PythClient;
}

export interface ReleaseOutcome {
  policyId: string;
  txHash: string;
}

export class OracleKeeper {
  private readonly reader: VaultReader;
  private readonly store: KeeperStore;
  private readonly deployBlock: bigint;
  private readonly maxSpan: bigint;
  private readonly confirmations: bigint;
  private readonly pollIntervalMs: number;
  private readonly log: (message: string) => void;
  private readonly pyth?: PythClient;
  private stopped = false;

  constructor(opts: OracleKeeperOptions) {
    this.reader = opts.reader;
    this.store = opts.store;
    this.deployBlock = opts.deployBlock;
    this.maxSpan = opts.maxSpan ?? 10_000n;
    this.confirmations = opts.confirmations ?? 2n;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    this.log = opts.log ?? (() => {});
    this.pyth = opts.pyth;

    if (this.maxSpan > 10_000n) {
      throw new Error(`maxSpan ${this.maxSpan} exceeds Arc's 10,000 block getLogs cap`);
    }
  }

  /** One full pass: discover new oracle policies, then release any that are now releasable. */
  async tick(): Promise<ReleaseOutcome[]> {
    await this.discover();
    return this.releasePass();
  }

  /** Scan PolicyCreated forward from the cursor and record any oracle policies found. */
  private async discover(): Promise<void> {
    const last = await this.store.getCursor(this.deployBlock);
    const head = await this.reader.blockNumber();
    const safeHead = head > this.confirmations ? head - this.confirmations : 0n;

    const from = last + 1n;
    if (safeHead < from) return;

    for (const chunk of chunkRange(from, safeHead, this.maxSpan)) {
      const created = await this.reader.scanCreatedPolicies(chunk.from, chunk.to);
      for (const c of created) {
        if (c.conditionType === ORACLE_CONDITION_TYPE) {
          await this.store.addOraclePolicy(c.policyId);
        }
      }
      // Advance only after the chunk is recorded, so a crash rescans it rather than skipping it.
      await this.store.setCursor(chunk.to);
    }
  }

  /** Check each tracked oracle policy and release the ones that are ready. */
  private async releasePass(): Promise<ReleaseOutcome[]> {
    const ids = await this.store.listOraclePolicies();
    const outcomes: ReleaseOutcome[] = [];

    for (const id of ids) {
      if (await this.store.isHandled(id)) continue;

      let status: PolicyStatus;
      try {
        status = await this.reader.statusOf(id);
      } catch (err) {
        this.log(`oracle policy ${id}: status read failed, will retry: ${message(err)}`);
        continue;
      }

      if (status === PolicyStatus.Executed || status === PolicyStatus.Cancelled) {
        // Terminal, whoever got there. Stop watching it.
        await this.store.markHandled(id);
        continue;
      }

      // Pull oracles (Pyth) hold no live price onchain, so the status read above is stale and will
      // not flip on its own. When a Pyth client is configured and the policy's feed is a Pyth
      // wrapper, refresh it here first, but only after a free offchain price check says the
      // threshold will cross, so the keeper never pays to refresh a feed that will not release.
      if (this.pyth) {
        let params: OracleParams;
        try {
          params = await this.reader.oracleParams(id);
        } catch (err) {
          this.log(`oracle policy ${id}: oracle params read failed, will retry: ${message(err)}`);
          continue;
        }

        if (params.priceId) {
          let price: PythPrice;
          try {
            price = await this.pyth.fetch(params.priceId);
          } catch (err) {
            this.log(`oracle policy ${id}: price fetch failed, will retry: ${message(err)}`);
            continue;
          }

          const crosses =
            params.comparator === COMPARATOR_GTE
              ? price.price >= params.threshold
              : price.price <= params.threshold;
          if (!crosses) {
            this.log(`oracle policy ${id}: price ${price.price} does not cross ${params.threshold}, not refreshing`);
            continue;
          }

          try {
            const refreshTx = await this.reader.refreshFeed(params.feed, price.updateData);
            this.log(`oracle policy ${id}: refreshed Pyth feed in ${refreshTx}`);
          } catch (err) {
            this.log(`oracle policy ${id}: feed refresh failed, will retry: ${message(err)}`);
            continue;
          }

          // Re-read against the freshly posted price. checkCondition is still the authority.
          try {
            status = await this.reader.statusOf(id);
          } catch (err) {
            this.log(`oracle policy ${id}: status read after refresh failed, will retry: ${message(err)}`);
            continue;
          }
        }
        // params.priceId null: a plain push feed, which needs no refresh; use the status read above.
      }

      if (status !== PolicyStatus.Releasable) continue; // not funded yet, or the price moved back

      try {
        const txHash = await this.reader.release(id);
        await this.store.markHandled(id);
        outcomes.push({ policyId: id.toString(), txHash });
        this.log(`oracle policy ${id}: condition met, released in ${txHash}`);
      } catch (err) {
        // Do not mark handled. The price may have moved back between the read and the send, in
        // which case release reverts ConditionNotMet and the next tick re-evaluates correctly.
        this.log(`oracle policy ${id}: release attempt failed, will retry: ${message(err)}`);
      }
    }

    return outcomes;
  }

  /** Poll until stop() is called. Per-tick errors go to onError rather than ending the loop. */
  async run(onError?: (err: unknown) => void): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (err) {
        if (!onError) throw err;
        onError(err);
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
