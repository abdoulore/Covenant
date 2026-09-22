/**
 * Watches PolicyVault for PolicyReleased and hands each release to a processor.
 *
 * Design notes that are not obvious from the code:
 *
 * - Scanning is cursor based, not filter based. See CursorStore for why.
 * - A confirmation lag is subtracted from the chain head before scanning. Arc has deterministic
 *   finality, so this is small, but scanning right up to the head means re-reading blocks that
 *   can still move and handing the processor an event that later vanishes.
 * - The cursor advances only after every event in a chunk has been handed over and the processor
 *   has returned. A crash replays the chunk; SettlementStore rejects the duplicate claim. Replay
 *   costs a wasted scan, a skipped event costs a recipient their money.
 */

import { decodeEventLog, parseAbi, type Log, type PublicClient } from "viem";
import { chunkRange, CursorStore } from "../store/CursorStore.js";
import { chainFor } from "../config.js";
import type { PayoutCurrency, ReleasedPolicy } from "../types.js";

export const POLICY_RELEASED_ABI = parseAbi([
  "event PolicyReleased(uint256 indexed policyId, address indexed recipient, uint256 amount, uint8 payoutCurrency, uint32 destinationDomain, address executor, uint256 periodIndex)",
]);

/** keccak of the event signature. Precomputed so a scan does not recompute it per poll. */
export const POLICY_RELEASED_TOPIC =
  "0x97fc1c5f4253ada03006e90ee82795a83a117f3e486cb905ee56667653862086" as const;

/** Mirrors PolicyVault.PayoutCurrency. Index is the onchain enum value. */
const PAYOUT_CURRENCIES: PayoutCurrency[] = ["USDC", "EURC"];

export interface EventWatcherOptions {
  client: PublicClient;
  vaultAddress: `0x${string}`;
  cursors: CursorStore;
  /** Block the vault was deployed in. First scan starts here, never at the chain head. */
  deployBlock: bigint;
  /**
   * The largest range to ask for. Arc's own RPC serves 10,000 blocks (V15); this is a ceiling, not
   * a promise, because providers set their own limits and change them. See `span` below.
   */
  maxSpan?: bigint;
  /** Blocks to stay behind the head. Arc finality is deterministic, so this can be small. */
  confirmations?: bigint;
  pollIntervalMs?: number;
  /** Where to report range and backoff changes. Silent by default. */
  log?: (message: string) => void;
}

/** Never shrink a query below this. A provider refusing a range this small has another problem. */
const MIN_SPAN = 10n;
/** Successful chunks before trying a larger range again. */
const GROW_AFTER = 100;
/** Ceiling on the wait between failing polls. */
const MAX_BACKOFF_MS = 60_000;

/** Every message a viem error carries, including its causes, as one string to classify. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  for (let e: any = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    parts.push(String(e.details ?? ""), String(e.shortMessage ?? ""), String(e.message ?? ""));
  }
  return parts.join(" ");
}

/**
 * How a failed getLogs should be handled.
 *
 * `range`: the provider refused the size of the query. Shrink it and retry at once.
 * `rate`: the provider is throttling. Shrinking would only make more requests; back off instead.
 * `other`: not ours to interpret. Surface it.
 *
 * Rate limits are checked first because some providers word them as a limit being exceeded, and
 * shrinking in response to a rate limit makes it worse.
 */
export function classifyLogsError(err: unknown): "range" | "rate" | "other" {
  const text = errorText(err);
  if (/rate limit|too many requests|\b429\b/i.test(text)) return "rate";
  if (/block range|ranges? over|blocks? (are|is) not supported|range (is )?too (large|wide)|more than \d+ (results|logs)|response size|query returned more than/i.test(text)) return "range";
  return "other";
}

export class EventWatcher {
  private readonly client: PublicClient;
  private readonly vaultAddress: `0x${string}`;
  private readonly cursors: CursorStore;
  private readonly deployBlock: bigint;
  private readonly maxSpan: bigint;
  private readonly confirmations: bigint;
  private readonly pollIntervalMs: number;
  private readonly log: (message: string) => void;
  /**
   * The range currently asked for, which can shrink below maxSpan.
   *
   * drpc's free plan cut its getLogs limit from 10,000 blocks to about 100 without notice. A
   * watcher with a fixed range kept working while it polled every few seconds, then stalled for
   * good after any pause longer than a minute: the catch-up request was refused, and retried
   * unchanged forever, while releases piled up unpaid behind it. Learning the limit from the
   * refusal means a provider changing its terms costs some speed, not settlement.
   */
  private span: bigint;
  private successesAtSpan = 0;
  private stopped = false;

  constructor(opts: EventWatcherOptions) {
    this.client = opts.client;
    this.vaultAddress = opts.vaultAddress;
    this.cursors = opts.cursors;
    this.deployBlock = opts.deployBlock;
    this.maxSpan = opts.maxSpan ?? 10_000n;
    this.confirmations = opts.confirmations ?? 2n;
    this.pollIntervalMs = opts.pollIntervalMs ?? 4_000;
    this.log = opts.log ?? (() => {});
    this.span = this.maxSpan;

    if (this.maxSpan > 10_000n) {
      throw new Error(`maxSpan ${this.maxSpan} exceeds Arc's 10,000 block getLogs cap`);
    }
  }

