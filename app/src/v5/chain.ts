/**
 * The chain a connected wallet signs on, and the contracts it signs against.
 *
 * Built into the bundle rather than read from the API. For v5 the app asks a user's wallet to hand
 * money to a contract, so the contract's address must not be something a server can change: a
 * compromised or misconfigured API could otherwise point every user at a vault that is not ours. The
 * API's address is still compared against this one, and a mismatch disables signing (see useV5Vault).
 */
import { defineChain, getAddress } from "viem";

/** Arc testnet. Mainnet (chain 5042) replaces this at the mainnet build, with its own Circle API. */
export const ARC = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  // Native gas on Arc is USDC, shown by wallets with 18 decimals. The ERC-20 below has 6.
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

export const ARC_DOMAIN = 26;

/** USDC's ERC-20 face on Arc: 6 decimals, EIP-2612 permit. */
export const USDC = "0x3600000000000000000000000000000000000000" as const;

/** Circle's CCTP API: fee quotes for cross-chain payouts. The sandbox serves testnet. */
export const IRIS = "https://iris-api-sandbox.circle.com";

/** Where v5 can pay, besides Arc. Must match the vault's deployed destination list. */
export const V5_DESTINATIONS = [
  { domain: ARC_DOMAIN, name: "Arc (same chain)" },
  { domain: 6, name: "Base Sepolia (cross-chain)" },
];

export const txUrl = (hash: string) => `${ARC.blockExplorers.default.url}/tx/${hash}`;

/**
 * The v5 vault this build signs against: the testnet deployment, from its broadcast record
 * (contracts/broadcast/DeployPolicyVaultV5.s.sol/5042002). VITE_POLICY_VAULT_V5_ADDRESS overrides it at
 * build time, for a redeploy before this line is updated; an override that is not an address disables
 * signing rather than falling back.
 */
export const V5_TESTNET_VAULT = "0x87A204d4eDbE715b00eA05a2Ad860f40b710c890" as const;

export const V5_VAULT: `0x${string}` | null = (() => {
  // Optional access: outside Vite (a script exercising this code under Node) there is no import.meta.env.
  const raw = import.meta.env?.VITE_POLICY_VAULT_V5_ADDRESS?.trim();
  if (!raw) return V5_TESTNET_VAULT;
  try {
    return getAddress(raw);
  } catch {
    return null;
  }
})();

/**
 * The vault to sign against, checked against what the API reports.
 *
 * The built-in address decides. The API's is only a cross-check: if the two disagree, one of them is
 * wrong, and signing stays off until someone finds out which, rather than trusting either.
 */
export function resolveV5Vault(apiVaults: { label: string; address: string }[] | undefined): { vault: `0x${string}` | null; problem: string | null } {
  if (!V5_VAULT) return { vault: null, problem: "This build of the app has no v5 vault configured, so it cannot sign." };
  const reported = apiVaults?.find((v) => v.label === "v5")?.address;
  if (reported && reported.toLowerCase() !== V5_VAULT.toLowerCase()) {
    return { vault: null, problem: `The API reports v5 at ${reported}, but this app was built for ${V5_VAULT}. Signing is off until they agree.` };
  }
  return { vault: V5_VAULT, problem: null };
}
