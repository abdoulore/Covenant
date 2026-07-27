/**
 * The three settlement legs, each a thin wrapper over one App Kit call.
 *
 * Every leg returns the same shape so the orchestrator can treat them uniformly and record them
 * identically. Legs never decide whether they should run; planLegs() in config.ts does that. A leg
 * that is asked to do something the infrastructure cannot support fails here, loudly, rather than
 * producing a partial settlement.
 *
 * Amounts crossing into App Kit are decimal strings ("1.00"), not base units. The vault and the
 * store speak base units at 6 decimals. Converting in exactly one place, toDecimalString(), keeps
 * that boundary from leaking. See docs/VERIFICATIONS.md V1a.
 */

import type { AppKit } from "@circle-fin/app-kit";
import { chainFor } from "../config.js";
import type { ManagedWallet, SigningAdapter } from "../wallet/WalletProvider.js";
import type { LegKind, PayoutCurrency, SettlementLeg } from "../types.js";

export interface LegResult {
  kind: LegKind;
  txHash: string;
  explorerUrl: string;
  /**
   * Base units produced by this leg, when it changes the amount in hand.
   *
   * An FX leg converts: 0.50 USDC in, 0.373862 EURC out. The payout that follows must send the
   * converted figure, not the policy amount, because 0.50 EURC does not exist in the wallet. A
   * bridge also reduces the amount (V17), but that shortfall is covered from the executor's
   * working balance under DECISIONS.md D6, so bridge legs leave this undefined.
   */
  outputAmount?: string;
  /** Fee accounting for a bridge leg's gross-up. Shape shared with the persisted record. */
  fee?: SettlementLeg["fee"];
  /** Opaque SDK result, persisted so a soft failure can be resumed rather than restarted (V11). */
  resumeState?: unknown;
}

export interface LegContext {
  kit: AppKit;
  adapter: SigningAdapter;
  /** Passed per call, never at construction. Server side only, never logged. */
  kitKey?: string;
  /**
   * Resolves a CCTP domain to the chain identifier App Kit should use.
   *
   * Supplying a full definition rather than a chain name is what lets the executor control which
   * RPC endpoints the SDK talks to. See appKitChains.ts.
   */
  resolveChain: (domain: number) => unknown;
}

/**
 * Convert base units at 6 decimals to the decimal string App Kit expects.
 *
 * Done with string arithmetic rather than division into a float. 1_000_000n / 1e6 happens to be
 * exact, but 1_234_567n / 1e6 is not representable, and a silently rounded payment amount is not
 * a recoverable error.
 */
