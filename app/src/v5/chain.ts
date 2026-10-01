/**
 * The chain a connected wallet signs on, and the contracts it signs against.
 *
 * Built into the bundle rather than read from the API. For v5 the app asks a user's wallet to hand
 * money to a contract, so the contract's address must not be something a server can change: a
 * compromised or misconfigured API could otherwise point every user at a vault that is not ours. The
 * API's address is still compared against this one, and a mismatch disables signing (see resolveV5Vault).
 *
 * One build is one network. VITE_ARC_NETWORK=mainnet (the `mainnet` Vite mode, app/.env.mainnet)
 * builds for Arc mainnet; anything else builds for Arc testnet, which stays the default.
 */
import { getAddress } from "viem";
import { arc, arcTestnet } from "viem/chains";

// Optional access: outside Vite (a script exercising this code under Node) there is no import.meta.env.
const env = import.meta.env ?? ({} as ImportMetaEnv);

export const IS_MAINNET = env.VITE_ARC_NETWORK?.trim() === "mainnet";

/**
 * viem's own Arc definitions, with Arc's official endpoints (docs.arc.io, Connect to Arc). viem's `arc`
 * ships without an RPC URL, and its testnet entry points at older hosts, so both are filled in here.
 * Native gas on Arc is USDC, shown by wallets with 18 decimals; the ERC-20 below has 6.
 */
const MULTICALL3 = { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } as const;
export const ARC = IS_MAINNET
  ? {
      ...arc,
      rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
      blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
      contracts: { ...arc.contracts, multicall3: MULTICALL3 },
    }
  : {
      ...arcTestnet,
      rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
      blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" } },
      contracts: { ...arcTestnet.contracts, multicall3: MULTICALL3 },
    };

/**
 * Arc's predeployed batcher (docs.arc.io, Batched Transactions): runs each call as the transaction's
 * own sender through the CallFrom precompile, so an approval and the call that spends it go in one
 * transaction from an ordinary wallet. EOAs only. Same address on mainnet and testnet.
 */
export const MULTICALL3_FROM = "0x522fAf9A91c41c443c66765030741e4AaCe147D0" as const;

/** Arc's mempool drops, without a receipt, any transaction offering less than this (EVM differences). */
export const MIN_MAX_FEE_PER_GAS = 20_000_000_000n;

/**
 * Every public RPC Arc lists for reading (docs.arc.io, RPC Endpoints): Circle's own first, then the
 * keyless third-party providers. Reads fall through them in order, so one endpoint being down, or
 * blocked by a browser's privacy shield, does not leave the app blank.
 */
export const READ_RPCS = IS_MAINNET
  ? ["https://rpc.mainnet.arc.io", "https://rpc.quicknode.mainnet.arc.io", "https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.drpc.mainnet.arc.io"]
  : ["https://rpc.testnet.arc.io", "https://rpc.quicknode.testnet.arc.io", "https://rpc.blockdaemon.testnet.arc.io", "https://rpc.drpc.testnet.arc.io"];

export const ARC_DOMAIN = 26;

/** USDC's ERC-20 face on Arc, the same address on both networks: 6 decimals, EIP-2612 permit. */
export const USDC = "0x3600000000000000000000000000000000000000" as const;

/** Circle's CCTP API, for fee quotes on cross-chain payouts. The sandbox serves testnet. */
export const IRIS = IS_MAINNET ? "https://iris-api.circle.com" : "https://iris-api-sandbox.circle.com";

/** Where v5 can pay. Must match the vault's deployed destination list. */
export const V5_DESTINATIONS = IS_MAINNET
  ? [
      { domain: ARC_DOMAIN, name: "Arc (same chain)" },
      { domain: 6, name: "Base (cross-chain)" },
      { domain: 3, name: "Arbitrum (cross-chain)" },
    ]
  : [
      { domain: ARC_DOMAIN, name: "Arc (same chain)" },
      { domain: 6, name: "Base Sepolia (cross-chain)" },
    ];

export const txUrl = (hash: string) => `${ARC.blockExplorers.default.url}/tx/${hash}`;

/**
 * The deployed vaults, each from its broadcast record (contracts/broadcast/DeployPolicyVaultV5.s.sol/
 * <chain id>). The executor suite checks both against those records.
 */
export const V5_TESTNET_VAULT = "0x87A204d4eDbE715b00eA05a2Ad860f40b710c890" as const;
export const V5_MAINNET_VAULT = "0x6C2F006D6788883Cc6520DB80905079f2BBDB3f7" as const;

/**
 * The v5 vault this build signs against. VITE_POLICY_VAULT_V5_ADDRESS overrides it at build time,
 * for a redeploy before the line above is updated; an override that is not an address disables
 * signing rather than falling back.
 */
export const V5_VAULT: `0x${string}` | null = (() => {
  const raw = env.VITE_POLICY_VAULT_V5_ADDRESS?.trim();
  if (!raw) return IS_MAINNET ? V5_MAINNET_VAULT : V5_TESTNET_VAULT;
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
