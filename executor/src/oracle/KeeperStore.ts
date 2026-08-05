/**
 * Persisted state for the oracle keeper.
 *
 * Three things must survive a restart, or the keeper misbehaves:
 *
 * - The discovery cursor: the last block scanned for PolicyCreated. Without it, a restart either
 *   rescans from deployment every tick (expensive, and bounded by Arc's 10,000 block getLogs cap)
 *   or, if it started at the head, never discovers the oracle policies created while it was down.
 * - The set of oracle policy ids found so far. The cursor advances past the blocks that created
 *   them, so they cannot be rediscovered from logs; they have to be remembered.
 * - The set of policies already handled (released by us, or seen terminal). This is what stops the
 *   keeper from firing a second release. The contract also rejects a double release, so this is an
 *   optimisation against wasted transactions, not the only guard.
 *
 * One process is assumed, as with the settlement store. Two keepers against one file would race.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface KeeperShape {
  version: 1;
  /** Last block scanned for PolicyCreated. Empty means nothing scanned yet. */
  cursor: string | null;
  /** Oracle policy ids discovered, as decimal strings. */
  oracleIds: string[];
  /** Policy ids the keeper is done with: released by us, or observed terminal. */
  handled: string[];
}

const EMPTY: KeeperShape = { version: 1, cursor: null, oracleIds: [], handled: [] };

export class KeeperStore {
  private data: KeeperShape | undefined;
  /** Serialises writes so concurrent updates cannot interleave a read-modify-write. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  static defaultPath(): string {
    return join(process.cwd(), ".state", "oracle-keeper.json");
  }

  private async load(): Promise<KeeperShape> {
    if (this.data) return this.data;
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.data = JSON.parse(raw) as KeeperShape;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.data = structuredClone(EMPTY);
    }
    return this.data;
  }

  /** Last scanned block, or `deployBlock - 1` the first time so scanning starts at deployBlock. */
  async getCursor(deployBlock: bigint): Promise<bigint> {
    const data = await this.load();
    if (data.cursor === null) return deployBlock > 0n ? deployBlock - 1n : 0n;
    return BigInt(data.cursor);
  }

  async setCursor(block: bigint): Promise<void> {
    const data = await this.load();
    if (data.cursor !== null && block < BigInt(data.cursor)) {
      throw new Error(
        `Refusing to move the discovery cursor backwards, from ${data.cursor} to ${block}. ` +
          `Rewinding would rediscover policies already tracked; delete ${this.filePath} to reset deliberately.`,
      );
    }
    data.cursor = block.toString();
    await this.persist();
  }

  async addOraclePolicy(policyId: bigint): Promise<void> {
    const data = await this.load();
    const id = policyId.toString();
    if (!data.oracleIds.includes(id)) {
      data.oracleIds.push(id);
      await this.persist();
    }
  }

  async listOraclePolicies(): Promise<bigint[]> {
    const data = await this.load();
    return data.oracleIds.map(BigInt);
  }

  /**
   * Generic aliases. The tracked-id set serves any keeper that owns this store file, not only the
   * oracle keeper. The scheduler keeper tracks recurring policies through the same mechanism, in its
   * own store file.
   */
  async track(policyId: bigint): Promise<void> {
    return this.addOraclePolicy(policyId);
  }

  async tracked(): Promise<bigint[]> {
    return this.listOraclePolicies();
  }

  async isHandled(policyId: bigint): Promise<boolean> {
    const data = await this.load();
    return data.handled.includes(policyId.toString());
  }

  async markHandled(policyId: bigint): Promise<void> {
    const data = await this.load();
    const id = policyId.toString();
    if (!data.handled.includes(id)) {
      data.handled.push(id);
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, snapshot, "utf8");
      await rename(tmp, this.filePath);
    });
    await this.writeChain;
  }
}
