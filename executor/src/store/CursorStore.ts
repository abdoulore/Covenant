/**
 * Persisted scan position for the event watcher.
 *
 * The executor finds work by scanning logs from a block cursor, not by holding a server-side
 * filter. Filters expire, do not survive a restart, and drop events silently when a poll is
 * missed. A persisted cursor is resumable by construction: the process can die at any point and
 * resume from the last block it actually finished, which is the property that matters for a
 * component that must never miss a release. See docs/VERIFICATIONS.md V15.
 *
 * The cursor is advanced only after a scanned range has been fully handed to the handler. Crashing
 * mid-range replays that range on restart, which is safe because SettlementStore.tryClaim rejects
 * a policy it has already seen. Replay is cheap; a skipped release is an unpaid recipient.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface CursorShape {
  version: 1;
  /** Last block whose logs have been fully processed. The next scan starts at this plus one. */
  lastProcessedBlock: string;
}

export class CursorStore {
  private value: bigint | undefined;

  constructor(private readonly filePath: string) {}

  static defaultPath(): string {
    return join(process.cwd(), ".state", "cursor.json");
  }

  /**
   * Read the stored cursor, falling back to `deployBlock` the first time.
   *
   * Starting from the deployment block rather than from the chain head matters: a fresh executor
   * pointed at the head would silently skip every release that happened before it started.
   */
  async load(deployBlock: bigint): Promise<bigint> {
    if (this.value !== undefined) return this.value;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as CursorShape;
      this.value = BigInt(parsed.lastProcessedBlock);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // No cursor yet. Treat the block before deployment as processed so scanning starts at
      // deployBlock itself and the vault's very first event is included.
      this.value = deployBlock > 0n ? deployBlock - 1n : 0n;
    }
    return this.value;
  }

  async set(block: bigint): Promise<void> {
    if (this.value !== undefined && block < this.value) {
      throw new Error(
        `Refusing to move cursor backwards, from ${this.value} to ${block}. ` +
          `Rewinding replays settlements; if that is intended, delete ${this.filePath} deliberately.`,
      );
    }
    this.value = block;
    const snapshot: CursorShape = { version: 1, lastProcessedBlock: block.toString() };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }
}

/**
 * Split a scan into provider-safe chunks.
 *
 * Arc caps eth_getLogs at 10,000 blocks, on Circle's endpoint and on drpc alike, so this is a
 * property of the chain rather than of a pricing tier (V15). At roughly 0.57 seconds per block
 * one window covers about 1.6 hours, so any executor downtime longer than that needs more than
 * one query to catch up.
 *
 * Ranges are inclusive at both ends.
 */
export function chunkRange(from: bigint, to: bigint, maxSpan: bigint): Array<{ from: bigint; to: bigint }> {
  if (to < from) return [];
  if (maxSpan <= 0n) throw new Error("maxSpan must be positive");

  const chunks: Array<{ from: bigint; to: bigint }> = [];
  let cursor = from;
  while (cursor <= to) {
    // minus one because both ends are inclusive: from..from+span-1 is span blocks, not span+1.
    const end = cursor + maxSpan - 1n;
    chunks.push({ from: cursor, to: end > to ? to : end });
    cursor = end + 1n;
  }
  return chunks;
}
