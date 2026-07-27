/**
 * App Kit chain definitions with our own RPC endpoints.
 *
 * App Kit operations accept either a chain name or a full ChainDefinition. The names are
 * convenient and carry the SDK's built-in endpoints, which for Base Sepolia is exactly one:
 * https://sepolia.base.org, the public node. That endpoint failed three consecutive payout
 * attempts during a canary run while the same call over our own endpoint succeeded, which is the
 * same failure mode V15 documented on Arc, just on the destination side.
 *
 * Passing a definition instead of a name lets the executor use the endpoints it was configured
 * with, and keeps the SDK's defaults as fallbacks rather than as the only option.
 */

import { ArcTestnet, BaseSepolia } from "@circle-fin/app-kit/chains";
import { ARC_DOMAIN, BASE_SEPOLIA_DOMAIN, chainFor } from "../config.js";

/** Base definitions keyed by CCTP domain, so callers never map chain names by hand. */
const DEFINITIONS: Record<number, { rpcEndpoints: readonly string[] }> = {
  [ARC_DOMAIN]: ArcTestnet,
  [BASE_SEPOLIA_DOMAIN]: BaseSepolia,
};

export type AppKitChainResolver = (domain: number) => unknown;

/**
 * Build a resolver that returns App Kit chain definitions with `rpcUrls` tried first.
 *
 * The SDK's own endpoints are kept at the end of the list rather than replaced. If our provider
 * is down, the built-in default is better than no endpoint at all.
 */
export function createChainResolver(rpcUrls: Record<number, string[]>): AppKitChainResolver {
  return (domain: number) => {
    const definition = DEFINITIONS[domain];
    if (!definition) {
      throw new Error(
        `No App Kit chain definition for CCTP domain ${domain} (${chainFor(domain).name}). ` +
          `Add it to DEFINITIONS in appKitChains.ts.`,
      );
    }

    const preferred = rpcUrls[domain] ?? [];
    const endpoints = [...preferred, ...definition.rpcEndpoints.filter((u) => !preferred.includes(u))];

    return { ...definition, rpcEndpoints: endpoints };
  };
}

/** Read endpoint configuration from the environment, primary then fallback per chain. */
export function rpcUrlsFromEnv(env: NodeJS.ProcessEnv = process.env): Record<number, string[]> {
  const collect = (...names: string[]): string[] =>
    names.map((n) => env[n]).filter((v): v is string => Boolean(v));

  return {
    [ARC_DOMAIN]: collect("ARC_TESTNET_RPC_URL", "ARC_TESTNET_RPC_FALLBACK_URL"),
    [BASE_SEPOLIA_DOMAIN]: collect("BASE_SEPOLIA_RPC_URL", "BASE_SEPOLIA_RPC_FALLBACK_URL"),
  };
}
