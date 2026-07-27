import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettlementStore } from "../src/store/SettlementStore.js";
import type { ReleasedPolicy } from "../src/types.js";

const policy: ReleasedPolicy = {
  policyId: "0",
  recipient: "0x00000000000000000000000000000000000000aa",
  amount: "1000000",
  payoutCurrency: "USDC",
  destinationDomain: 6,
  executor: "0x00000000000000000000000000000000000000bb",
  releaseTxHash: "0xrelease",
  releaseBlockNumber: 1n,
};

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

    const record = await store.get("0");
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
    await first.updateLeg("0", "payout", { status: "succeeded", txHash: "0xpayout" });
    await first.markSettled("0");

    const afterRestart = new SettlementStore(path);
    expect(await afterRestart.tryClaim(policy, ["payout"], "u")).toBe(false);

    const record = await afterRestart.get("0");
    expect(record?.status).toBe("settled");
    expect(record?.legs[0]?.txHash).toBe("0xpayout");
  });

  it("refuses to reclaim a failed policy, leaving recovery to a human", async () => {
    const store = new SettlementStore(path);
    await store.tryClaim(policy, ["bridge", "payout"], "u");
    await store.markFailed("0", "bridge", "attestation timed out");

    expect(await store.tryClaim(policy, ["bridge", "payout"], "u")).toBe(false);

    const record = await store.get("0");
    expect(record?.status).toBe("failed");
    expect(record?.failedLeg).toBe("bridge");
    expect(record?.legs[0]?.error).toBe("attestation timed out");
  });

  it("persists resume state so a bridge can be retried rather than re-run", async () => {
    const store = new SettlementStore(path);
    await store.tryClaim(policy, ["bridge", "payout"], "u");
    await store.updateLeg("0", "bridge", {
      attempts: 1,
      resumeState: { step: "attestation", burnTxHash: "0xburn" },
    });

    const afterRestart = new SettlementStore(path);
    const leg = (await afterRestart.get("0"))?.legs.find((l) => l.kind === "bridge");
    expect(leg?.resumeState).toEqual({ step: "attestation", burnTxHash: "0xburn" });
    expect(leg?.attempts).toBe(1);
  });

  it("records duration and custody gap on settlement", async () => {
    const store = new SettlementStore(path);
    await store.tryClaim(policy, ["payout"], "u");
    await store.markSettled("0");

    const record = await store.get("0");
    expect(record?.durationMs).toBeTypeOf("number");
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
    expect(record?.custodyGapMs).toBe(record?.durationMs);
    expect(record?.completedAt).toBeTypeOf("string");
  });

  it("reopens a failed settlement for manual retry", async () => {
    const store = new SettlementStore(path);
    await store.tryClaim(policy, ["payout"], "u");
    await store.markFailed("0", "payout", "boom");

    await store.reopen("0");
    expect(await store.get("0")).toBeUndefined();
    expect(await store.tryClaim(policy, ["payout"], "u")).toBe(true);
  });

  it("refuses to reopen a settled policy", async () => {
    const store = new SettlementStore(path);
    await store.tryClaim(policy, ["payout"], "u");
    await store.markSettled("0");

    await expect(store.reopen("0")).rejects.toThrow(/pay the recipient twice/);
  });

  it("lists settlements left mid-flight by a crash", async () => {
    const store = new SettlementStore(path);
    await store.tryClaim(policy, ["payout"], "u");
    await store.tryClaim({ ...policy, policyId: "1" }, ["payout"], "u");
    await store.markSettled("1");

    const stuck = await store.inProgress();
    expect(stuck.map((s) => s.policyId)).toEqual(["0"]);
  });

  it("rejects updates to unknown policies and legs", async () => {
    const store = new SettlementStore(path);
    await store.tryClaim(policy, ["payout"], "u");

    await expect(store.updateLeg("nope", "payout", {})).rejects.toThrow(/No settlement/);
    await expect(store.updateLeg("0", "fx", {})).rejects.toThrow(/has no fx leg/);
  });
});