export function toDecimalString(baseUnits: string, decimals = 6): string {
  const negative = baseUnits.startsWith("-");
  const digits = (negative ? baseUnits.slice(1) : baseUnits).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Parse a decimal string into base units. Inverse of toDecimalString.
 *
 * Rounds any precision beyond `decimals` upward. This is only ever applied to fee quotes, where
 * rounding up is the safe direction: it can only make the buffer slightly larger, never leave the
 * recipient short.
 */
export function fromDecimalString(decimal: string, decimals = 6): string {
  const negative = decimal.startsWith("-");
  const body = negative ? decimal.slice(1) : decimal;
  const [whole = "0", fraction = ""] = body.split(".");
  const kept = fraction.slice(0, decimals).padEnd(decimals, "0");
  let base = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(kept || "0");
  if (/[1-9]/.test(fraction.slice(decimals))) base += 1n; // ceil the discarded remainder
  return (negative ? -base : base).toString();
}

/**
 * The fee allowance added to a cross-chain burn, in base units.
 *
 *   allowance = max(3 * quote, quote + floor)
 *
 * Three times the quote, not two, because estimateBridge systematically under-predicts the
 * direct-to-recipient path: measured actuals were 1.0x the quote when minting to our own wallet
 * and 1.9x when minting to an arbitrary recipient, which is the only path used here (V18). The
 * floor guards a degenerate or failed quote. This is provisional and deliberately generous; every
 * settlement records quote against actual so the multiplier can be lowered from data. See D6/D7.
 */
export const FEE_FLOOR_BASE_UNITS = 50_000n; // 0.05 USDC

export function feeAllowance(quoteBaseUnits: string): string {
  const quote = BigInt(quoteBaseUnits);
  const triple = quote * 3n;
  const floored = quote + FEE_FLOOR_BASE_UNITS;
  return (triple > floored ? triple : floored).toString();
}

/** Conservative quote used when estimateBridge fails, so a flaky estimate never undersizes the buffer. */
export const DEFAULT_FEE_QUOTE_BASE_UNITS = "100000"; // 0.10 USDC, near the highest observed actual

/**
 * Quote the cross-chain forwarder fee in base units, before burning.
 *
 * Best effort by design: a failed estimate falls back to a conservative default rather than
 * blocking settlement, because the allowance built on top of it still guarantees the recipient is
 * not short-changed. The estimate is run against the exact parameters the burn will use, including
 * recipientAddress, since that path costs more than minting to our own wallet.
 */
export async function estimateBridgeFee(
  ctx: LegContext,
  source: ManagedWallet,
  destinationDomain: number,
  recipientAddress: string,
  amountBaseUnits: string,
): Promise<string> {
  try {
    const est = await (ctx.kit as unknown as {
      estimateBridge: (p: unknown) => Promise<{ fees?: Array<{ amount: string }> }>;
    }).estimateBridge({
      from: { adapter: ctx.adapter, chain: ctx.resolveChain(source.domain), address: source.address },
      to: { chain: ctx.resolveChain(destinationDomain), useForwarder: true, recipientAddress },
      amount: toDecimalString(amountBaseUnits),
      ...(ctx.kitKey ? { config: { kitKey: ctx.kitKey } } : {}),
    });

    const total = (est.fees ?? []).reduce((sum, f) => sum + BigInt(fromDecimalString(f.amount)), 0n);
    return total > 0n ? total.toString() : DEFAULT_FEE_QUOTE_BASE_UNITS;
  } catch {
    return DEFAULT_FEE_QUOTE_BASE_UNITS;
  }
}

/**
 * FX leg: swap USDC to the payout currency, on Arc.
 *
 * Only ever runs on Arc, because Arc Testnet is the only swap-enabled testnet (V4). The guard is
 * not defensive noise: routing a swap to any other chain silently fails inside the SDK, and this
 * turns that into a sentence someone can act on.
 */
export async function runFxLeg(
  ctx: LegContext,
  executor: ManagedWallet,
  amountBaseUnits: string,
  payoutCurrency: PayoutCurrency,
): Promise<LegResult> {
  const chain = chainFor(executor.domain);

  if (!chain.swapSupported) {
    throw new Error(
      `Swap is not available on ${chain.name}. App Kit supports swap on Arc Testnet only, ` +
        `so an FX leg cannot run here. See docs/VERIFICATIONS.md V4.`,
    );
  }
  if (payoutCurrency === "USDC") {
    throw new Error("FX leg invoked for a USDC payout. planLegs() should not have scheduled it.");
  }

  const result = await ctx.kit.swap({
    from: { adapter: ctx.adapter as never, chain: ctx.resolveChain(executor.domain) as never, address: executor.address },
    tokenIn: "USDC",
    tokenOut: payoutCurrency,
    amountIn: toDecimalString(amountBaseUnits),
    ...(ctx.kitKey ? { config: { kitKey: ctx.kitKey } } : {}),
  } as never);

  const txHash = (result as { txHash: string }).txHash;

  /**
   * Wait for the swap to actually settle before returning.
   *
   * amountOut is only populated once it has, and more importantly the caller measures the balance
   * delta to learn what was produced. Returning early would read a balance the swap has not
   * credited yet and conclude nothing happened.
   *
   * The reported amountOut is deliberately not used as the payout amount. Its denomination is not
   * consistent: the type docs show base units while a live Arc swap returned '0.364253'. The
   * caller's balance delta needs no such assumption.
   */
  if (typeof (ctx.kit as { waitForSwap?: unknown }).waitForSwap === "function") {
    await (ctx.kit as unknown as { waitForSwap: (r: unknown) => Promise<unknown> })
      .waitForSwap(result)
      .catch(() => undefined);
  }

  return {
    kind: "fx",
    txHash,
    explorerUrl: (result as { explorerUrl?: string }).explorerUrl ?? chain.explorerTxUrl(txHash),
    resumeState: result,
  };
}

/**
 * Bridge leg: move USDC to the destination chain via CCTP.
 *
 * USDC only, always. CCTP carries no other token and App Kit Bridge exposes none (V3). The bridge
 * lands funds in the executor's wallet on the destination chain, not the recipient's, because D1
 * makes payout a separate leg with its own hash.
 */
export async function runBridgeLeg(
  ctx: LegContext,
  source: ManagedWallet,
  destinationDomain: number,
  recipientAddress: string,
  burnAmountBaseUnits: string,
  useForwarder = true,
): Promise<LegResult> {
  const fromChain = chainFor(source.domain);
  const toChain = chainFor(destinationDomain);

  /**
   * The mint lands directly on the recipient, and this leg is therefore also the payout.
   *
   * On Arc, gas is USDC, so a wallet holding USDC can always pay its own way. On every other
   * chain it cannot. Circle's relayer covers the mint when `useForwarder` is set, but any later
   * transfer out of a destination wallet is an ordinary transaction needing native ETH that this
   * project never holds, which is exactly where an earlier design stalled with funds sitting in
   * an unspendable wallet (V18).
   *
   * Minting straight to the recipient removes the gas dependency and destination-side custody at
   * the same time. No adapter is passed for the destination: with a recipientAddress there is no
   * wallet of ours involved on that chain at all.
   */
  const result = await ctx.kit.bridge({
    from: { adapter: ctx.adapter as never, chain: ctx.resolveChain(source.domain) as never, address: source.address },
    to: {
      chain: ctx.resolveChain(destinationDomain) as never,
      useForwarder,
      recipientAddress,
    },
    amount: toDecimalString(burnAmountBaseUnits),
    ...(ctx.kitKey ? { config: { kitKey: ctx.kitKey } } : {}),
  } as never);

  // A bridge is several onchain steps (approve, burn, mint). The mint is the one that proves the
  // funds actually arrived, so prefer it; fall back to the last step that produced a hash.
  const steps = ((result as { steps?: Array<{ name: string; txHash?: string; explorerUrl?: string }> })
    .steps ?? []).filter((s) => s.txHash);
  const mint = steps.find((s) => /mint/i.test(s.name));
  const chosen = mint ?? steps.at(-1);

  if (!chosen?.txHash) {
    throw new Error(
      `Bridge returned no transaction hash for any step. State: ` +
        `${(result as { state?: string }).state ?? "unknown"}. Funds may be mid-flight; ` +
        `do not retry blindly, resume with retryBridge. See docs/VERIFICATIONS.md V11.`,
    );
  }

  return {
    kind: "bridge",
    txHash: chosen.txHash,
    explorerUrl: chosen.explorerUrl ?? toChain.explorerTxUrl(chosen.txHash),
    resumeState: result,
  };
}

/**
 * Payout leg: send the recipient exactly the policy amount.
 *
 * The recipient receives the full amount the policy names, not the amount that survived transit.
 * Bridging deducts a relay fee from the minted USDC (V17), so after a cross-chain leg the arrived
 * balance is smaller than the policy amount, and the difference comes out of the executor's
 * working balance. See docs/DECISIONS.md D6.
 *
 * `availableBaseUnits`, when supplied, is checked before spending anything so a shortfall reads as
 * a stated problem rather than an SDK transfer failure.
 */
export async function runPayoutLeg(
  ctx: LegContext,
  source: ManagedWallet,
  recipientAddress: string,
  amountBaseUnits: string,
  payoutCurrency: PayoutCurrency,
  availableBaseUnits?: string,
): Promise<LegResult> {
  const chain = chainFor(source.domain);

  if (!chain.payoutCurrencies.includes(payoutCurrency)) {
    throw new Error(
      `Cannot pay out ${payoutCurrency} on ${chain.name}. ` +
        `Supported there: ${chain.payoutCurrencies.join(", ")}. See docs/VERIFICATIONS.md V3.`,
    );
  }

  if (availableBaseUnits !== undefined && BigInt(availableBaseUnits) < BigInt(amountBaseUnits)) {
    const shortfall = BigInt(amountBaseUnits) - BigInt(availableBaseUnits);
    throw new Error(
      `Executor holds ${toDecimalString(availableBaseUnits)} ${payoutCurrency} on ${chain.name} ` +
        `but the policy owes the recipient ${toDecimalString(amountBaseUnits)}, short by ` +
        `${toDecimalString(shortfall.toString())}. Transit fees are deducted from the amount in ` +
        `flight (V17), so the executor must carry a working balance to cover them. ` +
        `Top up the executor wallet, then reopen this settlement.`,
    );
  }

  const result = await ctx.kit.send({
    from: { adapter: ctx.adapter as never, chain: ctx.resolveChain(source.domain) as never, address: source.address },
    to: recipientAddress,
    amount: toDecimalString(amountBaseUnits),
    token: payoutCurrency,
    ...(ctx.kitKey ? { config: { kitKey: ctx.kitKey } } : {}),
  } as never);

  const txHash = (result as { txHash?: string }).txHash;
  if (!txHash) {
    throw new Error(`Payout returned no transaction hash. State: ${(result as { state?: string }).state}`);
  }

  return {
    kind: "payout",
    txHash,
    explorerUrl: (result as { explorerUrl?: string }).explorerUrl ?? chain.explorerTxUrl(txHash),
    resumeState: result,
  };
}
