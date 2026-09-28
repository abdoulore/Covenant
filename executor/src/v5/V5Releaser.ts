/**
 * The keeper's job for a self-custody (v5) vault: call release on every policy that can be released.
 *
 * It moves no money of its own and holds nobody's. The vault pays the recipient; the keeper only pays
 * the gas to ask it to, which on Arc is cents in USDC. Anyone else, the recipient included, could do
 * the same, since release is permissionless: this is the default, not a gatekeeper.
 *
 * Every call is simulated against the live contract before it is sent, and only sent if the
 * simulation succeeds. So the contract's own rules decide what is releasable, not a second copy of
 * them here that could drift, and a refused call costs nothing. For a pull-oracle policy that means
 * fetching a signed price and letting the vault judge it.
 */
import type { V5Policy, V5ReaderLike } from "./V5Reader.js";
import { V5_ORACLE_PULL } from "../chain/policyVaultV5.js";

export type V5Call =
  | { functionName: "release"; args: readonly [bigint] }
  | { functionName: "releasePeriod"; args: readonly [bigint] }
  | { functionName: "releaseWithProof"; args: readonly [bigint, `0x${string}`]; value: bigint };

export type SendOutcome = { sent: true; hash: string } | { sent: false; reason: string };

/** The chain as the releaser needs it. The real one simulates, then sends and waits. */
export interface V5Chain {
  trySend(call: V5Call): Promise<SendOutcome>;
  /** The oracle adapter's fee for verifying `proof`, in native value. */
  proofFee(adapter: `0x${string}`, proof: `0x${string}`): Promise<bigint>;
}

/** A signed price update for a feed, as a pull-oracle adapter expects it. */
export interface ProofSource {
  proof(feedId: string): Promise<`0x${string}`>;
}

export interface Released {
  policyId: bigint;
  functionName: V5Call["functionName"];
  hash: string;
}

/** A refusal worth a person's attention, as opposed to "not yet", which is the normal answer. */
const ROUTINE = new Set(["ConditionNotMet", "PeriodNotDue", "SweepBelowMin", "ReleasesPaused"]);

/** Most periods of one schedule released in a single pass, so one long-overdue payroll cannot starve the rest. */
const MAX_PERIODS_PER_PASS = 12;

export interface V5ReleaserOptions {
  reader: V5ReaderLike;
  chain: V5Chain;
  proofs?: ProofSource;
  now?: () => number;
  log?: (message: string) => void;
}

export class V5Releaser {
  private readonly log: (message: string) => void;
  private readonly now: () => number;

  constructor(private readonly o: V5ReleaserOptions) {
    this.log = o.log ?? (() => {});
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** One pass over the vault. Returns what was released. */
  async runOnce(): Promise<{ released: Released[]; paused: boolean }> {
    if (await this.o.reader.paused()) return { released: [], paused: true };

    const released: Released[] = [];
    const proofCache = new Map<string, Promise<`0x${string}` | undefined>>();
    for (const p of await this.o.reader.pending()) {
      if (BigInt(this.now()) >= p.effectiveDeadline) continue; // release is closed; the owner may reclaim
      try {
        if (p.recurring) {
          released.push(...(await this.releasePeriods(p)));
        } else if (p.conditionType === V5_ORACLE_PULL) {
          const r = await this.releaseWithProof(p, proofCache);
          if (r) released.push(r);
        } else if (p.effectiveStatus === 1) {
          const r = await this.send(p, { functionName: "release", args: [p.id] });
          if (r) released.push(r);
        }
      } catch (err) {
        this.log(`v5 releaser: policy ${p.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { released, paused: false };
  }

  private async releasePeriods(p: V5Policy): Promise<Released[]> {
    const out: Released[] = [];
    if (p.effectiveStatus !== 1) return out;
    // Every overdue period is owed. Release them one call each until the vault says none is due.
    for (let i = 0; i < MAX_PERIODS_PER_PASS; i++) {
      const r = await this.send(p, { functionName: "releasePeriod", args: [p.id] });
      if (!r) break;
      out.push(r);
    }
    return out;
  }

  private async releaseWithProof(
    p: V5Policy,
    cache: Map<string, Promise<`0x${string}` | undefined>>,
  ): Promise<Released | undefined> {
    if (!this.o.proofs) return undefined;
    // One price fetch per feed per pass, however many policies share it.
    if (!cache.has(p.feedId)) {
      cache.set(p.feedId, this.o.proofs.proof(p.feedId).catch((err) => {
        this.log(`v5 releaser: no price for feed ${p.feedId}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }));
    }
    const proof = await cache.get(p.feedId);
    if (!proof) return undefined;
    const fee = await this.o.chain.proofFee(p.adapter as `0x${string}`, proof);
    return this.send(p, { functionName: "releaseWithProof", args: [p.id, proof], value: fee });
  }

  private async send(p: V5Policy, call: V5Call): Promise<Released | undefined> {
    const outcome = await this.o.chain.trySend(call);
    if (outcome.sent) {
      this.log(`v5 releaser: policy ${p.id} ${call.functionName} sent ${outcome.hash}`);
      return { policyId: p.id, functionName: call.functionName, hash: outcome.hash };
    }
    if (!ROUTINE.has(outcome.reason)) this.log(`v5 releaser: policy ${p.id} ${call.functionName} refused: ${outcome.reason}`);
    return undefined;
  }
}
