import { describe, expect, it } from "vitest";
import { withTtlCache } from "../src/api/readModel.js";

/**
 * /api/state is public, unauthenticated, and costs a chain read per policy per vault plus an
 * outbound Pyth fetch. Without this the RPC bill scales with the number of open browser tabs, and
 * anyone at all can run it up deliberately.
 */
describe("read state cache", () => {
  it("serves a cached value inside the ttl and reloads after it", async () => {
    let calls = 0;
    let clock = 0;
    const read = withTtlCache(async () => ({ n: ++calls }), 1_000, () => clock);

    expect((await read()).n).toBe(1);
    clock = 500;
    expect((await read()).n).toBe(1);
    expect(calls).toBe(1);

    clock = 1_500;
    expect((await read()).n).toBe(2);
    expect(calls).toBe(2);
  });

  /** A cache alone still lets a burst of first-callers each start their own pass. */
  it("collapses concurrent callers into a single load", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const read = withTtlCache(async () => {
      calls++;
      await gate;
      return calls;
    }, 1_000);

    const all = Promise.all([read(), read(), read(), read()]);
    release();
    const results = await all;

    expect(calls).toBe(1);
    expect(results).toEqual([1, 1, 1, 1]);
  });

  it("does not cache a failure, so the next caller retries", async () => {
    let calls = 0;
    const read = withTtlCache(async () => {
      calls++;
      if (calls === 1) throw new Error("rpc down");
      return calls;
    }, 60_000);

    await expect(read()).rejects.toThrow("rpc down");
    expect(await read()).toBe(2);
  });
});
