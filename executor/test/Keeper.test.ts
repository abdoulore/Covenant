import { describe, expect, it, vi } from "vitest";
import { coldStartBlock, createKeeper, type EngineLike, type WatcherLike } from "../src/keeper/Keeper.js";
import type { ReleasedPolicy, SettlementRecord } from "../src/types.js";

function released(policyId: string): ReleasedPolicy {
  return {
    policyId, periodIndex: 0, recipient: `0x${"1".repeat(40)}`, amount: "100000",
    payoutCurrency: "USDC", destinationDomain: 26, executor: `0x${"2".repeat(40)}`,
    releaseTxHash: `0x${"a".repeat(64)}`, releaseBlockNumber: 1n,
  };
}

/** A watcher that hands over a fixed list of releases, then idles until stopped. */
class StubWatcher implements WatcherLike {
  stopped = false;
  handed: string[] = [];
  constructor(private readonly queue: ReleasedPolicy[]) {}

  async run(onRelease: (p: ReleasedPolicy) => Promise<void>, onError?: (e: unknown) => void): Promise<void> {
    for (const p of this.queue) {
      if (this.stopped) return;
      this.handed.push(p.policyId);
      try {
        await onRelease(p);
      } catch (err) {
        onError?.(err);
      }
    }
    while (!this.stopped) await new Promise((r) => setTimeout(r, 1));
  }

  stop(): void { this.stopped = true; }
}

class StubEngine implements EngineLike {
  settled: string[] = [];
  resumeCalls = 0;
  order: string[] = [];
  constructor(private readonly failOn: Set<string> = new Set()) {}

  async settle(policy: ReleasedPolicy): Promise<SettlementRecord | undefined> {
    this.order.push(`settle:${policy.policyId}`);
    if (this.failOn.has(policy.policyId)) throw new Error(`no route for ${policy.policyId}`);
    this.settled.push(policy.policyId);
    return { policyId: policy.policyId, durationMs: 1234 } as SettlementRecord;
  }

  async resumeInterrupted(): Promise<number> {
    this.resumeCalls++;
    this.order.push("resume");
    return 0;
  }
}

/** Give the un-awaited watch loop a moment to drain its queue. */
const settleTick = () => new Promise((r) => setTimeout(r, 15));

describe("keeper loop", () => {
  it("settles each release the watcher hands over", async () => {
    const watcher = new StubWatcher([released("16"), released("17")]);
    const engine = new StubEngine();
    const keeper = createKeeper({ watcher, engine });

    await keeper.start();
    await settleTick();
    keeper.stop();
    await keeper.finished;

    expect(engine.settled).toEqual(["16", "17"]);
  });

  /**
   * Interrupted settlements have funds sitting in the executor wallet. Finishing them before new
   * releases compete for the same balance is the whole reason resume runs first.
   */
  it("resumes interrupted work before it starts watching", async () => {
    const watcher = new StubWatcher([released("16")]);
    const engine = new StubEngine();
    const keeper = createKeeper({ watcher, engine });

    await keeper.start();
    await settleTick();
    keeper.stop();
    await keeper.finished;

    expect(engine.resumeCalls).toBe(1);
    expect(engine.order[0]).toBe("resume");
  });

  /** One unroutable release must not stop every later one from being paid. */
  it("keeps going after a settlement throws", async () => {
    const watcher = new StubWatcher([released("16"), released("17"), released("18")]);
    const engine = new StubEngine(new Set(["17"]));
    const logs: string[] = [];
    const keeper = createKeeper({ watcher, engine, log: (m) => logs.push(m) });

    await keeper.start();
    await settleTick();
    keeper.stop();
    await keeper.finished;

    expect(engine.settled).toEqual(["16", "18"]);
    expect(logs.some((l) => l.includes("policy 17 failed"))).toBe(true);
  });

  it("stops when asked, and finishes", async () => {
    const watcher = new StubWatcher([]);
    const keeper = createKeeper({ watcher, engine: new StubEngine() });

    await keeper.start();
    keeper.stop();
    await expect(keeper.finished).resolves.toBeUndefined();
    expect(watcher.stopped).toBe(true);
  });
});

/**
 * The guard against paying everyone twice.
 *
 * A keeper starting on a fresh host has an empty settlement store. Scanning from the vault's deploy
 * block would find every release it ever emitted, tryClaim would succeed on all of them because
 * this store has never seen them, and the engine would run the legs again: a second real payment to
 * every recipient already paid. The head is the only safe cold start.
 */
describe("cold start", () => {
  it("begins at the chain head, not at the vault deploy block", async () => {
    const head = 56_120_000n;
    const deployBlock = 55_000_000n;
    const got = await coldStartBlock(async () => head);

    expect(got).toBe(head);
    expect(got).not.toBe(deployBlock);
    expect(got).toBeGreaterThan(deployBlock);
  });

  it("says out loud where it would start", async () => {
    const log = vi.fn();
    await coldStartBlock(async () => 42n, log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("42"));
    expect(log.mock.calls[0]?.[0]).toMatch(/head, not the vault's deploy block/);
  });
});
