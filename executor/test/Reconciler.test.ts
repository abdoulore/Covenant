import { describe, expect, it } from "vitest";
import { LogNotifier, notifierFromEnv, TelegramNotifier, type Notifier } from "../src/alerts/Notifier.js";
import { formatAge, Reconciler, type LedgerLike } from "../src/keeper/Reconciler.js";
import type { Cleared, Unsettled, UnsettledKind } from "../src/store/ReleaseLedger.js";

const TOKEN = "123456789:AAH-secret-token-value-do-not-log";

describe("TelegramNotifier", () => {
  it("posts plain text to the configured chat, without link previews", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const n = new TelegramNotifier({
      token: TOKEN, chatId: "42",
      fetchFn: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
    });
    await n.send("hello");
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]?.body).toEqual({ chat_id: "42", text: "hello", disable_web_page_preview: true });
  });

  /** The token sits in the URL. Nothing that reaches a log may contain it. */
  it("never puts the token in an error, even when fetch's own error quotes the URL", async () => {
    const n = new TelegramNotifier({
      token: TOKEN, chatId: "42",
      fetchFn: async (url) => { throw new Error(`request to ${url} failed, reason: ECONNRESET`); },
    });
    const err = await n.send("x").catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain("secret-token");
    expect(String((err as Error).message)).toMatch(/network error/);
  });

  it("reports Telegram's own reason for a refusal, and still not the token", async () => {
    const n = new TelegramNotifier({
      token: TOKEN, chatId: "42",
      fetchFn: async () => ({ ok: false, status: 400, json: async () => ({ description: "Bad Request: chat not found" }) }),
    });
    const err = (await n.send("x").catch((e: Error) => e)) as Error;
    expect(err.message).toContain("chat not found");
    expect(err.message).not.toContain("secret-token");
  });

  it("trims a message to Telegram's limit rather than having it refused", async () => {
    let sent = "";
    const n = new TelegramNotifier({
      token: TOKEN, chatId: "42",
      fetchFn: async (_u, init) => { sent = JSON.parse(init.body).text; return { ok: true, status: 200, json: async () => ({}) }; },
    });
    await n.send("a".repeat(5000));
    expect(sent.length).toBe(4096);
  });

  it("refuses something that is not a bot token, before sending anything", () => {
    expect(() => new TelegramNotifier({ token: "not-a-token", chatId: "1" })).toThrow(/does not look like a bot token/);
  });

  it("describes itself without the token", () => {
    expect(new TelegramNotifier({ token: TOKEN, chatId: "42" }).describe).not.toContain("secret");
  });
});

describe("notifierFromEnv", () => {
  it("uses Telegram when both values are set", () => {
    expect(notifierFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "42" })).toBeInstanceOf(TelegramNotifier);
  });
  it("falls back to the log when either is missing", () => {
    expect(notifierFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN })).toBeInstanceOf(LogNotifier);
    expect(notifierFromEnv({})).toBeInstanceOf(LogNotifier);
  });
});

// ---- the reconciler -------------------------------------------------------

function unsettled(over: Partial<Unsettled> = {}): Unsettled {
  return {
    vault: "0x3b507607ba48a65587a9a6136c36cd2f1132d498", policyId: "16", periodIndex: 0,
    releaseTxHash: `0x${"e".repeat(64)}`, blockNumber: "1", releasedAt: null,
    recipient: "0x11f4d66ebd6fab2d62e2ad024c798f8adf065100", amount: "100000",
    payoutCurrency: "USDC", destinationDomain: 26,
    kind: "unpaid", ageSeconds: 3_900_000, alertedState: null, ...over,
  };
}

/** A ledger in memory that honours markAlerted, so repeated passes behave as they would for real. */
class FakeLedger implements LedgerLike {
  alerts = new Map<string, string>();
  constructor(public open: Unsettled[] = [], public done: Cleared[] = []) {}
  private key = (r: { vault: string; policyId: string; periodIndex: number }) => `${r.vault}:${r.policyId}:${r.periodIndex}`;
  async unsettled() { return this.open.map((u) => ({ ...u, alertedState: this.alerts.get(this.key(u)) ?? u.alertedState })); }
  async cleared() { return this.done.filter((c) => (this.alerts.get(this.key(c)) ?? c.alertedState) !== "cleared"); }
  async markAlerted(r: { vault: string; policyId: string; periodIndex: number }, s: UnsettledKind | "cleared") { this.alerts.set(this.key(r), s); }
}

