import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettlementStore, settlementKey } from "../src/store/SettlementStore.js";
import type { ReleasedPolicy } from "../src/types.js";

const policy: ReleasedPolicy = {
  vault: "0x3b507607ba48a65587a9a6136c36cd2f1132d498",
  policyId: "0",
  periodIndex: 0,
  recipient: "0x00000000000000000000000000000000000000aa",
  amount: "1000000",
  payoutCurrency: "USDC",
  destinationDomain: 6,
  executor: "0x00000000000000000000000000000000000000bb",
  releaseTxHash: "0xrelease",
  releaseBlockNumber: 1n,
};

// The store keys per release and per vault, and owns that format: ask it rather than rebuild it.
const K = new SettlementStore("unused").keyFor(policy);

describe("SettlementStore", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "covenant-store-"));
    path = join(dir, "settlements.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("claims an unseen policy", async () => {
    const store = new SettlementStore(path);
    expect(await store.tryClaim(policy, ["bridge", "payout"], "https://x/tx/0xrelease")).toBe(true);

    const record = await store.get(K);
    expect(record?.status).toBe("in_progress");
    expect(record?.legs.map((l) => l.kind)).toEqual(["bridge", "payout"]);
    expect(record?.legs.every((l) => l.status === "pending" && l.attempts === 0)).toBe(true);
  });

  it("refuses a second claim on the same policy", async () => {
    const store = new SettlementStore(path);
    expect(await store.tryClaim(policy, ["payout"], "u")).toBe(true);
    expect(await store.tryClaim(policy, ["payout"], "u")).toBe(false);
  });

  /** The restart case. This is the whole point of the store. */
  it("refuses to reclaim a policy after a process restart", async () => {
    const first = new SettlementStore(path);
    expect(await first.tryClaim(policy, ["payout"], "u")).toBe(true);
    await first.updateLeg(K, "payout", { status: "succeeded", txHash: "0xpayout" });
    await first.markSettled(K);

    const afterRestart = new SettlementStore(path);
    expect(await afterRestart.tryClaim(policy, ["payout"], "u")).toBe(false);

    const record = await afterRestart.get(K);
    expect(record?.status).toBe("settled");
    expect(record?.legs[0]?.txHash).toBe("0xpayout");
  });

  it("refuses to reclaim a failed policy, leaving recovery to a human", async () => {
    const store = new SettlementStore(path);
    await store.tryClaim(policy, ["bridge", "payout"], "u");
    await store.markFailed(K, "bridge", "attestation timed out");

    expect(await store.tryClaim(policy, ["bridge", "payout"], "u")).toBe(false);

    const record = await store.get(K);
    expect(record?.status).toBe("failed");
    expect(record?.failedLeg).toBe("bridge");
    expect(record?.legs[0]?.error).toBe("attestation timed out");
  });

  it("persists resume state so a bridge can be retried rather than re-run", async () => {
    const store = new SettlementStore(path);
    await store.tryClaim(policy, ["bridge", "payout"], "u");
    await store.updateLeg(K, "bridge", {
      attempts: 1,
      resumeState: { step: "attestation", burnTxHash: "0xburn" },
    });

    const afterRestart = new SettlementStore(path);
    const leg = (await afterRestart.get(K))?.legs.find((l) => l.kind === "bridge");
    expect(leg?.resumeState).toEqual({ step: "attestation", burnTxHash: "0xburn" });
    expect(leg?.attempts).toBe(1);
  });

  it("records duration and custody gap on settlement", async () => {
    const store = new SettlementStore(path);
    await store.tryClaim(policy, ["payout"], "u");
    await store.markSettled(K);

    const record = await store.get(K);
    expect(record?.durationMs).toBeTypeOf("number");
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
    expect(record?.custodyGapMs).toBe(record?.durationMs);
    expect(record?.completedAt).toBeTypeOf("string");
  });

  it("reopens a failed settlement for manual retry", async () => {
    const store = new SettlementStore(path);
    await store.tryClaim(policy, ["payout"], "u");
    await store.markFailed(K, "payout", "boom");

    await store.reopen(K);
    expect(await store.get(K)).toBeUndefined();
    expect(await store.tryClaim(policy, ["payout"], "u")).toBe(true);
  });

  it("refuses to reopen a settled policy", async () => {
    const store = new SettlementStore(path);
    await store.tryClaim(policy, ["payout"], "u");
    await store.markSettled(K);

    await expect(store.reopen(K)).rejects.toThrow(/pay the recipient twice/);
  });

  it("settles each period of a recurring policy independently", async () => {
    const store = new SettlementStore(path);
    const period1: ReleasedPolicy = { ...policy, policyId: "5", periodIndex: 1 };
    const period2: ReleasedPolicy = { ...policy, policyId: "5", periodIndex: 2 };

    expect(await store.tryClaim(period1, ["payout"], "u")).toBe(true);
    // Same policy, different period: not a duplicate claim, it must settle on its own.
    expect(await store.tryClaim(period2, ["payout"], "u")).toBe(true);
    // The same period again is a duplicate and is refused.
    expect(await store.tryClaim(period1, ["payout"], "u")).toBe(false);

    expect((await store.get(store.keyFor({ ...policy, policyId: "5", periodIndex: 1 })))?.periodIndex).toBe(1);
    expect((await store.get(store.keyFor({ ...policy, policyId: "5", periodIndex: 2 })))?.periodIndex).toBe(2);
  });

  it("lists settlements left mid-flight by a crash", async () => {
    const store = new SettlementStore(path);
    await store.tryClaim(policy, ["payout"], "u");
    await store.tryClaim({ ...policy, policyId: "1" }, ["payout"], "u");
    await store.markSettled(store.keyFor({ ...policy, policyId: "1" }));

    const stuck = await store.inProgress();
    expect(stuck.map((s) => s.policyId)).toEqual(["0"]);
  });

  it("rejects updates to unknown policies and legs", async () => {
    const store = new SettlementStore(path);
    await store.tryClaim(policy, ["payout"], "u");

    await expect(store.updateLeg("nope", "payout", {})).rejects.toThrow(/No settlement/);
    await expect(store.updateLeg(K, "fx", {})).rejects.toThrow(/has no fx leg/);
  });
});

