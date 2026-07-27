/**
 * Chain and currency configuration.
 *
 * Settlement logic must never contain a hardcoded chain id or chain name. Everything routes
 * through this registry, keyed by CCTP domain, which is what the PolicyVault event carries.
 */

import type { PayoutCurrency } from "./types.js";

export interface ChainConfig {
  /** CCTP domain, the key used in policies and events. See docs/VERIFICATIONS.md V3. */
  domain: number;
  /** EIP-155 chain id. Distinct from the CCTP domain, which is Circle's own numbering. */
  chainId: number;
  /** Human name for logs and RESULTS.md. */
  name: string;
  /**
   * Gas token as the chain reports it. On Arc this is USDC at 18 decimals, the native view.
   * Policy amounts use the 6 decimal ERC-20 view and never this. See VERIFICATIONS.md V1a.
   */
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /**
   * App Kit chain identifier. Case sensitive, spaces replaced by underscores.
   *
   * The docs are inconsistent here: the supported blockchains table renders some testnets with
   * spaces while the adapter tutorial uses "Base_Sepolia". The stated rule is underscores, and
   * the tutorial code is the more reliable signal, so underscores it is. If an App Kit call
   * rejects an identifier, this is the first place to look.
   */
  appKitChain: string;
  explorerTxUrl: (hash: string) => string;
  /** Currencies that can be paid out on this chain by this project today. */
  payoutCurrencies: PayoutCurrency[];
  /** True where App Kit swap is available. Arc only, at present. V4. */
  swapSupported: boolean;
}

export const ARC_DOMAIN = 26;
export const BASE_SEPOLIA_DOMAIN = 6;

export const CHAINS: Record<number, ChainConfig> = {
  [ARC_DOMAIN]: {
    domain: ARC_DOMAIN,
    chainId: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
    appKitChain: "Arc_Testnet",
    explorerTxUrl: (hash) => `https://testnet.arcscan.app/tx/${hash}`,
    payoutCurrencies: ["USDC", "EURC"],
    swapSupported: true,
  },
  [BASE_SEPOLIA_DOMAIN]: {
    domain: BASE_SEPOLIA_DOMAIN,
    chainId: 84532,
    name: "Base Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    appKitChain: "Base_Sepolia",
    explorerTxUrl: (hash) => `https://sepolia.basescan.org/tx/${hash}`,
    payoutCurrencies: ["USDC"],
    swapSupported: false,
  },
};

export function chainFor(domain: number): ChainConfig {
  const chain = CHAINS[domain];
  if (!chain) {
    throw new Error(
      `No chain configured for CCTP domain ${domain}. Add it to CHAINS in config.ts.`,
    );
  }
  return chain;
}

/**
 * Reject routes the infrastructure cannot serve, before any funds move.
 *
 * The vault already blocks EURC to a non-Arc destination at creation time, so this is the second
 * of two gates rather than the only one. It stays because the executor must not depend on having
 * been deployed against a vault that enforces it.
 *
 * See docs/DECISIONS.md D1.
 */
export function assertRouteSupported(
  payoutCurrency: PayoutCurrency,
  destinationDomain: number,
): void {
  const chain = chainFor(destinationDomain);
  if (!chain.payoutCurrencies.includes(payoutCurrency)) {
    throw new Error(
      `Unsupported route: ${payoutCurrency} cannot be paid out on ${chain.name}. ` +
        `CCTP and App Kit Bridge carry USDC only, and swap is available on Arc alone. ` +
        `See docs/VERIFICATIONS.md V3 and V4.`,
    );
  }
}

/** Which legs a settlement needs, in order. Derived, never hardcoded per policy. */
export function planLegs(
  payoutCurrency: PayoutCurrency,
  destinationDomain: number,
): Array<"fx" | "bridge" | "payout"> {
  assertRouteSupported(payoutCurrency, destinationDomain);

  const legs: Array<"fx" | "bridge" | "payout"> = [];

  if (payoutCurrency === "EURC") legs.push("fx");

  if (destinationDomain !== ARC_DOMAIN) {
    /**
     * Cross-chain settlements have no separate payout leg: the bridge mints straight to the
     * recipient, so the mint is the payout.
     *
     * This is not only a simplification. Circle's relayer pays the mint gas, but a subsequent
     * transfer out of a destination wallet would be an ordinary transaction needing native ETH
     * that this project never holds (V18). Minting to the recipient removes that dependency
     * entirely, and removes destination-side custody with it. See DECISIONS.md D7.
     */
    legs.push("bridge");
    return legs;
  }

  legs.push("payout");
  return legs;
}
