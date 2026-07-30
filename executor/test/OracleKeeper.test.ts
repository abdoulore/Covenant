import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeeperStore } from "../src/oracle/KeeperStore.js";
import {
  OracleKeeper,
  ORACLE_CONDITION_TYPE,
  PolicyStatus,
  type CreatedPolicy,
  type VaultReader,
} from "../src/oracle/OracleKeeper.js";

const TIMELOCK = 0;

async function storePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "covenant-keeper-")), "keeper.json");
}

interface FakeCreated {
  policyId: bigint;
  conditionType: number;
  block: bigint;
}

/** In-memory VaultReader. Everything is settable so a test can stage any chain state. */
class FakeReader implements VaultReader {
  head: bigint;
  created: FakeCreated[];
  statuses = new Map<string, PolicyStatus>();
  releaseCalls: bigint[] = [];
  releaseThrow = new Set<string>();
  statusThrow = new Set<string>();

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
      .map(({ policyId, conditionType }) => ({ policyId, conditionType }));
  }

  async statusOf(policyId: bigint): Promise<PolicyStatus> {
    if (this.statusThrow.has(policyId.toString())) throw new Error("rpc error");
    return this.statuses.get(policyId.toString()) ?? PolicyStatus.Pending;
  }

  async release(policyId: bigint): Promise<string> {
    if (this.releaseThrow.has(policyId.toString())) throw new Error("execution reverted: ConditionNotMet");
    this.releaseCalls.push(policyId);
    return `0x${policyId.toString().padStart(4, "0")}`;
  }
}

async function keeperWith(reader: FakeReader): Promise<{ keeper: OracleKeeper; store: KeeperStore }> {
  const store = new KeeperStore(await storePath());
  const keeper = new OracleKeeper({ reader, store, deployBlock: 1n });
  return { keeper, store };
}

const oracle = (policyId: bigint, block = 10n): FakeCreated => ({ policyId, conditionType: ORACLE_CONDITION_TYPE, block });

