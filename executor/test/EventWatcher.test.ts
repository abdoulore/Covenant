import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkRange, CursorStore } from "../src/store/CursorStore.js";
import { EventWatcher, POLICY_RELEASED_TOPIC } from "../src/chain/EventWatcher.js";
import type { ReleasedPolicy } from "../src/types.js";

const tmpFile = async (name: string) => join(await mkdtemp(join(tmpdir(), "covenant-")), name);

const VAULT = "0x248391FE29318301a8CD957d28E58b7502387A22" as const;

/** Encodes a PolicyReleased log the way the chain would. */
function releaseLog(opts: {
  policyId: bigint;
  recipient: string;
  amount: bigint;
  payoutCurrency: 0 | 1;
  destinationDomain: number;
  blockNumber: bigint;
  logIndex?: number;
  txHash?: string;
}) {
  const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, "0");
  const addr = (a: string) => a.toLowerCase().replace("0x", "").padStart(64, "0");
  return {
    address: VAULT.toLowerCase() as `0x${string}`,
    topics: [
      POLICY_RELEASED_TOPIC,
      `0x${word(opts.policyId)}`,
      `0x${addr(opts.recipient)}`,
    ] as [`0x${string}`, `0x${string}`, `0x${string}`],
    data: `0x${word(opts.amount)}${word(opts.payoutCurrency)}${word(opts.destinationDomain)}${addr(
      "0x556328348c9c71fd77f31d86a2c2c989beb42671",
    )}` as `0x${string}`,
    blockNumber: opts.blockNumber,
    logIndex: opts.logIndex ?? 0,
    transactionHash: (opts.txHash ?? "0xabc") as `0x${string}`,
  };
}

/** Minimal PublicClient stand-in. Records the ranges it was asked for. */
function fakeClient(head: bigint, logsByRange: Array<ReturnType<typeof releaseLog>> = []) {
  const requested: Array<{ from: bigint; to: bigint }> = [];
  return {
    requested,
    client: {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        requested.push({ from: fromBlock, to: toBlock });
        return logsByRange.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
      },
    } as never,
  };
}

describe("chunkRange", () => {
  it("returns a single chunk when the span fits", () => {
    expect(chunkRange(10n, 20n, 100n)).toEqual([{ from: 10n, to: 20n }]);
  });

  it("splits into inclusive chunks of exactly maxSpan blocks", () => {
    const chunks = chunkRange(0n, 24n, 10n);
    expect(chunks).toEqual([
      { from: 0n, to: 9n },
      { from: 10n, to: 19n },
      { from: 20n, to: 24n },
    ]);
    // Each full chunk covers maxSpan blocks, not maxSpan + 1. Off by one here silently exceeds
    // the provider cap and fails only on a full-width scan.
    const first = chunks[0];
    expect(first).toBeDefined();
    expect(first!.to - first!.from + 1n).toBe(10n);
  });

  it("handles a single block range", () => {
    expect(chunkRange(7n, 7n, 10n)).toEqual([{ from: 7n, to: 7n }]);
  });

  it("returns nothing when the range is empty", () => {
    expect(chunkRange(20n, 19n, 10n)).toEqual([]);
  });

  it("rejects a non-positive span rather than looping forever", () => {
    expect(() => chunkRange(1n, 10n, 0n)).toThrow(/positive/);
  });
});

describe("CursorStore", () => {
  it("starts one block before deployment so the first event is not skipped", async () => {
    const store = new CursorStore(await tmpFile("cursor.json"));
    expect(await store.load(500n)).toBe(499n);
  });

  it("persists and reloads across instances", async () => {
    const path = await tmpFile("cursor.json");
    await new CursorStore(path).set(1234n);
    expect(await new CursorStore(path).load(0n)).toBe(1234n);
  });

  it("refuses to rewind, which would replay settlements", async () => {
    const store = new CursorStore(await tmpFile("cursor.json"));
    await store.set(100n);
    await expect(store.set(50n)).rejects.toThrow(/backwards/);
  });

  it("writes atomically via rename, leaving valid JSON", async () => {
    const path = await tmpFile("cursor.json");
    const store = new CursorStore(path);
    await store.set(42n);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      lastProcessedBlock: "42",
    });
  });
});

