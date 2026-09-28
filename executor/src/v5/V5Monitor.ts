/**
 * What can go wrong with a self-custody (v5) vault, and who needs to hear about it.
 *
 * v4's alerts asked "was this release paid out?", because the executor paid after the vault
 * released. In v5 the vault pays at the moment of release, so that question disappears. Three take
 * its place:
 *
 *   stalled    A policy the vault says is releasable has not been released for a while. The keeper
 *              is down or failing. Anyone can release it, so this is a nudge, not an emergency.
 *   deadline   A policy still holding money is within a day of its deadline. After it, the owner can
 *              reclaim, so a recipient owed money is about to lose the chance to be paid.
 *   unminted   The vault burned funds for a cross-chain payout and Circle has not completed the mint.
 *              The money is not lost: the burn is attested and the mint can be completed by anyone.
 *
 * Each is announced once when it appears and once when it clears. The state is kept in the store,
 * not in memory, so a restart does not announce everything again.
 */
import type { Notifier } from "../alerts/Notifier.js";
import type { V5Policy } from "./V5Reader.js";

export type ProblemKind = "stalled" | "deadline" | "unminted";

export interface Problem {
  /** Stable identity: the same problem on the next pass has the same key. */
  key: string;
  kind: ProblemKind;
  message: string;
}

export interface CrossChainRelease {
  releaseTx: string;
  policyId: string;
  periodIndex: number;
  amount: string;
  destinationDomain: number;
  /** Unix seconds the monitor first saw it. */
  seenAt: number;
  /** Circle's forwarding state, once known. COMPLETE means the recipient has been minted. */
  forwardState: string | null;
  mintTx: string | null;
}

/** Where the monitor keeps what it has seen and said. */
export interface MonitorStore {
  /** Record `key` as releasable now if it is not already; returns when it was first seen, unix s. */
  firstSeenReleasable(key: string, now: number): Promise<number>;
  forgetReleasable(keys: string[]): Promise<void>;
  openCrossChain(): Promise<CrossChainRelease[]>;
  updateCrossChain(releaseTx: string, forwardState: string | null, mintTx: string | null): Promise<void>;
  /** Keys currently announced, so only new problems are sent and only resolved ones are cleared. */
  announced(): Promise<Map<string, ProblemKind>>;
  markAnnounced(key: string, kind: ProblemKind): Promise<void>;
  markCleared(key: string): Promise<void>;
}

export interface V5MonitorOptions {
  vaultLabel: string;
  store: MonitorStore;
  notifier: Notifier;
  txUrl: (hash: string) => string;
  /** Circle's view of a burn: its forwarding state and the destination mint, if any. */
  forwardStatus: (releaseTx: string) => Promise<{ forwardState: string | null; mintTx: string | null }>;
  stalledAfterSeconds?: number;
  deadlineWarnSeconds?: number;
  unmintedAfterSeconds?: number;
  log?: (message: string) => void;
}

const h = (seconds: number) => (seconds < 5_400 ? `${Math.max(1, Math.round(seconds / 60))}m` : `${Math.round(seconds / 3_600)}h`);
const usdc = (base: bigint | string) => (Number(base) / 1e6).toFixed(2);

export class V5Monitor {
  private readonly stalledAfter: number;
  private readonly deadlineWarn: number;
  private readonly unmintedAfter: number;
  private readonly log: (message: string) => void;

  constructor(private readonly o: V5MonitorOptions) {
    this.stalledAfter = o.stalledAfterSeconds ?? 600;
    this.deadlineWarn = o.deadlineWarnSeconds ?? 86_400;
    this.unmintedAfter = o.unmintedAfterSeconds ?? 1_200;
    this.log = o.log ?? (() => {});
  }

