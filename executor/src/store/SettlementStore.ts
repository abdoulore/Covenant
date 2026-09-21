/**
 * Persistent settlement state.
 *
 * This is the idempotency boundary. Double payment on restart is the first thing that goes wrong
 * in event-driven payout systems, so the rule here is claim before work: a policy is recorded as
 * claimed before any funds move, and a claim that already exists is never re-processed.
 *
 * Two implementations share one contract, SettlementStoreLike:
 *
 * - SettlementStore, here: a JSON file per demo script. Kept for the demo scripts and the receipts
 *   they already wrote. New records are keyed with the vault; records written before D15 keep
 *   their old `policyId:periodIndex` key, and tryClaim handles them without guessing their vault.
 *   Single-process only, so it never backs the keeper.
 * - PostgresSettlementStore: keyed on (vault, policy id, period) with the database enforcing the
 *   uniqueness. What the keeper uses.
 *
 * The store owns its key format. The engine asks `keyFor` rather than building a key itself, so an
 * engine running against either store cannot drift from the key that store actually enforces.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  LegKind,
  ReleasedPolicy,
  SettlementLeg,
  SettlementRecord,
} from "../types.js";

interface StoreShape {
  version: 1;
  settlements: Record<string, SettlementRecord>;
}

/**
 * JSON.stringify throws on BigInt, and resumeState holds raw SDK results full of them.
 *
 * This is not a cosmetic fix. When persistence threw, a bridge that had already burned USDC on
 * chain was recorded as still pending, which would have re-run it and paid twice. Serialising
 * BigInt as a string keeps the record writable; SettlementEngine separately makes sure a
 * persistence failure can never look like an execution failure.
 */
function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

const EMPTY: StoreShape = { version: 1, settlements: {} };

/**
 * The store key for a settlement: one per release, so each period of a recurring policy settles
 * independently. Single-shot releases use period 0. Keying on policyId alone would make a recurring
 * policy's second period look already-claimed and never pay it.
 */
export function settlementKey(policyId: string, periodIndex: number): string {
  return `${policyId}:${periodIndex}`;
}

/** What identifies one settlement. Vault is optional only for receipts written before D15. */
export interface SettlementIdentity {
  vault?: string | undefined;
  policyId: string;
  periodIndex: number;
}

/** The contract the engine depends on. Both stores implement it. */
export interface SettlementStoreLike {
  /** The key this store enforces uniqueness on. Callers never build keys themselves. */
  keyFor(id: SettlementIdentity): string;
  tryClaim(policy: ReleasedPolicy, legs: LegKind[], releaseExplorerUrl: string): Promise<boolean>;
  get(key: string): Promise<SettlementRecord | undefined>;
  all(): Promise<SettlementRecord[]>;
  inProgress(): Promise<SettlementRecord[]>;
  updateLeg(key: string, kind: LegKind, patch: Partial<SettlementLeg>): Promise<void>;
  markSettled(key: string): Promise<void>;
  markFailed(key: string, failedLeg: LegKind, error: string): Promise<void>;
  reopen(key: string): Promise<void>;
}

export class SettlementStore implements SettlementStoreLike {
  private data: StoreShape = structuredClone(EMPTY);
  private loaded = false;
  /** Serializes writes so concurrent leg updates cannot interleave a read-modify-write. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /**
   * Vault-scoped for every record that has a vault, which is every record written since D15. A
   * pre-D15 record has none, keeps the key it was written under, and stays addressable by it.
   */
  keyFor(id: SettlementIdentity): string {
    return id.vault ? `${id.vault.toLowerCase()}:${id.policyId}:${id.periodIndex}` : settlementKey(id.policyId, id.periodIndex);
  }

  static defaultPath(): string {
    return join(process.cwd(), ".state", "settlements.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.data = JSON.parse(raw) as StoreShape;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.data = structuredClone(EMPTY);
    }
    this.loaded = true;
  }