describe("EventWatcher", () => {
  const watcherFor = (client: never, cursors: CursorStore, deployBlock = 100n, maxSpan = 10n) =>
    new EventWatcher({ client, vaultAddress: VAULT, cursors, deployBlock, maxSpan, confirmations: 2n });

  it("decodes a release into the executor's input type", async () => {
    const log = releaseLog({
      policyId: 7n,
      recipient: "0x11f4d66ebd6fab2d62e2ad024c798f8adf065100",
      amount: 1_000_000n,
      payoutCurrency: 1,
      destinationDomain: 26,
      blockNumber: 105n,
      txHash: "0xdeadbeef",
    });
    const { client } = fakeClient(120n, [log]);
    const seen: ReleasedPolicy[] = [];

    await watcherFor(client, new CursorStore(await tmpFile("c.json"))).scanOnce(async (p) => {
      seen.push(p);
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      policyId: "7",
      amount: "1000000",
      payoutCurrency: "EURC",
      destinationDomain: 26,
      releaseTxHash: "0xdeadbeef",
    });
    expect(seen[0]!.recipient.toLowerCase()).toBe("0x11f4d66ebd6fab2d62e2ad024c798f8adf065100");
  });

  it("stays behind the head by the confirmation lag", async () => {
    const { client, requested } = fakeClient(120n);
    await watcherFor(client, new CursorStore(await tmpFile("c.json")), 100n, 10_000n).scanOnce(
      async () => {},
    );
    expect(requested.at(-1)?.to).toBe(118n);
  });

  it("chunks a long catch-up scan to respect the provider cap", async () => {
    const { client, requested } = fakeClient(135n);
    await watcherFor(client, new CursorStore(await tmpFile("c.json")), 100n, 10n).scanOnce(async () => {});
    expect(requested).toEqual([
      { from: 100n, to: 109n },
      { from: 110n, to: 119n },
      { from: 120n, to: 129n },
      { from: 130n, to: 133n },
    ]);
  });

  it("does not rescan a range once the cursor has advanced", async () => {
    const path = await tmpFile("c.json");
    const log = releaseLog({
      policyId: 1n,
      recipient: "0x11f4d66ebd6fab2d62e2ad024c798f8adf065100",
      amount: 1n,
      payoutCurrency: 0,
      destinationDomain: 26,
      blockNumber: 105n,
    });

    const first = fakeClient(120n, [log]);
    let count = 0;
    await watcherFor(first.client, new CursorStore(path), 100n, 10_000n).scanOnce(async () => {
      count++;
    });
    expect(count).toBe(1);

    // Same head, fresh watcher, cursor loaded from disk. Nothing new is in range.
    const second = fakeClient(120n, [log]);
    await watcherFor(second.client, new CursorStore(path), 100n, 10_000n).scanOnce(async () => {
      count++;
    });
    expect(count).toBe(1);
  });

  it("replays a chunk when the handler throws, so no release is lost", async () => {
    const path = await tmpFile("c.json");
    const log = releaseLog({
      policyId: 3n,
      recipient: "0x11f4d66ebd6fab2d62e2ad024c798f8adf065100",
      amount: 5n,
      payoutCurrency: 0,
      destinationDomain: 26,
      blockNumber: 105n,
    });

    const failing = fakeClient(120n, [log]);
    await expect(
      watcherFor(failing.client, new CursorStore(path), 100n, 10_000n).scanOnce(async () => {
        throw new Error("processor exploded");
      }),
    ).rejects.toThrow("processor exploded");

    // The cursor must not have advanced past the failed chunk.
    const retry = fakeClient(120n, [log]);
    const seen: string[] = [];
    await watcherFor(retry.client, new CursorStore(path), 100n, 10_000n).scanOnce(async (p) => {
      seen.push(p.policyId);
    });
    expect(seen).toEqual(["3"]);
  });

  it("orders releases within a scan by block then log index", async () => {
    const mk = (policyId: bigint, blockNumber: bigint, logIndex: number) =>
      releaseLog({
        policyId,
        recipient: "0x11f4d66ebd6fab2d62e2ad024c798f8adf065100",
        amount: 1n,
        payoutCurrency: 0,
        destinationDomain: 26,
        blockNumber,
        logIndex,
      });

    const { client } = fakeClient(120n, [mk(3n, 106n, 0), mk(1n, 105n, 1), mk(2n, 105n, 0)]);
    const seen: string[] = [];
    await watcherFor(client, new CursorStore(await tmpFile("c.json")), 100n, 10_000n).scanOnce(
      async (p) => {
        seen.push(p.policyId);
      },
    );
    expect(seen).toEqual(["2", "1", "3"]);
  });

  it("rejects a maxSpan above Arc's getLogs cap", async () => {
    expect(
      () =>
        new EventWatcher({
          client: fakeClient(1n).client,
          vaultAddress: VAULT,
          cursors: new CursorStore("unused"),
          deployBlock: 1n,
          maxSpan: 10_001n,
        }),
    ).toThrow(/10,000/);
  });

  it("rejects a release routed to an unconfigured chain", async () => {
    const log = releaseLog({
      policyId: 9n,
      recipient: "0x11f4d66ebd6fab2d62e2ad024c798f8adf065100",
      amount: 1n,
      payoutCurrency: 0,
      destinationDomain: 999,
      blockNumber: 105n,
    });
    const { client } = fakeClient(120n, [log]);
    await expect(
      watcherFor(client, new CursorStore(await tmpFile("c.json")), 100n, 10_000n).scanOnce(
        async () => {},
      ),
    ).rejects.toThrow(/No chain configured for CCTP domain 999/);
  });
});