describe("OracleKeeper", () => {
  it("releases an oracle policy that has become releasable", async () => {
    const reader = new FakeReader(100n, [oracle(1n)]);
    reader.statuses.set("1", PolicyStatus.Releasable);
    const { keeper, store } = await keeperWith(reader);

    const out = await keeper.tick();

    expect(reader.releaseCalls).toEqual([1n]);
    expect(out).toEqual([{ policyId: "1", txHash: "0x0001" }]);
    expect(await store.isHandled(1n)).toBe(true);
  });

  it("does not release a policy whose condition has not been met", async () => {
    const reader = new FakeReader(100n, [oracle(1n)]);
    reader.statuses.set("1", PolicyStatus.Pending);
    const { keeper } = await keeperWith(reader);

    expect(await keeper.tick()).toEqual([]);
    expect(reader.releaseCalls).toEqual([]);
  });

  it("only tracks oracle policies, not other condition types", async () => {
    const reader = new FakeReader(100n, [
      { policyId: 1n, conditionType: TIMELOCK, block: 10n },
      oracle(2n),
    ]);
    reader.statuses.set("1", PolicyStatus.Releasable);
    reader.statuses.set("2", PolicyStatus.Releasable);
    const { keeper } = await keeperWith(reader);

    await keeper.tick();

    // The timelock policy is not the keeper's job, even though it reads as releasable.
    expect(reader.releaseCalls).toEqual([2n]);
  });

  it("marks a terminal policy handled without releasing it", async () => {
    const reader = new FakeReader(100n, [oracle(1n)]);
    reader.statuses.set("1", PolicyStatus.Executed); // already released by someone
    const { keeper, store } = await keeperWith(reader);

    await keeper.tick();

    expect(reader.releaseCalls).toEqual([]);
    expect(await store.isHandled(1n)).toBe(true);
  });

  it("never releases the same policy twice across ticks", async () => {
    const reader = new FakeReader(100n, [oracle(1n)]);
    reader.statuses.set("1", PolicyStatus.Releasable);
    const { keeper } = await keeperWith(reader);

    await keeper.tick();
    // The policy still reads releasable, but it is already handled.
    await keeper.tick();

    expect(reader.releaseCalls).toEqual([1n]);
  });

  it("does not mark handled when release fails, so it retries", async () => {
    const reader = new FakeReader(100n, [oracle(1n)]);
    reader.statuses.set("1", PolicyStatus.Releasable);
    reader.releaseThrow.add("1");
    const { keeper, store } = await keeperWith(reader);

    expect(await keeper.tick()).toEqual([]);
    expect(await store.isHandled(1n)).toBe(false);

    // The transient failure clears; the next tick succeeds.
    reader.releaseThrow.delete("1");
    const out = await keeper.tick();
    expect(out).toEqual([{ policyId: "1", txHash: "0x0001" }]);
  });

  it("skips a policy whose status read fails, and retries next tick", async () => {
    const reader = new FakeReader(100n, [oracle(1n)]);
    reader.statusThrow.add("1");
    const { keeper, store } = await keeperWith(reader);

    await keeper.tick();
    expect(reader.releaseCalls).toEqual([]);
    expect(await store.isHandled(1n)).toBe(false);

    reader.statusThrow.delete("1");
    reader.statuses.set("1", PolicyStatus.Releasable);
    await keeper.tick();
    expect(reader.releaseCalls).toEqual([1n]);
  });

  it("discovers oracle policies created in later blocks across ticks", async () => {
    const reader = new FakeReader(50n, [oracle(1n, 10n)]);
    reader.statuses.set("1", PolicyStatus.Pending);
    const { keeper } = await keeperWith(reader);

    await keeper.tick(); // discovers policy 1, nothing releasable yet

    // A second oracle policy is created later, and both become releasable.
    reader.created.push(oracle(2n, 60n));
    reader.head = 100n;
    reader.statuses.set("1", PolicyStatus.Releasable);
    reader.statuses.set("2", PolicyStatus.Releasable);

    await keeper.tick();

    expect(reader.releaseCalls.sort()).toEqual([1n, 2n]);
  });

  it("remembers discovered policies and handled state across a restart", async () => {
    const path = await storePath();
    const reader = new FakeReader(100n, [oracle(1n, 10n)]);
    reader.statuses.set("1", PolicyStatus.Pending);

    const first = new OracleKeeper({ reader, store: new KeeperStore(path), deployBlock: 1n });
    await first.tick(); // discovers policy 1, cursor now past block 10

    // Fresh keeper and fresh store instance, same file. The price has since crossed.
    reader.statuses.set("1", PolicyStatus.Releasable);
    const second = new OracleKeeper({ reader, store: new KeeperStore(path), deployBlock: 1n });
    await second.tick();

    // Policy 1 is released even though the discovery cursor is long past the block that created
    // it: the tracked set survived the restart.
    expect(reader.releaseCalls).toEqual([1n]);
  });
});

describe("KeeperStore", () => {
  it("deduplicates oracle ids and handled ids", async () => {
    const store = new KeeperStore(await storePath());
    await store.addOraclePolicy(7n);
    await store.addOraclePolicy(7n);
    await store.markHandled(3n);
    await store.markHandled(3n);

    expect(await store.listOraclePolicies()).toEqual([7n]);
    expect(await store.isHandled(3n)).toBe(true);
  });

  it("refuses to move the discovery cursor backwards", async () => {
    const store = new KeeperStore(await storePath());
    await store.setCursor(500n);
    await expect(store.setCursor(400n)).rejects.toThrow(/backwards/);
  });

  it("starts scanning at the deploy block on first run", async () => {
    const store = new KeeperStore(await storePath());
    expect(await store.getCursor(1000n)).toBe(999n);
  });
});