/**
 * D15 in the JSON store. Every vault deployment numbers its policies from zero, and the demo files
 * already hold records from several deployments, so the same policy number on a new vault must be
 * treated as a new settlement, never as one already paid.
 */
describe("SettlementStore across vaults (D15)", () => {
  const V4 = "0x3b507607ba48a65587a9a6136c36cd2f1132d498";
  const V5 = "0x5555555555555555555555555555555555555555";
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "covenant-d15-"));
    path = join(dir, "settlements.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the same policy number on two vaults apart", async () => {
    const store = new SettlementStore(path);
    expect(await store.tryClaim({ ...policy, vault: V4, policyId: "3" }, ["payout"], "u")).toBe(true);
    expect(await store.tryClaim({ ...policy, vault: V5, policyId: "3" }, ["payout"], "u")).toBe(true);
    expect(await store.tryClaim({ ...policy, vault: V5, policyId: "3" }, ["payout"], "u")).toBe(false);
  });

  /**
   * A file written before D15: an old key, a record with no vault. Its release transaction is what
   * says which release it was, so that is what decides.
   */
  describe("with a record written before D15", () => {
    const oldTx = `0x${"b".repeat(64)}`;

    beforeEach(async () => {
      const legacy = {
        version: 1,
        settlements: {
          [settlementKey("3", 0)]: {
            policyId: "3", periodIndex: 0, status: "settled", recipient: policy.recipient,
            amount: policy.amount, payoutCurrency: "USDC", destinationDomain: 26,
            releaseTxHash: oldTx, releaseExplorerUrl: "u", legs: [], startedAt: "2026-08-01T00:00:00.000Z",
          },
        },
      };
      await writeFile(path, JSON.stringify(legacy), "utf8");
    });

    it("still refuses a replay of that same release", async () => {
      const store = new SettlementStore(path);
      expect(await store.tryClaim({ ...policy, vault: V4, policyId: "3", releaseTxHash: oldTx }, ["payout"], "u")).toBe(false);
    });

    it("pays a different release that happens to share its policy number", async () => {
      const store = new SettlementStore(path);
      const v5 = { ...policy, vault: V5, policyId: "3", releaseTxHash: `0x${"c".repeat(64)}` };
      expect(await store.tryClaim(v5, ["payout"], "u")).toBe(true);
      expect((await store.get(store.keyFor(v5)))?.vault).toBe(V5);
    });

    it("leaves the old record readable under its old key", async () => {
      const store = new SettlementStore(path);
      expect((await store.get(settlementKey("3", 0)))?.releaseTxHash).toBe(oldTx);
    });
  });
});
