import { describe, expect, it } from "vitest";
import { V5Releaser, type SendOutcome, type V5Call, type V5Chain } from "../src/v5/V5Releaser.js";
import type { V5Policy, V5ReaderLike } from "../src/v5/V5Reader.js";

const NOW = 2_000_000_000;

function policy(over: Partial<V5Policy> = {}): V5Policy {
  return {
    id: 0n, owner: "0xowner", recipient: "0xrecipient", amount: 100n, funded: 100n, feeAllowance: 0n,
    maxFeePerTransfer: 0n, destinationDomain: 26, conditionType: 0, status: 0, recurring: false, isSweep: false,
    nextDue: 0n, stoppedAt: 0n, adapter: "0xadapter", feedId: "0xfeed", effectiveStatus: 1,
    effectiveDeadline: BigInt(NOW + 86_400), ...over,
  };
}

class Reader implements V5ReaderLike {
  constructor(public policies: V5Policy[], public isPaused = false) {}
  async pending() { return this.policies; }
  async paused() { return this.isPaused; }
}

/** Plays the contract: `decide` says what the simulation would answer for each call. */
class Chain implements V5Chain {
  calls: V5Call[] = [];
  constructor(private readonly decide: (call: V5Call, n: number) => SendOutcome = () => ({ sent: true, hash: "0xh" })) {}
  async trySend(call: V5Call) {
    this.calls.push(call);
    return this.decide(call, this.calls.length);
  }
  async proofFee() { return 7n; }
}

const releaser = (reader: V5ReaderLike, chain: V5Chain, extra: object = {}) =>
  new V5Releaser({ reader, chain, now: () => NOW, ...extra });

describe("V5Releaser", () => {
  it("releases a policy the vault says is releasable, and leaves the rest", async () => {
    const chain = new Chain();
    const r = await releaser(new Reader([policy({ id: 1n }), policy({ id: 2n, effectiveStatus: 0 })]), chain).runOnce();
    expect(r.released.map((x) => x.policyId)).toEqual([1n]);
    expect(chain.calls).toEqual([{ functionName: "release", args: [1n] }]);
  });

  it("does nothing while the vault is paused", async () => {
    const chain = new Chain();
    const r = await releaser(new Reader([policy()], true), chain).runOnce();
    expect(r.paused).toBe(true);
    expect(chain.calls).toHaveLength(0);
  });

  /** After the deadline, release is closed and the money is the owner's to reclaim. */
  it("never tries a policy past its deadline", async () => {
    const chain = new Chain();
    await releaser(new Reader([policy({ effectiveDeadline: BigInt(NOW) })]), chain).runOnce();
    expect(chain.calls).toHaveLength(0);
  });

  it("releases every overdue period until the vault says none is due", async () => {
    const chain = new Chain((_c, n) => (n <= 3 ? { sent: true, hash: `0x${n}` } : { sent: false, reason: "PeriodNotDue" }));
    const r = await releaser(new Reader([policy({ recurring: true })]), chain).runOnce();
    expect(r.released).toHaveLength(3);
    expect(chain.calls.every((c) => c.functionName === "releasePeriod")).toBe(true);
  });

  it("caps the periods of one schedule per pass, so it cannot starve the others", async () => {
    const chain = new Chain();
    const r = await releaser(new Reader([policy({ id: 1n, recurring: true }), policy({ id: 2n })]), chain).runOnce();
    expect(r.released.filter((x) => x.policyId === 1n)).toHaveLength(12);
    expect(r.released.some((x) => x.policyId === 2n)).toBe(true);
  });

  it("fetches one price per feed, and pays the adapter's fee", async () => {
    let fetched = 0;
    const proofs = { proof: async () => { fetched++; return "0xp" as const; } };
    const chain = new Chain();
    const pull = { conditionType: 5, effectiveStatus: 0 };
    await releaser(new Reader([policy({ id: 1n, ...pull }), policy({ id: 2n, ...pull })]), chain, { proofs }).runOnce();
    expect(fetched).toBe(1);
    expect(chain.calls).toEqual([
      { functionName: "releaseWithProof", args: [1n, "0xp"], value: 7n },
      { functionName: "releaseWithProof", args: [2n, "0xp"], value: 7n },
    ]);
  });

  it("says nothing about a routine 'not yet', and reports anything else", async () => {
    const logs: string[] = [];
    const chain = new Chain((c) => ({ sent: false, reason: (c.args[0] as bigint) === 1n ? "ConditionNotMet" : "FeeAllowanceShort" }));
    await releaser(new Reader([policy({ id: 1n }), policy({ id: 2n })]), chain, { log: (m: string) => logs.push(m) }).runOnce();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("policy 2");
    expect(logs[0]).toContain("FeeAllowanceShort");
  });

  it("keeps going when one policy throws", async () => {
    const chain = new Chain((c) => {
      if ((c.args[0] as bigint) === 1n) throw new Error("rpc hiccup");
      return { sent: true, hash: "0xh" };
    });
    const r = await releaser(new Reader([policy({ id: 1n }), policy({ id: 2n })]), chain).runOnce();
    expect(r.released.map((x) => x.policyId)).toEqual([2n]);
  });
});
