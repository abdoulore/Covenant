/**
 * Smoke test a single settlement leg against live infrastructure.
 *
 *   npx tsx --env-file=../.env scripts/try-leg.ts fx      0.50
 *   npx tsx --env-file=../.env scripts/try-leg.ts bridge  0.50
 *   npx tsx --env-file=../.env scripts/try-leg.ts payout  0.50
 *
 * Exists because the leg wrappers encode assumptions about App Kit's parameter shapes that only
 * a real call can confirm. Running one leg at a time with a small amount is far cheaper than
 * discovering a wrong argument in the middle of a full canary run, with funds already in flight.
 *
 * Spends real testnet USDC from the executor wallet.
 */

import { AppKit } from "@circle-fin/app-kit";
import { CircleWalletProvider } from "../src/wallet/CircleWalletProvider.js";
import { runBridgeLeg, runFxLeg, runPayoutLeg, toDecimalString } from "../src/legs/legs.js";
import { ARC_DOMAIN, BASE_SEPOLIA_DOMAIN, chainFor } from "../src/config.js";
import type { LegKind } from "../src/types.js";

const [, , legArg, amountArg = "0.50"] = process.argv;
const kind = legArg as LegKind;

if (!["fx", "bridge", "payout"].includes(kind)) {
  console.error("usage: try-leg.ts <fx|bridge|payout> [amount]");
  process.exit(1);
}

/** Decimal string in, base units out. The legs take base units and convert back internally. */
const baseUnits = (decimal: string): string => {
  const [whole = "0", fraction = ""] = decimal.split(".");
  return `${whole}${fraction.padEnd(6, "0").slice(0, 6)}`.replace(/^0+(?=\d)/, "");
};

const amount = baseUnits(amountArg);
const wallets = CircleWalletProvider.fromEnv();
const ctx = {
  kit: new AppKit(),
  adapter: wallets.getAdapter(),
  kitKey: process.env.CIRCLE_KIT_KEY,
};

const executorArc = await wallets.getWallet("executor", ARC_DOMAIN);

console.log(`leg     ${kind}`);
console.log(`amount  ${toDecimalString(amount)} (${amount} base units)`);
console.log(`from    ${executorArc.address} on ${chainFor(ARC_DOMAIN).name}`);
console.log(`kitKey  ${ctx.kitKey ? "configured" : "absent, running under public rate limits"}\n`);

const before = await wallets.getBalance(executorArc, "USDC");
console.log(`executor USDC before: ${toDecimalString(before)}\n`);

const started = Date.now();
let result;

if (kind === "fx") {
  result = await runFxLeg(ctx, executorArc, amount, "EURC");
} else if (kind === "bridge") {
  const executorDest = await wallets.getWallet("executor", BASE_SEPOLIA_DOMAIN);
  console.log(`to      ${executorDest.address} on ${chainFor(BASE_SEPOLIA_DOMAIN).name}\n`);
  result = await runBridgeLeg(ctx, executorArc, executorDest, amount);
} else {
  const recipient = await wallets.getWallet("recipient", ARC_DOMAIN);
  console.log(`to      ${recipient.address}\n`);
  result = await runPayoutLeg(ctx, executorArc, recipient.address, amount, "USDC");
}

const elapsed = Date.now() - started;
console.log(`\n${kind} succeeded in ${(elapsed / 1000).toFixed(1)}s`);
console.log(`  txHash   ${result.txHash}`);
console.log(`  explorer ${result.explorerUrl}`);

const after = await wallets.getBalance(executorArc, "USDC");
console.log(`\nexecutor USDC after: ${toDecimalString(after)}`);
console.log(`delta: ${toDecimalString((BigInt(after) - BigInt(before)).toString())}`);
