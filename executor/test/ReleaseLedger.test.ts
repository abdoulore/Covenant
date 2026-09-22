import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ReleaseLedger } from "../src/store/ReleaseLedger.js";
import { PostgresSettlementStore, pgConnectionString } from "../src/store/PostgresSettlementStore.js";
import type { ReleasedPolicy } from "../src/types.js";

/** Real Postgres, throwaway schema, same rules as the settlement store suite. */
const URL_ = process.env.TEST_DATABASE_URL;
const SCHEMA = `covenant_ledger_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const HOUR_AGO = () => new Date(Date.now() - 3_600_000);

describe.skipIf(!URL_)("ReleaseLedger", { timeout: 60_000 }, () => {
  let ledger: ReleaseLedger;
  let store: PostgresSettlementStore;
  let n = 0;
  /** A fresh vault per test so no two tests share a row. */
  const release = (over: Partial<ReleasedPolicy> = {}): ReleasedPolicy => {
    n++;
    return {
      vault: `0x${n.toString(16).padStart(40, "a")}`, policyId: "7", periodIndex: 0,
      recipient: `0x${"1".repeat(40)}`, amount: "100000", payoutCurrency: "USDC", destinationDomain: 26,
      executor: `0x${"2".repeat(40)}`, releaseTxHash: `0x${n.toString(16).padStart(64, "0")}`, releaseBlockNumber: 1000n,
      ...over,
    };
  };
  const listed = async (p: ReleasedPolicy, t?: Parameters<ReleaseLedger["unsettled"]>[0]) =>
    (await ledger.unsettled(t)).find((u) => u.vault === p.vault.toLowerCase() && u.policyId === p.policyId);

  beforeAll(async () => {
    ledger = new ReleaseLedger({ connectionString: URL_!, schema: SCHEMA });
    store = new PostgresSettlementStore({ connectionString: URL_!, schema: SCHEMA });
    await ledger.migrate();
  }, 60_000);

  afterAll(async () => {
    await ledger?.end();
    await store?.end();
    const admin = new pg.Client({ connectionString: pgConnectionString(URL_!) });
    await admin.connect();
    await admin.query(`drop schema if exists "${SCHEMA}" cascade`);
    await admin.end();
  }, 60_000);

  it("records a release once, however many times it is replayed", async () => {
    const before = await ledger.count();
    const p = release();
    await ledger.record(p, HOUR_AGO());
    await ledger.record(p, HOUR_AGO());
    expect(await ledger.count()).toBe(before + 1);
  });

  /** Policies 6, 15, 16 and 20 on v4: released, never settled, unnoticed for six weeks. */
  it("lists a release nobody settled as unpaid", async () => {
    const p = release();
    await ledger.record(p, HOUR_AGO());
    expect((await listed(p))?.kind).toBe("unpaid");
  });

  it("gives the keeper time to start before calling a release unpaid", async () => {
    const p = release();
    await ledger.record(p, new Date());
    expect(await listed(p)).toBeUndefined();
    expect((await listed(p, { unpaidAfterSeconds: 0, stuckAfterSeconds: 900 }))?.kind).toBe("unpaid");
  });

  it("stops listing a release once it is settled", async () => {
    const p = release();
    await ledger.record(p, HOUR_AGO());
    await store.tryClaim(p, ["payout"], "u");
    await store.markSettled(store.keyFor(p));
    expect(await listed(p, { unpaidAfterSeconds: 0, stuckAfterSeconds: 0 })).toBeUndefined();
  });

  it("lists a settlement that started and never finished as stuck, once it has had time", async () => {
    const p = release();
    await ledger.record(p, HOUR_AGO());
    await store.tryClaim(p, ["payout"], "u");
    expect(await listed(p)).toBeUndefined();
    expect((await listed(p, { unpaidAfterSeconds: 600, stuckAfterSeconds: 0 }))?.kind).toBe("stuck");
  });

  it("lists a failed settlement straight away", async () => {
    const p = release();
    await ledger.record(p, new Date());
    await store.tryClaim(p, ["payout"], "u");
    await store.markFailed(store.keyFor(p), "payout", "boom");
    expect((await listed(p))?.kind).toBe("failed");
  });

  it("uses the time the ledger first saw a release when its block time is unknown", async () => {
    const p = release();
    await ledger.record(p, null);
    expect(await listed(p)).toBeUndefined();
    expect((await listed(p, { unpaidAfterSeconds: 0, stuckAfterSeconds: 900 }))?.releasedAt).toBeNull();
  });

  it("stops listing a release a person has accounted for, and records why", async () => {
    const p = release();
    await ledger.record(p, HOUR_AGO());
    const resolved = await ledger.resolve(p.releaseTxHash, "paid by hand, receipt lost");
    expect(resolved).toHaveLength(1);
    expect(await listed(p)).toBeUndefined();
    expect((await ledger.byTx(p.releaseTxHash))[0]?.resolution).toBe("paid by hand, receipt lost");
  });

  it("refuses a resolution with no note", async () => {
    const p = release();
    await ledger.record(p, HOUR_AGO());
    await expect(ledger.resolve(p.releaseTxHash, "  ")).rejects.toThrow(/needs a note/);
  });

  it("remembers what it alerted on, and reports when that problem clears", async () => {
    const p = release();
    await ledger.record(p, HOUR_AGO());
    await ledger.markAlerted(p, "unpaid");
    expect((await listed(p))?.alertedState).toBe("unpaid");

    await store.tryClaim(p, ["payout"], "u");
    await store.markSettled(store.keyFor(p));
    const cleared = (await ledger.cleared()).find((c) => c.vault === p.vault.toLowerCase());
    expect(cleared?.how).toBe("settled");

    await ledger.markAlerted(p, "cleared");
    expect((await ledger.cleared()).find((c) => c.vault === p.vault.toLowerCase())).toBeUndefined();
  });

  it("finds a release by its transaction, with its settlement status", async () => {
    const p = release();
    await ledger.record(p, HOUR_AGO());
    await store.tryClaim(p, ["payout"], "u");
    const [found] = await ledger.byTx(p.releaseTxHash.toUpperCase().replace("0X", "0x"));
    expect(found?.policyId).toBe("7");
    expect(found?.settlementStatus).toBe("in_progress");
  });
});
