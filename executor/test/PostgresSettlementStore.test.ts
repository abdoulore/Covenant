import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresSettlementStore, pgConnectionString } from "../src/store/PostgresSettlementStore.js";
import { SettlementEngine, type LegRunner } from "../src/SettlementEngine.js";
import type { ReleasedPolicy } from "../src/types.js";
import type { WalletProvider } from "../src/wallet/WalletProvider.js";

/**
 * These run against a real Postgres, because the property under test is the database refusing a
 * duplicate, and a mock would only test the mock.
 *
 * TEST_DATABASE_URL must be set explicitly; DATABASE_URL is never used here, so a test run cannot
 * reach a database it was not pointed at. Each run creates its own schema and drops it afterwards.
 * Without the variable the suite is skipped, and says so, rather than failing.
 */
const URL_ = process.env.TEST_DATABASE_URL;
const SCHEMA = `covenant_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

const V4 = "0x3b507607ba48a65587a9a6136c36cd2f1132d498";
const V5 = "0x5555555555555555555555555555555555555555";

function release(over: Partial<ReleasedPolicy> = {}): ReleasedPolicy {
  return {
    vault: V4, policyId: "3", periodIndex: 0,
    recipient: `0x${"1".repeat(40)}`, amount: "100000", payoutCurrency: "USDC", destinationDomain: 26,
    executor: `0x${"2".repeat(40)}`, releaseTxHash: `0x${"a".repeat(64)}`, releaseBlockNumber: 1n,
    ...over,
  };
}

/**
 * Skipping locally is a convenience. Skipping in CI would mean the one suite that proves D15 holds
 * silently stopped running, and every build would still be green. So in CI, a missing database is
 * a failure.
 */
describe("database suite is wired up", () => {
  it.runIf(process.env.CI)("has a database in CI", () => {
    expect(URL_, "TEST_DATABASE_URL must be set in CI, or the D15 suite is not running").toBeTruthy();
  });
});

describe("pgConnectionString", () => {
  it("pins full certificate verification when the URL asks for require", () => {
    const out = new URL(pgConnectionString("postgres://u:p@h/db?sslmode=require"));
    expect(out.searchParams.get("sslmode")).toBe("verify-full");
  });

  it("leaves an explicit choice it does not weaken alone", () => {
    const out = new URL(pgConnectionString("postgres://u:p@h/db?sslmode=disable"));
    expect(out.searchParams.get("sslmode")).toBe("disable");
  });
});

// Every statement is a network round trip to a hosted database, so the default 5 s is too tight.
describe.skipIf(!URL_)("PostgresSettlementStore", { timeout: 60_000 }, () => {
  let store: PostgresSettlementStore;
  let admin: pg.Client;
  let n = 0;
  /** A fresh vault address per test, so tests never share rows. */
  const vault = () => `0x${(++n).toString(16).padStart(40, "0")}`;

  beforeAll(async () => {
    store = new PostgresSettlementStore({ connectionString: URL_!, schema: SCHEMA });
    await store.migrate();
    admin = new pg.Client({ connectionString: pgConnectionString(URL_!) });
    await admin.connect();
  }, 60_000);

  afterAll(async () => {
    await store?.end();
    await admin?.query(`drop schema if exists "${SCHEMA}" cascade`);
    await admin?.end();
  }, 60_000);

  it("claims a release once", async () => {
    const p = release({ vault: vault() });
    expect(await store.tryClaim(p, ["payout"], "u")).toBe(true);
    expect(await store.tryClaim(p, ["payout"], "u")).toBe(false);
  });

  /** The defect itself. Same policy number, different deployment, both must be claimable. */
  it("keeps the same policy id on two vaults apart", async () => {
    expect(await store.tryClaim(release({ vault: V4, policyId: "3" }), ["payout"], "u")).toBe(true);
    expect(await store.tryClaim(release({ vault: V5, policyId: "3" }), ["payout"], "u")).toBe(true);

    const v4 = await store.get(store.keyFor({ vault: V4, policyId: "3", periodIndex: 0 }));
    const v5 = await store.get(store.keyFor({ vault: V5, policyId: "3", periodIndex: 0 }));
    expect(v4?.vault).toBe(V4);
    expect(v5?.vault).toBe(V5);
  });

  it("settles each period of a recurring policy independently", async () => {
    const v = vault();
    expect(await store.tryClaim(release({ vault: v, periodIndex: 1 }), ["payout"], "u")).toBe(true);
    expect(await store.tryClaim(release({ vault: v, periodIndex: 2 }), ["payout"], "u")).toBe(true);
  });

  it("treats a checksummed vault address as the same vault", async () => {
    const v = vault();
    expect(await store.tryClaim(release({ vault: v }), ["payout"], "u")).toBe(true);
    expect(await store.tryClaim(release({ vault: v.toUpperCase().replace("0X", "0x") }), ["payout"], "u")).toBe(false);
  });

  /** A vault-less claim is the defect coming back. Loud, not silent. */
  it("refuses to claim a release that has no vault", async () => {
    await expect(store.tryClaim(release({ vault: "" }), ["payout"], "u")).rejects.toThrow(/no valid vault/);
  });

  it("rejects a legacy key rather than guessing a vault", async () => {
    await expect(store.get("3:0")).rejects.toThrow(/Not a vault-scoped settlement key/);
  });

  it("lets only one of many simultaneous claims win", async () => {
    const p = release({ vault: vault() });
    const results = await Promise.all(Array.from({ length: 10 }, () => store.tryClaim(p, ["payout"], "u")));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  /** What the JSON file could never promise: two keepers, one store, one payment. */
  it("lets only one of two separate store instances claim a release", async () => {
    const other = new PostgresSettlementStore({ connectionString: URL_!, schema: SCHEMA });
    try {
      const p = release({ vault: vault() });
      const [a, b] = await Promise.all([store.tryClaim(p, ["payout"], "u"), other.tryClaim(p, ["payout"], "u")]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
    } finally {
      await other.end();
    }
  });

  it("records leg progress and keeps the status column in step with the record", async () => {
    const p = release({ vault: vault() });
    await store.tryClaim(p, ["payout"], "u");
    const key = store.keyFor(p);

    await store.updateLeg(key, "payout", { status: "succeeded", txHash: "0xpay", resumeState: { big: 7n } });
    await store.markSettled(key);

    const r = await store.get(key);
    expect(r?.status).toBe("settled");
    expect(r?.legs[0]?.txHash).toBe("0xpay");
    // BigInt survives as a string instead of throwing on the way in.
    expect((r?.legs[0]?.resumeState as { big: string }).big).toBe("7");

    const col = await admin.query(
      `select status from "${SCHEMA}".settlements where vault = $1 and policy_id = $2`,
      [p.vault, p.policyId],
    );
    expect(col.rows[0].status).toBe("settled");
  });

  it("lists only unfinished settlements as in progress", async () => {
    const done = release({ vault: vault() });
    const open = release({ vault: vault() });
    await store.tryClaim(done, ["payout"], "u");
    await store.tryClaim(open, ["payout"], "u");
    await store.markSettled(store.keyFor(done));

    const keys = (await store.inProgress()).map((r) => store.keyFor(r));
    expect(keys).toContain(store.keyFor(open));
    expect(keys).not.toContain(store.keyFor(done));
  });

  it("refuses to reopen a settled payment, and reopens a failed one", async () => {
    const settled = release({ vault: vault() });
    await store.tryClaim(settled, ["payout"], "u");
    await store.markSettled(store.keyFor(settled));
    await expect(store.reopen(store.keyFor(settled))).rejects.toThrow(/pay the recipient twice/);

    const failed = release({ vault: vault() });
    await store.tryClaim(failed, ["payout"], "u");
    await store.markFailed(store.keyFor(failed), "payout", "boom");
    await store.reopen(store.keyFor(failed));
    expect(await store.tryClaim(failed, ["payout"], "u")).toBe(true);
  });

  /**
   * The regression test D15 exists for, end to end through the engine.
   *
   * Under the old key, v5 policy 3 looked like the already-paid v4 policy 3: the engine logged
   * "already claimed, skipping" and never ran the payout. It must run it.
   */
  it("pays v5 policy 3 after v4 policy 3 has already been paid", async () => {
    const paid: string[] = [];
    const runLeg: LegRunner = async (kind, policy) => {
      paid.push(`${policy.vault}:${policy.policyId}`);
      return { kind, txHash: `0x${paid.length}`, explorerUrl: "u" };
    };
    const engine = new SettlementEngine({
      store, runLeg, wallets: {} as WalletProvider, maxAttemptsPerLeg: 1, retryDelayMs: 0,
    });

    const v4 = `0x${"4".repeat(40)}`;
    const v5 = `0x${"6".repeat(40)}`;
    await engine.settle(release({ vault: v4, policyId: "3" }));
    const second = await engine.settle(release({ vault: v5, policyId: "3" }));

    expect(second?.status).toBe("settled");
    expect(paid).toEqual([`${v4}:3`, `${v5}:3`]);

    // And a genuine replay of the same v5 release is still refused.
    expect(await engine.settle(release({ vault: v5, policyId: "3" }))).toBeUndefined();
    expect(paid).toHaveLength(2);
  }, 120_000);
});
