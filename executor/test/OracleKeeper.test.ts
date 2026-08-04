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
  type OracleParams,
  type PythClient,
  type PythPrice,
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
  /** Optional per-policy status sequence, so a read can differ before and after a feed refresh. */
  statusQueue = new Map<string, PolicyStatus[]>();
  params = new Map<string, OracleParams>();
  releaseCalls: bigint[] = [];
  refreshCalls: `0x${string}`[] = [];
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
    const queue = this.statusQueue.get(policyId.toString());
    if (queue && queue.length > 0) return queue.shift()!;
    return this.statuses.get(policyId.toString()) ?? PolicyStatus.Pending;
  }

  async release(policyId: bigint): Promise<string> {
    if (this.releaseThrow.has(policyId.toString())) throw new Error("execution reverted: ConditionNotMet");
    this.releaseCalls.push(policyId);
    return `0x${policyId.toString().padStart(4, "0")}`;
  }

  async oracleParams(policyId: bigint): Promise<OracleParams> {
    return (
      this.params.get(policyId.toString()) ?? {
        feed: "0x0000000000000000000000000000000000000000",
        priceId: null,
        comparator: 0,
        threshold: 0n,
      }
    );
  }

  async refreshFeed(feed: `0x${string}`, _updateData: `0x${string}`[]): Promise<string> {
    this.refreshCalls.push(feed);
    return "0xrefresh";
  }
}

/** Offchain price source stub. Returns a fixed price and records the feeds it was asked about. */
class FakePyth implements PythClient {
  calls: string[] = [];
  constructor(
    private readonly price: bigint,
    private readonly data: `0x${string}`[] = ["0xabcd"],
  ) {}
  async fetch(priceId: string): Promise<PythPrice> {
    this.calls.push(priceId);
    return { price: this.price, updateData: this.data };
  }
}

const PYTH_FEED = "0x00000000000000000000000000000000000000Fe" as const;
const pythParams = (comparator: number, threshold: bigint): OracleParams => ({
  feed: PYTH_FEED,
  priceId: "0x1111111111111111111111111111111111111111111111111111111111111111",
  comparator,
  threshold,
});

async function keeperWith(reader: FakeReader): Promise<{ keeper: OracleKeeper; store: KeeperStore }> {
  const store = new KeeperStore(await storePath());
  const keeper = new OracleKeeper({ reader, store, deployBlock: 1n });
  return { keeper, store };
}

async function keeperWithPyth(reader: FakeReader, pyth: PythClient): Promise<{ keeper: OracleKeeper; store: KeeperStore }> {
  const store = new KeeperStore(await storePath());
  const keeper = new OracleKeeper({ reader, store, deployBlock: 1n, pyth });
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

  it("refreshes a Pyth feed and releases when the offchain price crosses the threshold", async () => {
    const reader = new FakeReader(100n, [oracle(1n)]);
    reader.params.set("1", pythParams(0 /* Gte */, 99_500_000n));
    // Stale before the refresh, releasable after: the keeper must post the price, then re-read.
    reader.statusQueue.set("1", [PolicyStatus.Pending, PolicyStatus.Releasable]);
    const pyth = new FakePyth(99_985_376n); // 0.99985, crosses 0.995
    const { keeper, store } = await keeperWithPyth(reader, pyth);

    const out = await keeper.tick();

    expect(pyth.calls.length).toBe(1);
    expect(reader.refreshCalls).toEqual([PYTH_FEED]);
    expect(reader.releaseCalls).toEqual([1n]);
    expect(out).toEqual([{ policyId: "1", txHash: "0x0001" }]);
    expect(await store.isHandled(1n)).toBe(true);
  });

  it("does not pay to refresh when the offchain price will not cross", async () => {
    const reader = new FakeReader(100n, [oracle(1n)]);
    reader.params.set("1", pythParams(0 /* Gte */, 99_500_000n));
    reader.statuses.set("1", PolicyStatus.Pending);
    const pyth = new FakePyth(99_000_000n); // 0.99, does not cross 0.995
    const { keeper, store } = await keeperWithPyth(reader, pyth);

    expect(await keeper.tick()).toEqual([]);
    expect(pyth.calls.length).toBe(1); // it checked the price for free
    expect(reader.refreshCalls).toEqual([]); // but did not pay to refresh
    expect(reader.releaseCalls).toEqual([]);
    expect(await store.isHandled(1n)).toBe(false); // stays tracked, may cross later
  });

  it("handles an Lte depeg trigger, refreshing only when the price drops below", async () => {
    const reader = new FakeReader(100n, [oracle(1n)]);
    reader.params.set("1", pythParams(1 /* Lte */, 99_000_000n));
    reader.statusQueue.set("1", [PolicyStatus.Pending, PolicyStatus.Releasable]);
    const pyth = new FakePyth(98_500_000n); // 0.985 <= 0.99, crosses
    const { keeper } = await keeperWithPyth(reader, pyth);

    await keeper.tick();

    expect(reader.refreshCalls).toEqual([PYTH_FEED]);
    expect(reader.releaseCalls).toEqual([1n]);
  });

  it("treats a feed with no Pyth id as a push feed: no fetch, no refresh, just release", async () => {
    const reader = new FakeReader(100n, [oracle(1n)]);
    reader.params.set("1", { feed: PYTH_FEED, priceId: null, comparator: 0, threshold: 0n });
    reader.statuses.set("1", PolicyStatus.Releasable);
    const pyth = new FakePyth(0n);
    const { keeper } = await keeperWithPyth(reader, pyth);

    await keeper.tick();

    expect(pyth.calls.length).toBe(0); // no Pyth id, so no offchain fetch
    expect(reader.refreshCalls).toEqual([]);
    expect(reader.releaseCalls).toEqual([1n]); // push behavior: statusOf said Releasable
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