  /**
   * Scan once, from the cursor to the safe head.
   *
   * @returns the number of releases handed to the processor.
   */
  async scanOnce(onRelease: (policy: ReleasedPolicy) => Promise<void>): Promise<number> {
    const lastProcessed = await this.cursors.load(this.deployBlock);
    const head = await this.client.getBlockNumber();
    const safeHead = head > this.confirmations ? head - this.confirmations : 0n;

    const from = lastProcessed + 1n;
    if (safeHead < from) return 0;

    let handled = 0;
    let cursor = from;
    while (cursor <= safeHead) {
      const end = cursor + this.span - 1n;
      const chunk = { from: cursor, to: end > safeHead ? safeHead : end };

      let logs;
      try {
        logs = await this.client.getLogs({
          address: this.vaultAddress,
          event: POLICY_RELEASED_ABI[0],
          fromBlock: chunk.from,
          toBlock: chunk.to,
        });
      } catch (err) {
        if (classifyLogsError(err) === "range" && this.span > MIN_SPAN) {
          const smaller = this.span / 2n > MIN_SPAN ? this.span / 2n : MIN_SPAN;
          this.log(`watcher: provider refused ${this.span} blocks per query, retrying with ${smaller}`);
          this.span = smaller;
          this.successesAtSpan = 0;
          continue;
        }
        throw err;
      }

      // Order matters. Logs within a chunk must be replayed in chain order so that settlements
      // are attempted in the order the vault released them.
      const ordered = [...logs].sort(compareLogPosition);

      for (const log of ordered) {
        await onRelease(this.decode(log));
        handled++;
      }

      // Only now is this range durably done. Advancing per chunk rather than per full scan keeps
      // the replay window bounded by one chunk after a crash.
      await this.cursors.set(chunk.to);
      cursor = chunk.to + 1n;

      // Probe back up now and then, so a provider that raises its limit, or a one-off refusal,
      // does not leave a catch-up crawling at the smallest size forever.
      if (this.span < this.maxSpan && ++this.successesAtSpan >= GROW_AFTER) {
        this.span = this.span * 2n < this.maxSpan ? this.span * 2n : this.maxSpan;
        this.successesAtSpan = 0;
      }
    }

    return handled;
  }

  /** Poll until stop() is called. Errors propagate to the caller's handler, they are not swallowed. */
  async run(
    onRelease: (policy: ReleasedPolicy) => Promise<void>,
    onError?: (err: unknown) => void,
  ): Promise<void> {
    this.stopped = false;
    let failures = 0;
    while (!this.stopped) {
      try {
        await this.scanOnce(onRelease);
        failures = 0;
      } catch (err) {
        if (!onError) throw err;
        onError(err);
        failures++;
      }
      // Back off while polls keep failing, so a throttled provider gets room rather than a request
      // every few seconds. The cursor is durable, so waiting loses nothing; it only delays.
      const wait = failures === 0 ? this.pollIntervalMs : Math.min(this.pollIntervalMs * 2 ** failures, MAX_BACKOFF_MS);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private decode(log: Log): ReleasedPolicy {
    return decodeReleaseLog(log, this.vaultAddress);
  }
}

/**
 * A PolicyReleased log as the engine's input. Shared by the watcher and by manual recovery, so a
 * release paid by hand is read exactly the way the keeper would have read it.
 */
export function decodeReleaseLog(log: Log, fallbackVault?: string): ReleasedPolicy {
  const { args } = decodeEventLog({
    abi: POLICY_RELEASED_ABI,
    data: log.data,
    topics: log.topics,
  });

  const currency = PAYOUT_CURRENCIES[Number(args.payoutCurrency)];
  if (!currency) {
    throw new Error(
      `Unknown payoutCurrency ${args.payoutCurrency} in policy ${args.policyId}. ` +
        `The contract enum has gained a value the executor does not know how to route.`,
    );
  }

  const destinationDomain = Number(args.destinationDomain);
  // Fail here rather than deep inside an SDK call, so an unroutable release is legible.
  chainFor(destinationDomain);

  const vault = log.address ?? fallbackVault;
  if (!vault) throw new Error("A release log without an address cannot say which vault emitted it.");

  return {
    // From the log itself, not from configuration: the vault that emitted the event is the one
    // whose numbering this policy id belongs to.
    vault: vault.toLowerCase(),
    policyId: args.policyId.toString(),
    periodIndex: Number(args.periodIndex),
    recipient: args.recipient,
    amount: args.amount.toString(),
    payoutCurrency: currency,
    destinationDomain,
    executor: args.executor,
    releaseTxHash: log.transactionHash ?? "",
    releaseBlockNumber: log.blockNumber ?? 0n,
  };
}

/** Chain order within a scan: block, then position in block. */
function compareLogPosition(a: Log, b: Log): number {
  const blockDelta = (a.blockNumber ?? 0n) - (b.blockNumber ?? 0n);
  if (blockDelta !== 0n) return blockDelta > 0n ? 1 : -1;
  return (a.logIndex ?? 0) - (b.logIndex ?? 0);
}
