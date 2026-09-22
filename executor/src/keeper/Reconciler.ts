/**
 * Compares what the chain released with what was settled, and tells a person about the difference.
 *
 * Each problem is announced once, when it first appears or changes kind (stuck becoming failed, for
 * example), and once more when it clears. An alert repeated every few minutes stops being read,
 * which is worse than none. The alert state lives in the ledger, not in memory, so a restart does
 * not re-announce everything.
 *
 * A failed send is not recorded as sent, so the next pass tries again. Losing an alert is the one
 * outcome this class exists to prevent.
 *
 * It also watches the keeper's lag behind the chain head. A keeper that has stopped advancing is
 * how releases pile up unpaid in the first place, and it is visible before any single release has
 * waited long enough to count as stranded.
 */
import type { Notifier } from "../alerts/Notifier.js";
import type { Cleared, LedgerRelease, ReconcileThresholds, Unsettled, UnsettledKind } from "../store/ReleaseLedger.js";
import { DEFAULT_THRESHOLDS } from "../store/ReleaseLedger.js";

export interface LedgerLike {
  unsettled(t?: ReconcileThresholds): Promise<Unsettled[]>;
  cleared(): Promise<Cleared[]>;
  markAlerted(r: Pick<LedgerRelease, "vault" | "policyId" | "periodIndex">, state: UnsettledKind | "cleared"): Promise<void>;
}

export interface ReconcilerOptions {
  ledger: LedgerLike;
  notifier: Notifier;
  /** Explorer link for an Arc transaction. */
  txUrl: (hash: string) => string;
  /** "v4" rather than an address, where the registry knows the vault. */
  labelFor: (vault: string) => string;
  thresholds?: ReconcileThresholds;
  /** Blocks the keeper is behind the head, or null if it cannot be measured right now. */
  keeperLag?: () => Promise<bigint | null>;
  /** Lag at which to raise the alarm. Roughly five minutes of Arc blocks by default. */
  lagAlertBlocks?: bigint;
  log?: (message: string) => void;
}

export function formatAge(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 5_400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172_800) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

const usdc = (base: string) => (Number(base) / 1e6).toFixed(2);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export class Reconciler {
  private readonly o: Required<Omit<ReconcilerOptions, "keeperLag">> & Pick<ReconcilerOptions, "keeperLag">;
  private lagAlerted = false;

  constructor(opts: ReconcilerOptions) {
    this.o = {
      thresholds: DEFAULT_THRESHOLDS,
      lagAlertBlocks: 500n,
      log: () => {},
      ...opts,
    };
  }

  /** The alert for one release. Plain text: it has to read the same in Telegram and in a log. */
  messageFor(u: Unsettled): string {
    const where = `policy ${u.policyId}${u.periodIndex ? ` period ${u.periodIndex}` : ""} on ${this.o.labelFor(u.vault)}`;
    const what = `${usdc(u.amount)} USDC for ${short(u.recipient)}`;
    const headline =
      u.kind === "unpaid"
        ? `Covenant: ${where} was released ${formatAge(u.ageSeconds)} ago and never paid. ${what} is sitting in the executor wallet.`
        : u.kind === "stuck"
          ? `Covenant: the settlement of ${where} started and has not finished. ${what} may be part-way through a leg.`
          : `Covenant: the settlement of ${where} failed and will not retry on its own. ${what} is waiting on a person.`;
    const next =
      u.kind === "unpaid"
        ? `Pay it: npm run settle-release -- ${u.releaseTxHash}\nOr, if it was paid another way: npm run reconcile -- resolve ${u.releaseTxHash} --note "how it was paid"`
        : `Check it: npm run reconcile -- show ${u.releaseTxHash}`;
    return `${headline}\nRelease: ${this.o.txUrl(u.releaseTxHash)}\n${next}`;
  }

  clearedMessageFor(c: Cleared): string {
    const where = `policy ${c.policyId}${c.periodIndex ? ` period ${c.periodIndex}` : ""} on ${this.o.labelFor(c.vault)}`;
    return c.how === "settled"
      ? `Covenant: resolved. ${where} is now settled.`
      : `Covenant: resolved. ${where} was accounted for by hand: ${c.resolution ?? "no note"}.`;
  }

  /** One pass. Returns what was sent, for logging and tests. */
  async runOnce(): Promise<{ alerted: number; cleared: number; lag: "ok" | "alerted" | "recovered" | "unknown" }> {
    let alerted = 0;
    let cleared = 0;

    for (const u of await this.o.ledger.unsettled(this.o.thresholds)) {
      if (u.alertedState === u.kind) continue;
      if (await this.trySend(this.messageFor(u))) {
        await this.o.ledger.markAlerted(u, u.kind);
        alerted++;
      }
    }

    for (const c of await this.o.ledger.cleared()) {
      if (await this.trySend(this.clearedMessageFor(c))) {
        await this.o.ledger.markAlerted(c, "cleared");
        cleared++;
      }
    }

    return { alerted, cleared, lag: await this.checkLag() };
  }

  private async checkLag(): Promise<"ok" | "alerted" | "recovered" | "unknown"> {
    if (!this.o.keeperLag) return "unknown";
    let behind: bigint | null;
    try {
      behind = await this.o.keeperLag();
    } catch {
      behind = null;
    }
    if (behind === null) return "unknown";

    if (behind > this.o.lagAlertBlocks && !this.lagAlerted) {
      const sent = await this.trySend(
        `Covenant: the keeper is ${behind} blocks behind the chain, about ${formatAge(Number(behind) * 0.57)}. ` +
          `Releases in that window are not being paid until it catches up. Check its log for scan errors.`,
      );
      if (sent) this.lagAlerted = true;
      return sent ? "alerted" : "unknown";
    }
    if (behind <= this.o.lagAlertBlocks && this.lagAlerted) {
      const sent = await this.trySend(`Covenant: resolved. The keeper has caught up with the chain.`);
      if (sent) this.lagAlerted = false;
      return sent ? "recovered" : "unknown";
    }
    return "ok";
  }

  private async trySend(text: string): Promise<boolean> {
    try {
      await this.o.notifier.send(text);
      return true;
    } catch (err) {
      this.o.log(`reconciler: could not send an alert, will retry next pass: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
