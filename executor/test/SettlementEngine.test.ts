import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettlementEngine, type LegRunner } from "../src/SettlementEngine.js";
import { SettlementStore, settlementKey } from "../src/store/SettlementStore.js";
import { toDecimalString } from "../src/legs/legs.js";
import { ARC_DOMAIN, BASE_SEPOLIA_DOMAIN } from "../src/config.js";
import type { LegKind, ReleasedPolicy } from "../src/types.js";
import type { ManagedWallet, WalletProvider } from "../src/wallet/WalletProvider.js";

const tmpFile = async () => join(await mkdtemp(join(tmpdir(), "covenant-")), "settlements.json");

const wallets: WalletProvider = {
  getWallet: async (role, domain): Promise<ManagedWallet> => ({
    role,
    domain,
    address: `0x${role}`,
    walletId: `${role}-${domain}`,
  }),
  getAdapter: () => ({}),
  getBalance: async () => "0",
  getBalanceAt: async () => "0",
};

function release(over: Partial<ReleasedPolicy> = {}): ReleasedPolicy {
  return {
    policyId: "1",
    periodIndex: 0,
    recipient: "0xrecipient",
    amount: "1000000",
    payoutCurrency: "USDC",
    destinationDomain: ARC_DOMAIN,
    executor: "0xexecutor",
    releaseTxHash: "0xrelease",
    releaseBlockNumber: 100n,
    ...over,
  };
}

/** Records which legs ran, and fails the ones named in `failing`. */
function tracker(failing: Partial<Record<LegKind, number>> = {}) {
  const ran: LegKind[] = [];
  const attempts: Record<string, number> = {};
  const runLeg: LegRunner = async (kind) => {
    ran.push(kind);
    attempts[kind] = (attempts[kind] ?? 0) + 1;
    const failuresLeft = failing[kind] ?? 0;
    if (attempts[kind]! <= failuresLeft) throw new Error(`${kind} boom`);
    return { kind, txHash: `0x${kind}`, explorerUrl: `https://x/${kind}` };
  };
  return { ran, attempts, runLeg };
}

const engineWith = (store: SettlementStore, runLeg: LegRunner, maxAttemptsPerLeg = 3) =>
  new SettlementEngine({ store, wallets, runLeg, maxAttemptsPerLeg, retryDelayMs: 0 });

describe("toDecimalString", () => {
  it("converts whole amounts", () => {
    expect(toDecimalString("1000000")).toBe("1");
    expect(toDecimalString("20000000")).toBe("20");
  });

  it("keeps fractional precision exactly", () => {
    expect(toDecimalString("1234567")).toBe("1.234567");
    expect(toDecimalString("100000")).toBe("0.1");
    expect(toDecimalString("1")).toBe("0.000001");
  });

  it("handles zero and sub-unit values", () => {
    expect(toDecimalString("0")).toBe("0");
    expect(toDecimalString("10")).toBe("0.00001");
  });

  it("does not lose precision on values beyond Number.MAX_SAFE_INTEGER", () => {
    // 2^53 base units is only about 9 billion USDC. Float division would round this.
    expect(toDecimalString("9007199254740993")).toBe("9007199254.740993");
  });
});

