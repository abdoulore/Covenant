/**
 * Wires the settlement legs to the engine.
 *
 * Kept separate from both so the engine stays testable with a fake runner, and so the legs stay
 * unaware of orchestration. This file is the only place that knows which wallet plays which part
 * in each leg, which is exactly the knowledge that would otherwise be duplicated between the
 * canary script and a long-running daemon.
 */

import { AppKit } from "@circle-fin/app-kit";
import { ARC_DOMAIN } from "../config.js";
import {
  estimateBridgeFee,
  feeAllowance,
  runBridgeLeg,
  runFxLeg,
  runPayoutLeg,
  type LegContext,
  type LegResult,
} from "./legs.js";
import { createChainResolver, rpcUrlsFromEnv, type AppKitChainResolver } from "./appKitChains.js";
import type { LegRunner } from "../SettlementEngine.js";
import type { WalletProvider } from "../wallet/WalletProvider.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Read a recipient balance without letting a transient RPC failure abort the settlement.
 *
 * This read only feeds the fee record, so a failure to measure must degrade to "unmeasured", never
 * to a failed payment. The funds have already moved correctly by the time this runs.
 */
async function safeBalance(
  provider: WalletProvider,
  domain: number,
  address: string,
): Promise<bigint | undefined> {
  try {
    return BigInt(await provider.getBalanceAt(domain, address, "USDC"));
  } catch {
    return undefined;
  }
}

export interface LegRunnerOptions {
  kit?: AppKit;
  /** Server side only. Absent means App Kit calls run under public rate limits. */
  kitKey?: string | undefined;
  /** Defaults to the endpoints in the environment. See appKitChains.ts for why this matters. */
  resolveChain?: AppKitChainResolver;
}

export function createLegRunner(wallets: WalletProvider, opts: LegRunnerOptions = {}): LegRunner {
  const kit = opts.kit ?? new AppKit();
  const resolveChain = opts.resolveChain ?? createChainResolver(rpcUrlsFromEnv());

  return async (kind, policy, provider, amountBaseUnits) => {
    const ctx: LegContext = {
      kit,
      adapter: provider.getAdapter(),
      resolveChain,
      ...(opts.kitKey ? { kitKey: opts.kitKey } : {}),
    };

    // The FX leg only ever runs on Arc, because Arc is the only swap-enabled testnet (V4). The
    // executor wallet doing the swapping is therefore always the Arc one, regardless of where the
    // policy eventually pays out.
    const executorOnArc = await provider.getWallet("executor", ARC_DOMAIN);

    switch (kind) {
      case "fx": {
        /**
         * Measure what the swap produced, rather than trusting what it reported.
         *
         * App Kit's amountOut is not consistently denominated: the type docs show base units
         * ('99500000') while a live Arc swap returned the decimal string '0.364253'. Feeding that
         * into BigInt throws, and quietly guessing which convention applies would eventually pay
         * someone 364253 EURC instead of 0.364253. The balance delta is unambiguous and needs no
         * convention at all.
         */
        const before = await provider.getBalance(executorOnArc, policy.payoutCurrency);
        const result = await runFxLeg(ctx, executorOnArc, amountBaseUnits, policy.payoutCurrency);
        const after = await provider.getBalance(executorOnArc, policy.payoutCurrency);

        const produced = BigInt(after) - BigInt(before);
        if (produced <= 0n) {
          throw new Error(
            `Swap ${result.txHash} reported success but the ${policy.payoutCurrency} balance did ` +
              `not increase. Do not retry: the swap may have executed. Reconcile by hand.`,
          );
        }

        return { ...result, outputAmount: produced.toString() };
      }

      case "bridge": {
        /**
         * Gross up before burning so the recipient receives at least the policy amount.
         *
         * The forwarder deducts its fee from the minted amount and the mint lands directly on the
         * recipient, so there is no later step to top up a shortfall (D7). The executor therefore
         * burns the policy amount plus an allowance sized above the quoted fee, from its own
         * working balance, and any allowance the fee does not consume reaches the recipient rather
         * than being lost (D6). Quote and measured actual are recorded so the multiplier can be
         * tightened from data, and a recipient who still ends up short is flagged, not ignored.
         */
        const dest = policy.destinationDomain;
        const quote = await estimateBridgeFee(ctx, executorOnArc, dest, policy.recipient, amountBaseUnits);
        const allowance = feeAllowance(quote);
        const burnAmount = (BigInt(amountBaseUnits) + BigInt(allowance)).toString();

        const before = await safeBalance(provider, dest, policy.recipient);
        const result = await runBridgeLeg(ctx, executorOnArc, dest, policy.recipient, burnAmount);
        const delivered = await measureDelivered(provider, dest, policy.recipient, before);

        const fee: NonNullable<LegResult["fee"]> = { quote, allowance };
        if (delivered !== undefined) {
          fee.delivered = delivered.toString();
          fee.actual = (BigInt(burnAmount) - delivered).toString();
          fee.divergence = delivered < BigInt(amountBaseUnits);
        }

        return { ...result, fee };
      }

      case "payout": {
        // Only reached for same-chain settlements, so the funds are on Arc by construction.
        const source = await provider.getWallet("executor", ARC_DOMAIN);
        const available = await provider.getBalance(source, policy.payoutCurrency);
        return runPayoutLeg(
          ctx,
          source,
          policy.recipient,
          amountBaseUnits,
          policy.payoutCurrency,
          available,
        );
      }

      default: {
        // Exhaustiveness: adding a LegKind without handling it here becomes a compile error.
        const unreachable: never = kind;
        throw new Error(`No runner for leg ${String(unreachable)}`);
      }
    }
  };
}

/**
 * Measure what the bridge delivered by polling the recipient balance until it rises.
 *
 * The forwarded mint completes as part of kit.bridge, but the recipient balance can lag the call
 * return by an RPC beat. Poll a few times, then give up and report unmeasured rather than block.
 */
async function measureDelivered(
  provider: WalletProvider,
  domain: number,
  recipient: string,
  before: bigint | undefined,
): Promise<bigint | undefined> {
  if (before === undefined) return undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const after = await safeBalance(provider, domain, recipient);
    if (after !== undefined && after > before) return after - before;
    await sleep(2_000);
  }
  return undefined;
}