  /**
   * Claim a policy for processing.
   *
   * Returns false when the policy has been seen before, whatever its outcome. A failed settlement
   * is deliberately NOT reclaimable automatically: funds are parked in the executor wallet and a
   * human decides what happens next. Automatic retry of a terminally failed settlement is how you
   * pay twice. Use reopen() to override, explicitly.
   */
  async tryClaim(policy: ReleasedPolicy, legs: LegKind[], releaseExplorerUrl: string): Promise<boolean> {
    await this.load();
    const key = this.keyFor(policy);
    if (this.data.settlements[key]) return false;

    /**
     * A record written before D15 sits under `policyId:periodIndex` with no vault, and its key alone
     * cannot say which deployment it came from. Its release transaction can: a transaction hash
     * names one release, on one vault. So an old record blocks this claim only when it is the same
     * release, which is a genuine replay. A different transaction under the same old key is a
     * different vault's policy that happens to share a number, and refusing it is the D15 defect.
     */
    const legacy = this.data.settlements[settlementKey(policy.policyId, policy.periodIndex)];
    if (legacy && !legacy.vault && legacy.releaseTxHash.toLowerCase() === policy.releaseTxHash.toLowerCase()) return false;

    const record: SettlementRecord = {
      ...(policy.vault ? { vault: policy.vault.toLowerCase() } : {}),
      policyId: policy.policyId,
      periodIndex: policy.periodIndex,
      status: "in_progress",
      recipient: policy.recipient,
      amount: policy.amount,
      payoutCurrency: policy.payoutCurrency,
      destinationDomain: policy.destinationDomain,
      releaseTxHash: policy.releaseTxHash,
      releaseExplorerUrl,
      legs: legs.map((kind) => ({ kind, status: "pending", attempts: 0 })),
      startedAt: new Date().toISOString(),
    };

    this.data.settlements[key] = record;
    await this.persist();
    return true;
  }

  async get(policyId: string): Promise<SettlementRecord | undefined> {
    await this.load();
    return this.data.settlements[policyId];
  }

  async all(): Promise<SettlementRecord[]> {
    await this.load();
    return Object.values(this.data.settlements);
  }

  /** Any settlement left mid-flight by a crash. These need resumption, not a fresh start. */
  async inProgress(): Promise<SettlementRecord[]> {
    return (await this.all()).filter((s) => s.status === "in_progress");
  }

  async updateLeg(policyId: string, kind: LegKind, patch: Partial<SettlementLeg>): Promise<void> {
    await this.mutate(policyId, (record) => {
      const leg = record.legs.find((l) => l.kind === kind);
      if (!leg) throw new Error(`Settlement ${policyId} has no ${kind} leg`);
      Object.assign(leg, patch);
    });
  }

  async markSettled(policyId: string): Promise<void> {
    await this.mutate(policyId, (record) => {
      const completedAt = new Date().toISOString();
      const elapsed = Date.parse(completedAt) - Date.parse(record.startedAt);
      record.status = "settled";
      record.completedAt = completedAt;
      record.durationMs = elapsed;
      record.custodyGapMs = elapsed;
    });
  }

  async markFailed(policyId: string, failedLeg: LegKind, error: string): Promise<void> {
    await this.mutate(policyId, (record) => {
      record.status = "failed";
      record.failedLeg = failedLeg;
      record.completedAt = new Date().toISOString();
      const leg = record.legs.find((l) => l.kind === failedLeg);
      if (leg) {
        leg.status = "failed";
        leg.error = error;
      }
    });
  }

  /**
   * Clear a failed settlement so it can be retried. Manual recovery only.
   * Refuses to touch a settled record, because that path ends in a double payment.
   */
  async reopen(policyId: string): Promise<void> {
    await this.load();
    const record = this.data.settlements[policyId];
    if (!record) throw new Error(`No settlement for policy ${policyId}`);
    if (record.status === "settled") {
      throw new Error(
        `Refusing to reopen settled policy ${policyId}. Reprocessing it would pay the recipient twice.`,
      );
    }
    delete this.data.settlements[policyId];
    await this.persist();
  }

  private async mutate(policyId: string, fn: (record: SettlementRecord) => void): Promise<void> {
    await this.load();
    const record = this.data.settlements[policyId];
    if (!record) throw new Error(`No settlement for policy ${policyId}`);
    fn(record);
    await this.persist();
  }

  /** Write to a temp file then rename, so a crash mid-write cannot truncate the store. */
  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data, bigintSafe, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, snapshot, "utf8");
      await rename(tmp, this.filePath);
    });
    await this.writeChain;
  }
}
