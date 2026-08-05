import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeeperStore } from "../src/oracle/KeeperStore.js";
import { PolicyStatus, type CreatedPolicy } from "../src/oracle/OracleKeeper.js";
import { SchedulerKeeper, type SchedulerReader } from "../src/oracle/SchedulerKeeper.js";

async function storePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "covenant-scheduler-")), "keeper.json");
}

interface FakeCreated {
  policyId: bigint;
  block: bigint;
}

/** In-memory SchedulerReader. Everything is settable so a test can stage any chain state. */
class FakeReader implements SchedulerReader {
  head: bigint;
  created: FakeCreated[];
  recurring = new Set<string>();
  statuses = new Map<string, PolicyStatus>();
  /** Sequence of isPeriodDue results per policy, shifted on each call. Empty means not due. */
  dueQueue = new Map<string, boolean[]>();
  staleSet = new Set<string>();
  releaseCalls: bigint[] = [];
  releaseThrow = new Set<string>();

  constructor(head: bigint, created: FakeCreated[] = []) {
    this.head = head;
    this.created = created;
  }

  async blockNumber(): Promise<bigint> {
    return this.head;
  }

  async scanCreatedPolicies(from: bigint, to: bigint): Promise<CreatedPolicy[]> {
    return this.created
      .filter((c) => c.block >= from && c.block <= to)
      .map(({ policyId }) => ({ policyId, conditionType: 0 }));
  }

  async isRecurring(policyId: bigint): Promise<boolean> {
    return this.recurring.has(policyId.toString());
  }

  async statusOf(policyId: bigint): Promise<PolicyStatus> {
    return this.statuses.get(policyId.toString()) ?? PolicyStatus.Pending;
  }

  async isPeriodDue(policyId: bigint): Promise<boolean> {
    const q = this.dueQueue.get(policyId.toString());
    if (q && q.length > 0) return q.shift()!;
    return false;
  }

  async isStale(policyId: bigint): Promise<boolean> {
    return this.staleSet.has(policyId.toString());
  }

  async releasePeriod(policyId: bigint): Promise<string> {
    if (this.releaseThrow.has(policyId.toString())) throw new Error("execution reverted: Underfunded");
    this.releaseCalls.push(policyId);
    return `0x${policyId.toString().padStart(4, "0")}`;
  }
}

async function keeperWith(
  reader: FakeReader,
  opts: { maxCatchUpPerTick?: number; log?: (m: string) => void } = {},
): Promise<{ keeper: SchedulerKeeper; store: KeeperStore }> {
  const store = new KeeperStore(await storePath());
  const keeper = new SchedulerKeeper({ reader, store, deployBlock: 1n, ...opts });
  return { keeper, store };
}

const recurring = (reader: FakeReader, policyId: bigint, block = 10n): void => {
  reader.created.push({ policyId, block });
  reader.recurring.add(policyId.toString());
};

describe("SchedulerKeeper", () => {
  it("releases a single due period", async () => {
    const reader = new FakeReader(100n);
    recurring(reader, 1n);
    reader.dueQueue.set("1", [true, false]);
    const { keeper } = await keeperWith(reader);

    const out = await keeper.tick();

    expect(reader.releaseCalls).toEqual([1n]);
    expect(out).toEqual([{ policyId: "1", periodTxHashes: ["0x0001"] }]);
  });

  it("catches up several due periods in one tick", async () => {
    const reader = new FakeReader(100n);
    recurring(reader, 1n);
    reader.dueQueue.set("1", [true, true, true, false]);
    const { keeper } = await keeperWith(reader);

    const out = await keeper.tick();

    expect(reader.releaseCalls).toEqual([1n, 1n, 1n]);
    expect(out[0]?.periodTxHashes).toHaveLength(3);
  });

  it("bounds catch-up to maxCatchUpPerTick", async () => {
    const reader = new FakeReader(100n);
    recurring(reader, 1n);
    reader.dueQueue.set("1", [true, true, true, true, true]);
    const { keeper } = await keeperWith(reader, { maxCatchUpPerTick: 2 });

    await keeper.tick();

    expect(reader.releaseCalls).toEqual([1n, 1n]); // stopped at the cap, the rest wait for next tick
  });

  it("does not release when no period is due", async () => {
    const reader = new FakeReader(100n);
    recurring(reader, 1n);
    reader.dueQueue.set("1", [false]);
    const { keeper } = await keeperWith(reader);

    expect(await keeper.tick()).toEqual([]);
    expect(reader.releaseCalls).toEqual([]);
  });

  it("retires a terminal policy without releasing it", async () => {
    const reader = new FakeReader(100n);
    recurring(reader, 1n);
    reader.statuses.set("1", PolicyStatus.Executed);
    reader.dueQueue.set("1", [true]);
    const { keeper, store } = await keeperWith(reader);

    await keeper.tick();

    expect(reader.releaseCalls).toEqual([]);
    expect(await store.isHandled(1n)).toBe(true);
  });

  it("only tracks recurring policies", async () => {
    const reader = new FakeReader(100n);
    recurring(reader, 2n);
    reader.created.push({ policyId: 1n, block: 10n }); // not marked recurring
    reader.dueQueue.set("1", [true]);
    reader.dueQueue.set("2", [true, false]);
    const { keeper } = await keeperWith(reader);

    await keeper.tick();

    expect(reader.releaseCalls).toEqual([2n]); // policy 1 is not the scheduler's job
  });

  it("alerts on a stale period and holds it, rather than releasing", async () => {
    const reader = new FakeReader(100n);
    recurring(reader, 1n);
    reader.dueQueue.set("1", [false]); // isPeriodDue is false for a stale period
    reader.staleSet.add("1");
    const logs: string[] = [];
    const { keeper } = await keeperWith(reader, { log: (m) => logs.push(m) });

    await keeper.tick();

    expect(reader.releaseCalls).toEqual([]);
    expect(logs.some((l) => l.includes("approveStalePeriod"))).toBe(true);
  });

  it("retries a failed releasePeriod on the next tick without marking handled", async () => {
    const reader = new FakeReader(100n);
    recurring(reader, 1n);
    reader.dueQueue.set("1", [true]);
    reader.releaseThrow.add("1");
    const { keeper, store } = await keeperWith(reader);

    expect(await keeper.tick()).toEqual([]);
    expect(reader.releaseCalls).toEqual([]);
    expect(await store.isHandled(1n)).toBe(false);

    // The transient failure clears; the next tick releases.
    reader.releaseThrow.delete("1");
    reader.dueQueue.set("1", [true, false]);
    await keeper.tick();
    expect(reader.releaseCalls).toEqual([1n]);
  });

  it("remembers tracked recurring policies across a restart", async () => {
    const path = await storePath();
    const reader = new FakeReader(100n);
    recurring(reader, 1n);
    reader.dueQueue.set("1", [false]);

    const first = new SchedulerKeeper({ reader, store: new KeeperStore(path), deployBlock: 1n });
    await first.tick(); // discovers policy 1, nothing due yet

    reader.dueQueue.set("1", [true, false]);
    const second = new SchedulerKeeper({ reader, store: new KeeperStore(path), deployBlock: 1n });
    await second.tick();

    expect(reader.releaseCalls).toEqual([1n]); // tracked set survived the restart
  });
});