  /** The problems visible now. Pure over its inputs apart from the store's first-seen clock. */
  async problems(pending: V5Policy[], now: number): Promise<Problem[]> {
    const out: Problem[] = [];
    const releasable = new Set<string>();

    for (const p of pending) {
      const key = `${this.o.vaultLabel}:${p.id}`;
      const left = Number(p.effectiveDeadline) - now;

      if (p.effectiveStatus === 1 && left > 0) {
        releasable.add(key);
        const since = await this.o.store.firstSeenReleasable(key, now);
        if (now - since >= this.stalledAfter) {
          out.push({
            key: `stalled:${key}`, kind: "stalled",
            message: `Covenant ${this.o.vaultLabel}: policy ${p.id} has been releasable for ${h(now - since)} and nobody has released it. ` +
              `The keeper may be down. Anyone can release it: npm run v5:release`,
          });
        }
      }

      const holding = p.funded + p.feeAllowance;
      if (holding > 0n && left > 0 && left <= this.deadlineWarn) {
        out.push({
          key: `deadline:${key}`, kind: "deadline",
          message: `Covenant ${this.o.vaultLabel}: policy ${p.id}'s deadline is in ${h(left)}, still holding ${usdc(holding)} USDC. ` +
            (p.effectiveStatus === 1
              ? `It is releasable: once the deadline passes, the owner can reclaim what the recipient is owed.`
              : `Its condition is not met; after the deadline, the owner can reclaim it.`),
        });
      }
    }

    // A policy that stopped being releasable, because it was released or for any other reason, no
    // longer has a first-seen time: if it becomes releasable again, the clock starts again.
    await this.o.store.forgetReleasable(pending.map((p) => `${this.o.vaultLabel}:${p.id}`).filter((k) => !releasable.has(k)));

    for (const c of await this.o.store.openCrossChain()) {
      if (c.forwardState === "COMPLETE") continue;
      let state = c.forwardState;
      let mint = c.mintTx;
      try {
        ({ forwardState: state, mintTx: mint } = await this.o.forwardStatus(c.releaseTx));
        await this.o.store.updateCrossChain(c.releaseTx, state, mint);
      } catch (err) {
        this.log(`v5 monitor: could not ask Circle about ${c.releaseTx}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (state !== "COMPLETE" && now - c.seenAt >= this.unmintedAfter) {
        out.push({
          key: `unminted:${c.releaseTx}`, kind: "unminted",
          message: `Covenant ${this.o.vaultLabel}: policy ${c.policyId} paid ${usdc(c.amount)} USDC cross-chain ${h(now - c.seenAt)} ago and Circle ` +
            `has not completed the mint (state ${state ?? "unknown"}). The funds are burned, not lost: the attested mint can be completed ` +
            `on the destination by anyone. Release: ${this.o.txUrl(c.releaseTx)}`,
        });
      }
    }
    return out;
  }

  /** One pass: find problems, announce the new ones, and clear the resolved ones. */
  async runOnce(pending: V5Policy[], now: number): Promise<{ announced: number; cleared: number }> {
    const current = await this.problems(pending, now);
    const before = await this.o.store.announced();
    let announced = 0;
    let cleared = 0;

    for (const p of current) {
      if (before.has(p.key)) continue;
      if (await this.send(p.message)) {
        await this.o.store.markAnnounced(p.key, p.kind);
        announced++;
      }
    }
    const still = new Set(current.map((p) => p.key));
    for (const [key, kind] of before) {
      if (still.has(key)) continue;
      const what = kind === "unminted"
        ? "the cross-chain mint has completed"
        : kind === "stalled"
          ? "it is no longer waiting to be released"
          : "it is no longer at risk from its deadline (released, cancelled, or past it)";
      if (await this.send(`Covenant ${this.o.vaultLabel}: resolved, ${key.split(":").slice(1).join(":")}: ${what}.`)) {
        await this.o.store.markCleared(key);
        cleared++;
      }
    }
    return { announced, cleared };
  }

  private async send(text: string): Promise<boolean> {
    try {
      await this.o.notifier.send(text);
      return true;
    } catch (err) {
      this.log(`v5 monitor: could not send an alert, will retry next pass: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
