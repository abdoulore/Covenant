/**
 * Turns a PolicyReleased event into a completed settlement.
 *
 * The ordering rule that matters: claim before work. A policy is written to the store before any
 * funds move, and a policy already in the store is never processed again. Everything else here is
 * bookkeeping around that one invariant, because the failure it prevents, paying a recipient
 * twice after a restart, is the one that cannot be undone.
 *
 * Retries are per leg and bounded. A leg that exhausts its attempts fails the whole settlement and
 * leaves the funds in the executor wallet for a human. Automatic retry of a terminally failed
 * settlement is how you double pay, so it does not happen without an explicit reopen().
 */

import { chainFor, planLegs } from "./config.js";
import type { SettlementStore } from "./store/SettlementStore.js";
import type { LegKind, ReleasedPolicy, SettlementRecord } from "./types.js";
import type { WalletProvider } from "./wallet/WalletProvider.js";
import type { LegResult } from "./legs/legs.js";

/**
 * Runs one leg. Injected rather than imported so the engine is testable without a live SDK,
 * and so a leg implementation can be swapped without touching orchestration.
 */
export type LegRunner = (
  kind: LegKind,
  policy: ReleasedPolicy,
  wallets: WalletProvider,
  /** Amount in hand entering this leg, base units. Not always policy.amount: an FX leg changes it. */
  amountBaseUnits: string,
) => Promise<LegResult>;

export interface SettlementEngineOptions {
  store: SettlementStore;
  wallets: WalletProvider;
  runLeg: LegRunner;
  maxAttemptsPerLeg?: number;
  /** Delay between attempts. Constant rather than exponential: legs are slow already. */
  retryDelayMs?: number;
  log?: (message: string) => void;
}

export class SettlementEngine {
  private readonly store: SettlementStore;
  private readonly wallets: WalletProvider;
  private readonly runLeg: LegRunner;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly log: (message: string) => void;

  constructor(opts: SettlementEngineOptions) {
    this.store = opts.store;
    this.wallets = opts.wallets;
    this.runLeg = opts.runLeg;
    this.maxAttempts = opts.maxAttemptsPerLeg ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 3_000;
    this.log = opts.log ?? (() => {});
  }

  /**
   * Settle one release.
   *
   * @returns the finished record, or undefined when the policy was already claimed. Undefined is
   *          the normal, healthy outcome of a replayed scan, not an error.
   */
  async settle(policy: ReleasedPolicy): Promise<SettlementRecord | undefined> {
    const chain = chainFor(policy.destinationDomain);

    // planLegs also validates the route, so an impossible combination fails before the claim and
    // does not leave an in_progress record behind.
    const legs = planLegs(policy.payoutCurrency, policy.destinationDomain);

    const claimed = await this.store.tryClaim(
      policy,
      legs,
      chainFor(26).explorerTxUrl(policy.releaseTxHash),
    );
    if (!claimed) {
      this.log(`policy ${policy.policyId}: already claimed, skipping`);
      return undefined;
    }

    this.log(
      `policy ${policy.policyId}: settling ${policy.amount} base units as ${policy.payoutCurrency} ` +
        `on ${chain.name}, legs: ${legs.join(" -> ")}`,
    );

    // The amount in hand, which an FX leg rewrites. Starts as the policy amount.
    let amount = policy.amount;
    for (const kind of legs) {
      const result = await this.runLegWithRetries(kind, policy, amount);
      if (!result) return this.store.get(policy.policyId);
      if (result.outputAmount) amount = result.outputAmount;
    }

    await this.store.markSettled(policy.policyId);
    const record = await this.store.get(policy.policyId);
    this.log(`policy ${policy.policyId}: settled in ${record?.durationMs}ms`);
    return record;
  }

  /** Resume settlements a crash left mid-flight. Called once at startup, before watching. */
  async resumeInterrupted(): Promise<number> {
    const stuck = await this.store.inProgress();
    for (const record of stuck) {
      this.log(`policy ${record.policyId}: resuming, interrupted after ${completedLegs(record)}`);
      const remaining = record.legs.filter((l) => l.status !== "succeeded").map((l) => l.kind);

      const policy = policyFrom(record);

      // Recover the amount in hand from whatever the completed legs produced, so a resumed
      // settlement pays the converted figure rather than the original policy amount.
      let amount = record.amount;
      for (const leg of record.legs) {
        if (leg.status === "succeeded" && leg.outputAmount) amount = leg.outputAmount;
      }

      let failed = false;
      for (const kind of remaining) {
        const result = await this.runLegWithRetries(kind, policy, amount);
        if (!result) {
          failed = true;
          break;
        }
        if (result.outputAmount) amount = result.outputAmount;
      }
      if (!failed) await this.store.markSettled(record.policyId);
    }
    return stuck.length;
  }

