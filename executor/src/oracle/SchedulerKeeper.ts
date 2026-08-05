/**
 * The scheduler keeper.
 *
 * Recurring policies (payroll, sweep) release a slice each interval through releasePeriod, which
 * nothing onchain calls on its own. This keeper is that caller. It discovers recurring policies, and
 * each tick releases every period that is due, one call at a time, catching up after downtime.
 * releasePeriod is permissionless, so the keeper is a convenience: a missed tick delays a payment,
 * never loses it, and anyone can trigger a due period.
 *
 * A period overdue beyond its maxCatchUp is held by the contract (CatchUpStale) for the owner's
 * approveStalePeriod. isPeriodDue is false for such a period, so the keeper does not release it. It
 * alerts instead and leaves the decision to the owner, which is the treasury-safe default.
 *
 * Chain access is injected as a SchedulerReader so the logic here is testable without a node. It
 * mirrors OracleKeeper and reuses the same KeeperStore, in its own store file.
 */

import { chunkRange } from "../store/CursorStore.js";
import type { KeeperStore } from "./KeeperStore.js";
import { PolicyStatus, type CreatedPolicy } from "./OracleKeeper.js";

/** The onchain operations the scheduler keeper needs. Injected so tests use a fake, not a chain. */
export interface SchedulerReader {
  blockNumber(): Promise<bigint>;
  /** PolicyCreated events in an inclusive block range. */
  scanCreatedPolicies(from: bigint, to: bigint): Promise<CreatedPolicy[]>;
  /** True if the policy is a recurring (payroll or sweep) policy. */
  isRecurring(policyId: bigint): Promise<boolean>;
  /** Effective status. Executed or Cancelled means retire it. */
  statusOf(policyId: bigint): Promise<PolicyStatus>;
  /** True when a period is due now and within its catch-up bound. */
  isPeriodDue(policyId: bigint): Promise<boolean>;
  /** True when a period is due but overdue beyond maxCatchUp: held for owner approval, not released. */
  isStale(policyId: bigint): Promise<boolean>;
  /** Send a releasePeriod transaction, returning its hash. Permissionless onchain. */
  releasePeriod(policyId: bigint): Promise<string>;
}

export interface SchedulerKeeperOptions {
  reader: SchedulerReader;
  store: KeeperStore;
  deployBlock: bigint;
  maxSpan?: bigint;
  confirmations?: bigint;
  /** Cap on periods released for one policy in a single tick, so catch-up stays bounded. */
  maxCatchUpPerTick?: number;
  pollIntervalMs?: number;
  log?: (message: string) => void;
}

export interface ReleaseOutcome {
  policyId: string;
  /** One hash per period released this tick. Catch-up can release several. */
  periodTxHashes: string[];
}

export class SchedulerKeeper {
  private readonly reader: SchedulerReader;
  private readonly store: KeeperStore;
  private readonly deployBlock: bigint;
  private readonly maxSpan: bigint;
  private readonly confirmations: bigint;
  private readonly maxCatchUpPerTick: number;
  private readonly pollIntervalMs: number;
  private readonly log: (message: string) => void;
  private stopped = false;

  constructor(opts: SchedulerKeeperOptions) {
    this.reader = opts.reader;
    this.store = opts.store;
    this.deployBlock = opts.deployBlock;
    this.maxSpan = opts.maxSpan ?? 10_000n;
    this.confirmations = opts.confirmations ?? 2n;
    this.maxCatchUpPerTick = opts.maxCatchUpPerTick ?? 50;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    this.log = opts.log ?? (() => {});

    if (this.maxSpan > 10_000n) {
      throw new Error(`maxSpan ${this.maxSpan} exceeds Arc's 10,000 block getLogs cap`);
    }
  }

  /** One full pass: discover new recurring policies, then release any due periods. */
  async tick(): Promise<ReleaseOutcome[]> {
    await this.discover();
    return this.releasePass();
  }

  /** Scan PolicyCreated forward from the cursor and record any recurring policies found. */
  private async discover(): Promise<void> {
    const last = await this.store.getCursor(this.deployBlock);
    const head = await this.reader.blockNumber();
    const safeHead = head > this.confirmations ? head - this.confirmations : 0n;

    const from = last + 1n;
    if (safeHead < from) return;

    for (const chunk of chunkRange(from, safeHead, this.maxSpan)) {
      const created = await this.reader.scanCreatedPolicies(chunk.from, chunk.to);
      for (const c of created) {
        // PolicyCreated does not carry the recurring flag, so ask the vault directly.
        if (await this.reader.isRecurring(c.policyId)) {
          await this.store.track(c.policyId);
        }
      }
      await this.store.setCursor(chunk.to);
    }
  }

  /** Release every due period of each tracked policy, up to the per-tick cap. */
  private async releasePass(): Promise<ReleaseOutcome[]> {
    const ids = await this.store.tracked();
    const outcomes: ReleaseOutcome[] = [];

    for (const id of ids) {
      if (await this.store.isHandled(id)) continue;

      let status: PolicyStatus;
      try {
        status = await this.reader.statusOf(id);
      } catch (err) {
        this.log(`recurring policy ${id}: status read failed, will retry: ${message(err)}`);
        continue;
      }

      if (status === PolicyStatus.Executed || status === PolicyStatus.Cancelled) {
        // A finished payroll or a cancelled policy. Stop watching it.
        await this.store.markHandled(id);
        continue;
      }

      const hashes = await this.releaseDuePeriods(id);
      if (hashes.length > 0) {
        outcomes.push({ policyId: id.toString(), periodTxHashes: hashes });
        continue;
      }

      // Nothing was due to release. If a period is nonetheless overdue past its bound, it is being
      // held for the owner. Alert, and leave it: the keeper never forces a stale payment.
      try {
        if (await this.reader.isStale(id)) {
          this.log(
            `recurring policy ${id}: a period is overdue beyond maxCatchUp, holding for ` +
              `approveStalePeriod by the owner`,
          );
        }
      } catch {
        // Alerting is best-effort; a failed staleness read is not worth aborting the pass.
      }
    }

    return outcomes;
  }

  /** Release due periods one at a time until none is due or the per-tick cap is hit. */
  private async releaseDuePeriods(id: bigint): Promise<string[]> {
    const hashes: string[] = [];
    while (hashes.length < this.maxCatchUpPerTick) {
      let due: boolean;
      try {
        due = await this.reader.isPeriodDue(id);
      } catch (err) {
        this.log(`recurring policy ${id}: due check failed, will retry: ${message(err)}`);
        break;
      }
      if (!due) break;

      try {
        const txHash = await this.reader.releasePeriod(id);
        hashes.push(txHash);
        this.log(`recurring policy ${id}: released a period in ${txHash}`);
      } catch (err) {
        // Underfunded, or the schedule moved between the check and the send. Stop and retry next
        // tick, do not mark handled: the policy is still active.
        this.log(`recurring policy ${id}: releasePeriod failed, will retry: ${message(err)}`);
        break;
      }
    }
    return hashes;
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
