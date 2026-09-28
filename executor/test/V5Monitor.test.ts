import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { V5Monitor, type CrossChainRelease, type MonitorStore, type ProblemKind } from "../src/v5/V5Monitor.js";
import { PostgresMonitorStore } from "../src/v5/PostgresMonitorStore.js";
import { pgConnectionString } from "../src/store/PostgresSettlementStore.js";
import type { V5Policy } from "../src/v5/V5Reader.js";
import type { Notifier } from "../src/alerts/Notifier.js";

const NOW = 2_000_000_000;
const DAY = 86_400;

function policy(over: Partial<V5Policy> = {}): V5Policy {
  return {
    id: 1n, owner: "0xo", recipient: "0xr", amount: 100_000n, funded: 100_000n, feeAllowance: 0n, maxFeePerTransfer: 0n,
    destinationDomain: 26, conditionType: 0, status: 0, recurring: false, isSweep: false, nextDue: 0n, stoppedAt: 0n,
    adapter: "0xa", feedId: "0xf", effectiveStatus: 0, effectiveDeadline: BigInt(NOW + 10 * DAY), ...over,
  };
}

class MemoryStore implements MonitorStore {
  releasable = new Map<string, number>();
  cross: CrossChainRelease[] = [];
  alerts = new Map<string, ProblemKind>();
  async firstSeenReleasable(key: string, now: number) {
    if (!this.releasable.has(key)) this.releasable.set(key, now);
    return this.releasable.get(key)!;
  }
  async forgetReleasable(keys: string[]) { for (const k of keys) this.releasable.delete(k); }
  async openCrossChain() { return this.cross.filter((c) => c.forwardState !== "COMPLETE"); }
  async updateCrossChain(tx: string, state: string | null, mint: string | null) {
    const c = this.cross.find((x) => x.releaseTx === tx)!;
    c.forwardState = state;
    c.mintTx = mint;
  }
  async announced() { return new Map(this.alerts); }
  async markAnnounced(key: string, kind: ProblemKind) { this.alerts.set(key, kind); }
  async markCleared(key: string) { this.alerts.delete(key); }
}

class Sent implements Notifier {
  describe = "test";
  messages: string[] = [];
  async send(t: string) { this.messages.push(t); }
}

type Forward = () => Promise<{ forwardState: string | null; mintTx: string | null }>;
const monitor = (store: MonitorStore, notifier: Notifier, forward: Forward = async () => ({ forwardState: "PENDING", mintTx: null })) =>
  new V5Monitor({ vaultLabel: "v5", store, notifier, txUrl: (h) => `https://x/tx/${h}`, forwardStatus: forward });