  private async runLegWithRetries(
    kind: LegKind,
    policy: ReleasedPolicy,
    amountBaseUnits: string,
  ): Promise<LegResult | undefined> {
    const startedAt = new Date().toISOString();
    await this.store.updateLeg(policy.policyId, kind, { startedAt });

    let lastError = "";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.store.updateLeg(policy.policyId, kind, { attempts: attempt });
      let result: LegResult;
      try {
        result = await this.runLeg(kind, policy, this.wallets, amountBaseUnits);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.log(`policy ${policy.policyId}: ${kind} attempt ${attempt}/${this.maxAttempts} failed: ${lastError}`);
        await this.store.updateLeg(policy.policyId, kind, { error: lastError });
        if (attempt < this.maxAttempts) await delay(this.retryDelayMs);
        continue;
      }

      /**
       * The leg has executed onchain. From here a retry would repeat a completed transfer, so
       * failing to record it must never be treated as failing to perform it.
       *
       * This is not hypothetical: a BigInt in an SDK result once made this write throw, and a
       * bridge that had already burned USDC was left marked pending, one resume away from being
       * paid twice. If the write fails, stop the settlement and demand a human.
       */
      try {
        await this.store.updateLeg(policy.policyId, kind, {
          status: "succeeded",
          txHash: result.txHash,
          explorerUrl: result.explorerUrl,
          completedAt: new Date().toISOString(),
          // Omit rather than write undefined: only FX legs change the amount in hand, and an
          // explicit undefined would overwrite a value on a resumed leg.
          ...(result.outputAmount === undefined ? {} : { outputAmount: result.outputAmount }),
          ...(result.fee === undefined ? {} : { fee: result.fee }),
          resumeState: result.resumeState,
        });

        // A recipient who still ends up short despite the gross-up is the one thing the buffer
        // exists to prevent. Surface it loudly; the money has already moved and cannot be undone.
        if (result.fee?.divergence) {
          this.log(
            `policy ${policy.policyId}: WARNING ${kind} delivered ${result.fee.delivered} base units, ` +
              `below the policy amount. Quote ${result.fee.quote}, allowance ${result.fee.allowance}, ` +
              `actual fee ${result.fee.actual}. The fee exceeded the buffer. Reconcile and raise the allowance.`,
          );
        }
      } catch (persistErr) {
        const detail = persistErr instanceof Error ? persistErr.message : String(persistErr);
        const message =
          `${kind} SUCCEEDED onchain in ${result.txHash} but the settlement record could not be ` +
          `written: ${detail}. Refusing to retry, because retrying would repeat a completed ` +
          `transfer. Reconcile this policy by hand against the transaction above.`;
        this.log(`policy ${policy.policyId}: ${message}`);
        await this.store.markFailed(policy.policyId, kind, message).catch(() => {});
        throw new Error(message);
      }

      this.log(`policy ${policy.policyId}: ${kind} ok ${result.txHash}`);
      return result;
    }

    await this.store.markFailed(policy.policyId, kind, lastError);
    this.log(
      `policy ${policy.policyId}: FAILED at ${kind}. Funds are in the executor wallet. ` +
        `Manual recovery required; the store will not retry this automatically.`,
    );
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function completedLegs(record: SettlementRecord): string {
  const done = record.legs.filter((l) => l.status === "succeeded").map((l) => l.kind);
  return done.length ? done.join(", ") : "no legs";
}

/** Rebuild the engine's input from a stored record, for resumption after a restart. */
function policyFrom(record: SettlementRecord): ReleasedPolicy {
  return {
    policyId: record.policyId,
    recipient: record.recipient,
    amount: record.amount,
    payoutCurrency: record.payoutCurrency,
    destinationDomain: record.destinationDomain,
    executor: "",
    releaseTxHash: record.releaseTxHash,
    releaseBlockNumber: 0n,
  };
}