class FakeNotifier implements Notifier {
  describe = "fake";
  sent: string[] = [];
  failNext = 0;
  async send(text: string) {
    if (this.failNext > 0) { this.failNext--; throw new Error("down"); }
    this.sent.push(text);
  }
}

const reconciler = (ledger: LedgerLike, notifier: Notifier, extra: Partial<ConstructorParameters<typeof Reconciler>[0]> = {}) =>
  new Reconciler({ ledger, notifier, txUrl: (h) => `https://x/tx/${h}`, labelFor: () => "v4", ...extra });

describe("Reconciler", () => {
  it("says what is wrong, how much, and exactly what to run", () => {
    const msg = reconciler(new FakeLedger(), new FakeNotifier()).messageFor(unsettled());
    expect(msg).toContain("policy 16 on v4");
    expect(msg).toContain("never paid");
    expect(msg).toContain("0.10 USDC");
    expect(msg).toContain(`npm run settle-release -- 0x${"e".repeat(64)}`);
    expect(msg).toContain("npm run reconcile -- resolve");
  });

  it("announces a problem once, not on every pass", async () => {
    const ledger = new FakeLedger([unsettled()]);
    const notifier = new FakeNotifier();
    const r = reconciler(ledger, notifier);
    await r.runOnce();
    await r.runOnce();
    await r.runOnce();
    expect(notifier.sent).toHaveLength(1);
  });

  it("announces again when a problem changes kind", async () => {
    const ledger = new FakeLedger([unsettled({ kind: "stuck" })]);
    const notifier = new FakeNotifier();
    const r = reconciler(ledger, notifier);
    await r.runOnce();
    ledger.open = [unsettled({ kind: "failed" })];
    await r.runOnce();
    expect(notifier.sent.map((m) => (m.includes("failed") ? "failed" : "stuck"))).toEqual(["stuck", "failed"]);
  });

  /** Losing an alert is the outcome this exists to prevent. */
  it("retries an alert that could not be sent", async () => {
    const ledger = new FakeLedger([unsettled()]);
    const notifier = new FakeNotifier();
    notifier.failNext = 1;
    const r = reconciler(ledger, notifier);
    expect((await r.runOnce()).alerted).toBe(0);
    expect((await r.runOnce()).alerted).toBe(1);
    expect(notifier.sent).toHaveLength(1);
  });

  it("says when a problem clears, once", async () => {
    const c: Cleared = { ...unsettled(), alertedState: "unpaid", how: "settled", resolution: null };
    const ledger = new FakeLedger([], [c]);
    const notifier = new FakeNotifier();
    const r = reconciler(ledger, notifier);
    await r.runOnce();
    await r.runOnce();
    expect(notifier.sent).toEqual(["Covenant: resolved. policy 16 on v4 is now settled."]);
  });

  it("raises the alarm when the keeper falls behind, and stands down when it catches up", async () => {
    let lag = 2000n;
    const notifier = new FakeNotifier();
    const r = reconciler(new FakeLedger(), notifier, { keeperLag: async () => lag, lagAlertBlocks: 500n });
    expect((await r.runOnce()).lag).toBe("alerted");
    expect((await r.runOnce()).lag).toBe("ok");
    lag = 3n;
    expect((await r.runOnce()).lag).toBe("recovered");
    expect(notifier.sent).toHaveLength(2);
    expect(notifier.sent[0]).toContain("2000 blocks behind");
  });

  it("does not guess when the lag cannot be measured", async () => {
    const notifier = new FakeNotifier();
    const r = reconciler(new FakeLedger(), notifier, { keeperLag: async () => { throw new Error("rpc down"); } });
    expect((await r.runOnce()).lag).toBe("unknown");
    expect(notifier.sent).toHaveLength(0);
  });
});

describe("formatAge", () => {
  it("reads naturally at each scale", () => {
    expect(formatAge(45)).toBe("45s");
    expect(formatAge(600)).toBe("10m");
    expect(formatAge(7_200)).toBe("2h");
    expect(formatAge(3_900_000)).toBe("45d");
  });
});