describe("SettlementEngine", () => {
  it("runs payout only for a same-chain USDC policy", async () => {
    const store = new SettlementStore(await tmpFile());
    const { ran, runLeg } = tracker();

    const record = await engineWith(store, runLeg).settle(release());

    expect(ran).toEqual(["payout"]);
    expect(record?.status).toBe("settled");
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runs fx then payout for an EURC policy on Arc", async () => {
    const store = new SettlementStore(await tmpFile());
    const { ran, runLeg } = tracker();

    await engineWith(store, runLeg).settle(release({ payoutCurrency: "EURC" }));

    expect(ran).toEqual(["fx", "payout"]);
  });

  it("runs a single bridge leg for a cross-chain policy, which is also the payout", async () => {
    const store = new SettlementStore(await tmpFile());
    const { ran, runLeg } = tracker();

    await engineWith(store, runLeg).settle(release({ destinationDomain: BASE_SEPOLIA_DOMAIN }));

    // A separate payout would need native ETH on the destination (V18). The mint delivers to
    // the recipient instead, so the bridge settles the policy on its own.
    expect(ran).toEqual(["bridge"]);
  });

  it("refuses a route the infrastructure cannot serve, before claiming it", async () => {
    const store = new SettlementStore(await tmpFile());
    const { ran, runLeg } = tracker();

    await expect(
      engineWith(store, runLeg).settle(
        release({ payoutCurrency: "EURC", destinationDomain: BASE_SEPOLIA_DOMAIN }),
      ),
    ).rejects.toThrow(/EURC cannot be paid out on Base Sepolia/);

    expect(ran).toEqual([]);
    // No half-created record left behind for an impossible policy.
    expect(await store.get(settlementKey("1", 0))).toBeUndefined();
  });

  it("never processes the same policy twice", async () => {
    const store = new SettlementStore(await tmpFile());
    const { ran, runLeg } = tracker();
    const engine = engineWith(store, runLeg);

    await engine.settle(release());
    const second = await engine.settle(release());

    expect(second).toBeUndefined();
    expect(ran).toEqual(["payout"]);
  });

  it("does not reprocess after a restart, which is the double-payment case", async () => {
    const path = await tmpFile();
    const first = tracker();
    await engineWith(new SettlementStore(path), first.runLeg).settle(release());

    // Fresh store and engine, same file on disk.
    const second = tracker();
    const result = await engineWith(new SettlementStore(path), second.runLeg).settle(release());

    expect(result).toBeUndefined();
    expect(second.ran).toEqual([]);
  });

  it("retries a failing leg and succeeds within the attempt budget", async () => {
    const store = new SettlementStore(await tmpFile());
    const { attempts, runLeg } = tracker({ payout: 2 });

    const record = await engineWith(store, runLeg).settle(release());

    expect(attempts.payout).toBe(3);
    expect(record?.status).toBe("settled");
    expect(record?.legs.find((l) => l.kind === "payout")?.attempts).toBe(3);
  });

  it("fails the settlement when a leg exhausts its attempts", async () => {
    const store = new SettlementStore(await tmpFile());
    const { attempts, runLeg } = tracker({ payout: 99 });

    const record = await engineWith(store, runLeg).settle(release());

    expect(attempts.payout).toBe(3);
    expect(record?.status).toBe("failed");
    expect(record?.failedLeg).toBe("payout");
    expect(record?.legs.find((l) => l.kind === "payout")?.error).toMatch(/payout boom/);
  });

  it("stops at the failing leg and does not run later ones", async () => {
    const store = new SettlementStore(await tmpFile());
    // The EURC path is the one with two legs. A failed conversion must not be followed by a
    // payout of funds that were never produced.
    const { ran, runLeg } = tracker({ fx: 99 });

    const record = await engineWith(store, runLeg).settle(release({ payoutCurrency: "EURC" }));

    expect(ran.filter((l) => l === "payout")).toEqual([]);
    expect(record?.failedLeg).toBe("fx");
    expect(record?.legs.find((l) => l.kind === "payout")?.status).toBe("pending");
  });

  it("will not silently retry a terminally failed settlement", async () => {
    const store = new SettlementStore(await tmpFile());
    const failing = tracker({ payout: 99 });
    await engineWith(store, failing.runLeg).settle(release());

    const retry = tracker();
    const result = await engineWith(store, retry.runLeg).settle(release());

    expect(result).toBeUndefined();
    expect(retry.ran).toEqual([]);
  });

  it("records a tx hash and explorer URL per succeeded leg", async () => {
    const store = new SettlementStore(await tmpFile());
    const { runLeg } = tracker();

    const record = await engineWith(store, runLeg).settle(
      release({ destinationDomain: BASE_SEPOLIA_DOMAIN }),
    );

    expect(record?.legs.map((l) => [l.kind, l.txHash, l.status])).toEqual([
      ["bridge", "0xbridge", "succeeded"],
    ]);
    expect(record?.legs[0]?.explorerUrl).toBe("https://x/bridge");
  });

  it("resumes an interrupted settlement without repeating completed legs", async () => {
    const path = await tmpFile();
    const policy = release({ destinationDomain: BASE_SEPOLIA_DOMAIN });
    const key = settlementKey(policy.policyId, policy.periodIndex);

    // Build the exact state a crash leaves behind: claimed, bridge done, payout still pending,
    // settlement still in_progress. Written through the store's own API so the test cannot drift
    // from how the engine actually persists things.
    const crashed = new SettlementStore(path);
    expect(await crashed.tryClaim(policy, ["bridge", "payout"], "https://x/release")).toBe(true);
    await crashed.updateLeg(key, "bridge", {
      status: "succeeded",
      txHash: "0xbridge",
      explorerUrl: "https://x/bridge",
      attempts: 1,
      completedAt: new Date().toISOString(),
    });
    expect((await crashed.get(key))?.status).toBe("in_progress");

    // A new process starts against the same file and resumes.
    const store = new SettlementStore(path);
    const resumed = tracker();
    const count = await engineWith(store, resumed.runLeg).resumeInterrupted();

    expect(count).toBe(1);
    expect(resumed.ran).toEqual(["payout"]);

    const record = await store.get(key);
    expect(record?.status).toBe("settled");
    // The already-completed bridge leg keeps its original hash and is not re-run.
    expect(record?.legs.find((l) => l.kind === "bridge")?.txHash).toBe("0xbridge");
    expect(record?.legs.find((l) => l.kind === "bridge")?.attempts).toBe(1);
  });

  it("pays the converted amount after an FX leg, not the policy amount", async () => {
    const store = new SettlementStore(await tmpFile());
    const amounts: Array<[LegKind, string]> = [];

    // 0.50 USDC in, 0.373862 EURC out. The payout must send the EURC figure: 0.50 EURC is not
    // in the wallet and sending it would fail, or worse, overpay from the working balance.
    const runLeg: LegRunner = async (kind, _policy, _wallets, amount) => {
      amounts.push([kind, amount]);
      if (kind === "fx") {
        return { kind, txHash: "0xfx", explorerUrl: "https://x/fx", outputAmount: "373862" };
      }
      return { kind, txHash: `0x${kind}`, explorerUrl: `https://x/${kind}` };
    };

    const record = await engineWith(store, runLeg).settle(
      release({ payoutCurrency: "EURC", amount: "500000" }),
    );

    expect(amounts).toEqual([
      ["fx", "500000"],
      ["payout", "373862"],
    ]);
    expect(record?.legs.find((l) => l.kind === "fx")?.outputAmount).toBe("373862");
  });

  it("does not rewrite the amount for legs that leave it unchanged", async () => {
    const store = new SettlementStore(await tmpFile());
    const amounts: Array<[LegKind, string]> = [];
    const runLeg: LegRunner = async (kind, _p, _w, amount) => {
      amounts.push([kind, amount]);
      return { kind, txHash: `0x${kind}`, explorerUrl: `https://x/${kind}` };
    };

    await engineWith(store, runLeg).settle(
      release({ destinationDomain: BASE_SEPOLIA_DOMAIN, amount: "1000000" }),
    );

    // The bridge is handed the full policy amount. What the recipient nets after the relay fee
    // is covered by D6's semantics, not by rewriting the amount mid-flight.
    expect(amounts).toEqual([["bridge", "1000000"]]);
  });

  it("resumes with the converted amount rather than the original", async () => {
    const path = await tmpFile();
    const policy = release({ payoutCurrency: "EURC", amount: "500000" });
    const key = settlementKey(policy.policyId, policy.periodIndex);

    const crashed = new SettlementStore(path);
    await crashed.tryClaim(policy, ["fx", "payout"], "https://x/release");
    await crashed.updateLeg(key, "fx", {
      status: "succeeded",
      txHash: "0xfx",
      outputAmount: "373862",
      attempts: 1,
    });

    const amounts: Array<[LegKind, string]> = [];
    const runLeg: LegRunner = async (kind, _p, _w, amount) => {
      amounts.push([kind, amount]);
      return { kind, txHash: `0x${kind}`, explorerUrl: `https://x/${kind}` };
    };

    await engineWith(new SettlementStore(path), runLeg).resumeInterrupted();

    // Without persisting outputAmount, a restart would pay 500000 EURC instead of 373862.
    expect(amounts).toEqual([["payout", "373862"]]);
  });

  it("never retries a leg that executed onchain but could not be recorded", async () => {
    const store = new SettlementStore(await tmpFile());
    let calls = 0;
    const runLeg: LegRunner = async (kind) => {
      calls++;
      return { kind, txHash: "0xburned", explorerUrl: "https://x" };
    };

    // Fail only the write that marks the leg succeeded. The leg itself has already run.
    const realUpdate = store.updateLeg.bind(store);
    store.updateLeg = async (policyId, kind, patch) => {
      if (patch.status === "succeeded") throw new TypeError("Do not know how to serialize a BigInt");
      return realUpdate(policyId, kind, patch);
    };

    await expect(engineWith(store, runLeg).settle(release())).rejects.toThrow(
      /SUCCEEDED onchain in 0xburned/,
    );

    // The whole point: one execution, no retry. Retrying would repeat a completed transfer.
    expect(calls).toBe(1);
  });

  it("persists a leg result containing BigInt values", async () => {
    const store = new SettlementStore(await tmpFile());
    const runLeg: LegRunner = async (kind) => ({
      kind,
      txHash: `0x${kind}`,
      explorerUrl: "https://x",
      // Raw SDK results carry BigInts. JSON.stringify throws on these unless handled.
      resumeState: { blockNumber: 123n, nested: { fee: 456n } },
    });

    const record = await engineWith(store, runLeg).settle(release());

    expect(record?.status).toBe("settled");
    const reloaded = await new SettlementStore((store as unknown as { filePath: string }).filePath).get(settlementKey("1", 0));
    expect(reloaded?.legs[0]?.resumeState).toEqual({ blockNumber: "123", nested: { fee: "456" } });
  });

  it("finds nothing to resume when every settlement is terminal", async () => {
    const store = new SettlementStore(await tmpFile());
    const { runLeg } = tracker();
    await engineWith(store, runLeg).settle(release());

    expect(await engineWith(store, runLeg).resumeInterrupted()).toBe(0);
  });
});
