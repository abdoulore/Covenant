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
  "event PolicyReleased(uint256 indexed policyId, address indexed recipient, uint256 amount, uint8 payoutCurrency, uint32 destinationDomain, address executor)",
]);

/** keccak of the event signature. Precomputed so a scan does not recompute it per poll. */
export const POLICY_RELEASED_TOPIC =
  "0x462d3ae2ab13c633cacd14662ba357e3309e06043c193d8632960dc0e1336820" as const;

/** Mirrors PolicyVault.PayoutCurrency. Index is the onchain enum value. */
const PAYOUT_CURRENCIES: PayoutCurrency[] = ["USDC", "EURC"];

export interface EventWatcherOptions {
  client: PublicClient;
  vaultAddress: `0x${string}`;
  cursors: CursorStore;
  /** Block the vault was deployed in. First scan starts here, never at the chain head. */
  deployBlock: bigint;
  /** Arc caps getLogs at 10,000 blocks (V15). Kept configurable, never larger than that. */
  maxSpan?: bigint;
  /** Blocks to stay behind the head. Arc finality is deterministic, so this can be small. */
  confirmations?: bigint;
  pollIntervalMs?: number;
}

export class EventWatcher {
  private readonly client: PublicClient;
  private readonly vaultAddress: `0x${string}`;
  private readonly cursors: CursorStore;
  private readonly deployBlock: bigint;
  private readonly maxSpan: bigint;
  private readonly confirmations: bigint;
  private readonly pollIntervalMs: number;
  private stopped = false;

  constructor(opts: EventWatcherOptions) {
    this.client = opts.client;
    this.vaultAddress = opts.vaultAddress;
    this.cursors = opts.cursors;
    this.deployBlock = opts.deployBlock;
    this.maxSpan = opts.maxSpan ?? 10_000n;
    this.confirmations = opts.confirmations ?? 2n;
    this.pollIntervalMs = opts.pollIntervalMs ?? 4_000;

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
    for (const chunk of chunkRange(from, safeHead, this.maxSpan)) {
      const logs = await this.client.getLogs({
        address: this.vaultAddress,
        event: POLICY_RELEASED_ABI[0],
        fromBlock: chunk.from,
        toBlock: chunk.to,
      });

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
    }

    return handled;
  }

  /** Poll until stop() is called. Errors propagate to the caller's handler, they are not swallowed. */
  async run(
    onRelease: (policy: ReleasedPolicy) => Promise<void>,
    onError?: (err: unknown) => void,
  ): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        await this.scanOnce(onRelease);
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

  private decode(log: Log): ReleasedPolicy {
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

    return {
      policyId: args.policyId.toString(),
      recipient: args.recipient,
      amount: args.amount.toString(),
      payoutCurrency: currency,
      destinationDomain,
      executor: args.executor,
      releaseTxHash: log.transactionHash ?? "",
      releaseBlockNumber: log.blockNumber ?? 0n,
    };
  }
}

/** Chain order within a scan: block, then position in block. */
function compareLogPosition(a: Log, b: Log): number {
  const blockDelta = (a.blockNumber ?? 0n) - (b.blockNumber ?? 0n);
  if (blockDelta !== 0n) return blockDelta > 0n ? 1 : -1;
  return (a.logIndex ?? 0) - (b.logIndex ?? 0);
}