describe("V5Monitor", () => {
  it("gives the keeper ten minutes before calling a releasable policy stalled", async () => {
    const store = new MemoryStore();
    const m = monitor(store, new Sent());
    const p = policy({ effectiveStatus: 1 });
    expect(await m.problems([p], NOW)).toEqual([]);
    const later = await m.problems([p], NOW + 600);
    expect(later.map((x) => x.kind)).toEqual(["stalled"]);
    expect(later[0]!.message).toContain("npm run v5:release");
  });

  it("restarts the stall clock once a policy stops being releasable", async () => {
    const store = new MemoryStore();
    const m = monitor(store, new Sent());
    await m.problems([policy({ effectiveStatus: 1 })], NOW);
    await m.problems([policy({ effectiveStatus: 0 })], NOW + 300);
    expect(await m.problems([policy({ effectiveStatus: 1 })], NOW + 700)).toEqual([]);
  });

  it("warns within a day of the deadline, and says whether the recipient is owed", async () => {
    const m = monitor(new MemoryStore(), new Sent());
    const near = BigInt(NOW + 6 * 3_600);
    const [owed] = await m.problems([policy({ effectiveStatus: 1, effectiveDeadline: near })], NOW);
    expect(owed!.message).toContain("the owner can reclaim what the recipient is owed");
    const all = await m.problems([policy({ effectiveDeadline: near })], NOW);
    expect(all.map((x) => x.kind)).toEqual(["deadline"]);
    expect(all[0]!.message).toContain("condition is not met");
  });

  it("does not warn about a deadline that is far off, or a policy holding nothing", async () => {
    const m = monitor(new MemoryStore(), new Sent());
    expect(await m.problems([policy(), policy({ funded: 0n, effectiveDeadline: BigInt(NOW + 3_600) })], NOW)).toEqual([]);
  });

  it("flags a cross-chain payment Circle has not minted after twenty minutes, and not before", async () => {
    const store = new MemoryStore();
    store.cross.push({ releaseTx: "0xburn", policyId: "4", periodIndex: 0, amount: "100000", destinationDomain: 6, seenAt: NOW, forwardState: null, mintTx: null });
    const m = monitor(store, new Sent());
    expect(await m.problems([], NOW + 600)).toEqual([]);
    const late = await m.problems([], NOW + 1_200);
    expect(late.map((x) => x.kind)).toEqual(["unminted"]);
    expect(late[0]!.message).toContain("not lost");
  });

  it("stops asking about a mint once Circle reports it complete", async () => {
    const store = new MemoryStore();
    store.cross.push({ releaseTx: "0xburn", policyId: "4", periodIndex: 0, amount: "100000", destinationDomain: 6, seenAt: NOW, forwardState: null, mintTx: null });
    let asked = 0;
    const m = monitor(store, new Sent(), async () => { asked++; return { forwardState: "COMPLETE", mintTx: "0xmint" }; });
    expect(await m.problems([], NOW + 2_000)).toEqual([]);
    await m.problems([], NOW + 3_000);
    expect(asked).toBe(1);
    expect(store.cross[0]!.mintTx).toBe("0xmint");
  });

  it("counts a mint Circle has confirmed but not yet finalized as paid, and keeps asking until final", async () => {
    const store = new MemoryStore();
    store.cross.push({ releaseTx: "0xburn", policyId: "10", periodIndex: 0, amount: "100000", destinationDomain: 6, seenAt: NOW, forwardState: null, mintTx: null });
    let asked = 0;
    const m = monitor(store, new Sent(), async () => { asked++; return { forwardState: "CONFIRMED", mintTx: "0xmint" }; });
    expect(await m.problems([], NOW + 1_500)).toEqual([]);
    await m.problems([], NOW + 1_600);
    expect(asked).toBe(2);
  });

  it("still flags CONFIRMED with no mint transaction", async () => {
    const store = new MemoryStore();
    store.cross.push({ releaseTx: "0xburn", policyId: "10", periodIndex: 0, amount: "100000", destinationDomain: 6, seenAt: NOW, forwardState: null, mintTx: null });
    const m = monitor(store, new Sent(), async () => ({ forwardState: "CONFIRMED", mintTx: null }));
    expect((await m.problems([], NOW + 1_500)).map((p) => p.kind)).toEqual(["unminted"]);
  });

  it("announces a problem once and clears it once", async () => {
    const store = new MemoryStore();
    const sent = new Sent();
    const m = monitor(store, sent);
    const p = policy({ effectiveStatus: 1 });
    await m.runOnce([p], NOW);
    await m.runOnce([p], NOW + 600);
    await m.runOnce([p], NOW + 900);
    expect(sent.messages).toHaveLength(1);
    await m.runOnce([], NOW + 1_000); // released
    expect(sent.messages).toHaveLength(2);
    expect(sent.messages[1]).toContain("resolved");
    await m.runOnce([], NOW + 1_100);
    expect(sent.messages).toHaveLength(2);
  });

  it("retries an alert that could not be sent", async () => {
    const store = new MemoryStore();
    let fail = true;
    const flaky: Notifier = { describe: "x", send: async () => { if (fail) { fail = false; throw new Error("down"); } } };
    const m = monitor(store, flaky);
    const p = policy({ effectiveStatus: 1 });
    await m.runOnce([p], NOW);
    expect((await m.runOnce([p], NOW + 600)).announced).toBe(0);
    expect((await m.runOnce([p], NOW + 700)).announced).toBe(1);
  });
});

const URL_ = process.env.TEST_DATABASE_URL;
const SCHEMA = `covenant_v5mon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

describe.skipIf(!URL_)("PostgresMonitorStore", { timeout: 60_000 }, () => {
  let store: PostgresMonitorStore;
  beforeAll(async () => {
    store = new PostgresMonitorStore(URL_!, SCHEMA);
    await store.migrate();
  }, 60_000);
  afterAll(async () => {
    await store?.end();
    const admin = new pg.Client({ connectionString: pgConnectionString(URL_!) });
    await admin.connect();
    await admin.query(`drop schema if exists "${SCHEMA}" cascade`);
    await admin.end();
  }, 60_000);

  it("remembers when a policy was first seen releasable, and forgets it on request", async () => {
    expect(await store.firstSeenReleasable("v5:1", 100)).toBe(100);
    expect(await store.firstSeenReleasable("v5:1", 200)).toBe(100);
    await store.forgetReleasable(["v5:1"]);
    expect(await store.firstSeenReleasable("v5:1", 300)).toBe(300);
  });

  it("keeps alert state across instances, as a restart would", async () => {
    await store.markAnnounced("stalled:v5:1", "stalled");
    const again = new PostgresMonitorStore(URL_!, SCHEMA);
    expect((await again.announced()).get("stalled:v5:1")).toBe("stalled");
    await again.markCleared("stalled:v5:1");
    expect((await store.announced()).has("stalled:v5:1")).toBe(false);
    await again.end();
  });
});
