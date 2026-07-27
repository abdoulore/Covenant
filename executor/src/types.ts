/**
 * Domain types shared across the executor.
 *
 * Amounts are always strings in the 6 decimal USDC ERC-20 view, never numbers and never the
 * 18 decimal native view. See docs/VERIFICATIONS.md V1a. Using a JS number for a token amount
 * is a correctness bug waiting for a large policy, so the type system forbids it here.
 */

export type PayoutCurrency = "USDC" | "EURC";

/** Mirrors PolicyVault.ConditionType. */
export type ConditionType = "Timelock" | "Approval";

/** A PolicyReleased event, decoded. This is the executor's input. */
export interface ReleasedPolicy {
  policyId: string;
  recipient: string;
  /** Base units, 6 decimals. */
  amount: string;
  payoutCurrency: PayoutCurrency;
  /** CCTP domain of the payout chain. */
  destinationDomain: number;
  executor: string;
  /** Arc transaction hash of the release. */
  releaseTxHash: string;
  releaseBlockNumber: bigint;
}

export type LegKind = "fx" | "bridge" | "payout";

export type LegStatus = "pending" | "succeeded" | "failed";

export interface SettlementLeg {
  kind: LegKind;
  status: LegStatus;
  txHash?: string;
  /** Explorer URL for txHash, precomputed so RESULTS.md needs no lookup logic. */
  explorerUrl?: string;
  startedAt?: string;
  completedAt?: string;
  attempts: number;
  error?: string;
  /**
   * Base units this leg produced, when it changed the amount in hand (an FX conversion).
   * Persisted so a resumed settlement pays the converted figure rather than re-deriving it,
   * which after a restart it could not do without re-reading the swap.
   */
  outputAmount?: string;
  /**
   * Fee accounting for the bridge leg's gross-up. All base units.
   *
   * The cross-chain forwarder deducts its fee from the minted amount, and the mint lands directly
   * on the recipient, so there is no later step to correct a shortfall. The executor therefore
   * burns amount plus an allowance sized above the quoted fee, guaranteeing the recipient receives
   * at least the policy amount. Quote and actual are both recorded so the allowance multiplier can
   * be tightened from data, and so any divergence is visible rather than silently absorbed.
   * See docs/DECISIONS.md D6 and D7.
   */
  fee?: {
    /** Fee predicted by estimateBridge before the burn. */
    quote: string;
    /** Amount added to the burn on top of the policy amount. Always >= quote. */
    allowance: string;
    /** Fee actually charged, measured as burned minus delivered. Absent if unmeasurable. */
    actual?: string;
    /** Base units the recipient actually received. Absent if the balance could not be read. */
    delivered?: string;
    /** True when the recipient received less than the policy amount, the promise this prevents. */
    divergence?: boolean;
  };
  /**
   * Opaque SDK result needed to resume a partially completed leg.
   *
   * App Kit soft errors are recovered with kit.retry(result), NOT by re-invoking the operation.
   * Re-running bridge() from scratch after a failure risks double spending. Persisting this is
   * therefore load-bearing, not a convenience. See docs/VERIFICATIONS.md V11.
   */
  resumeState?: unknown;
}

export type SettlementStatus = "in_progress" | "settled" | "failed";

export interface SettlementRecord {
  policyId: string;
  status: SettlementStatus;
  recipient: string;
  amount: string;
  payoutCurrency: PayoutCurrency;
  destinationDomain: number;
  /** The release that triggered this settlement. */
  releaseTxHash: string;
  releaseExplorerUrl: string;
  /** Ordered. The order itself is a claim about the route and belongs in the record. */
  legs: SettlementLeg[];
  startedAt: string;
  completedAt?: string;
  /** Wall clock milliseconds from release observed to final payout confirmed. */
  durationMs?: number;
  /**
   * Milliseconds the executor wallet held funds, from release to final payout.
   * This is the custody gap from docs/DECISIONS.md D2, measured rather than asserted.
   */
  custodyGapMs?: number;
  failedLeg?: LegKind;
}
