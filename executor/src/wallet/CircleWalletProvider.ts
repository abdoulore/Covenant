/**
 * WalletProvider backed by Circle developer-controlled wallets.
 *
 * This is the only file in the executor that knows Circle exists. Settlement logic depends on the
 * WalletProvider interface, so replacing this with a user-controlled implementation later changes
 * nothing downstream. That separation is the whole reason the interface exists.
 *
 * The executor holds no private keys. One adapter instance serves every wallet, and the wallet is
 * selected per operation by address, which is what `addressContext: developer-controlled` means.
 * See docs/VERIFICATIONS.md V9 and V9a.
 */

import { createRequire } from "node:module";
import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import { chainFor, type ChainConfig } from "../config.js";
import type {
  ManagedWallet,
  SigningAdapter,
  WalletProvider,
  WalletRole,
} from "./WalletProvider.js";

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

/**
 * Load the Circle adapter through CJS rather than ESM. This is a workaround, not a preference.
 *
 * @circle-fin/developer-controlled-wallets@10.8.0 ships an ESM build that omits the `Blockchain`
 * export while its CJS build includes it, and @circle-fin/adapter-circle-wallets imports that
 * name. Importing the adapter as ESM therefore dies at module instantiation with
 * "does not provide an export named 'Blockchain'". The CJS path resolves correctly.
 *
 * Confined to this file deliberately: it is the only module that touches Circle, so the workaround
 * cannot spread. Revisit when the upstream ESM build is fixed, then delete this and restore a
 * normal import. See docs/VERIFICATIONS.md V16.
 */
const require = createRequire(import.meta.url);
const { createCircleWalletsAdapter } = require("@circle-fin/adapter-circle-wallets") as {
  createCircleWalletsAdapter: (opts: { apiKey: string; entitySecret: string }) => unknown;
};

export interface CircleWalletProviderConfig {
  apiKey: string;
  entitySecret: string;
  wallets: ManagedWallet[];
  /** RPC endpoint per CCTP domain. Balances are read directly from chain, not from Circle. */
  rpcUrls: Record<number, string>;
  /** Token addresses per domain. Only tokens this project pays out in need entries. */
  tokens: Record<number, Partial<Record<"USDC" | "EURC", `0x${string}`>>>;
}

export class CircleWalletProvider implements WalletProvider {
  private readonly adapter: SigningAdapter;
  private readonly byRoleAndDomain = new Map<string, ManagedWallet>();
  private readonly clients = new Map<number, PublicClient>();

  constructor(private readonly config: CircleWalletProviderConfig) {
    this.adapter = createCircleWalletsAdapter({
      apiKey: config.apiKey,
      entitySecret: config.entitySecret,
    });

    for (const wallet of config.wallets) {
      const key = CircleWalletProvider.key(wallet.role, wallet.domain);
      if (this.byRoleAndDomain.has(key)) {
        throw new Error(
          `Two wallets registered as ${wallet.role} on domain ${wallet.domain}. ` +
            `Roles must be unique per chain or settlement will pick one arbitrarily.`,
        );
      }
      this.byRoleAndDomain.set(key, wallet);
    }
  }

  /**
   * Build from environment variables.
   *
   * The five wallets and the reason there are five rather than three are documented in
   * VERIFICATIONS.md V13. The _DEST pair lives on the destination chain.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): CircleWalletProvider {
    const required = (name: string): string => {
      const value = env[name];
      if (!value) throw new Error(`${name} is not set`);
      return value;
    };

    const arc = chainFor(Number(env.ARC_CCTP_DOMAIN ?? 26));
    const dest = chainFor(Number(env.DESTINATION_CCTP_DOMAIN ?? 6));

    const wallet = (role: WalletRole, prefix: string, domain: number): ManagedWallet => ({
      role,
      domain,
      walletId: required(`${prefix}_WALLET_ID`),
      address: required(`${prefix}_WALLET_ADDRESS`),
    });

    return new CircleWalletProvider({
      apiKey: required("CIRCLE_API_KEY"),
      entitySecret: required("CIRCLE_ENTITY_SECRET"),
      wallets: [
        wallet("treasury", "TREASURY", arc.domain),
        wallet("executor", "EXECUTOR", arc.domain),
        wallet("recipient", "RECIPIENT", arc.domain),
        wallet("executor", "EXECUTOR_DEST", dest.domain),
        wallet("recipient", "RECIPIENT_DEST", dest.domain),
      ],
      rpcUrls: {
        [arc.domain]: required("ARC_TESTNET_RPC_URL"),
        [dest.domain]: required("BASE_SEPOLIA_RPC_URL"),
      },
      tokens: {
        [arc.domain]: {
          USDC: required("ARC_USDC_ADDRESS") as `0x${string}`,
          EURC: required("ARC_EURC_ADDRESS") as `0x${string}`,
        },
        // USDC only on the destination. EURC is omitted deliberately: it has no cross-chain route
        // (V3, D1), so leaving it unconfigured makes an attempt to pay EURC here fail with a
        // clear message. Omitting USDC too, as an earlier version did, breaks every cross-chain
        // payout instead, which is why the two are listed separately rather than as a blank map.
        [dest.domain]: {
          USDC: required("BASE_SEPOLIA_USDC_ADDRESS") as `0x${string}`,
        },
      },
    });
  }

  async getWallet(role: WalletRole, domain: number): Promise<ManagedWallet> {
    const wallet = this.byRoleAndDomain.get(CircleWalletProvider.key(role, domain));
    if (!wallet) {
      const chain = chainFor(domain);
      throw new Error(
        `No ${role} wallet provisioned on ${chain.name} (domain ${domain}). ` +
          `Run: npm run wallets:write`,
      );
    }
    return wallet;
  }

  getAdapter(): SigningAdapter {
    return this.adapter;
  }

  async getBalance(wallet: ManagedWallet, token: "USDC" | "EURC"): Promise<string> {
    return this.getBalanceAt(wallet.domain, wallet.address, token);
  }

  async getBalanceAt(domain: number, address: string, token: "USDC" | "EURC"): Promise<string> {
    const tokenAddress = this.config.tokens[domain]?.[token];
    if (!tokenAddress) {
      const chain = chainFor(domain);
      throw new Error(
        `${token} is not configured on ${chain.name}. ` +
          `This project pays ${chain.payoutCurrencies.join(" and ")} there. See VERIFICATIONS.md V3.`,
      );
    }

    const balance = await this.clientFor(domain).readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address as `0x${string}`],
    });

    // Base units, 6 decimals, as a string. Never a JS number: 2^53 base units is only about
    // 9 billion USDC, and rounding a payment amount is not a recoverable error.
    return balance.toString();
  }

  private clientFor(domain: number): PublicClient {
    const existing = this.clients.get(domain);
    if (existing) return existing;

    const url = this.config.rpcUrls[domain];
    if (!url) throw new Error(`No RPC configured for CCTP domain ${domain}`);

    const chain: ChainConfig = chainFor(domain);
    const client = createPublicClient({
      chain: {
        id: chain.chainId,
        name: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: { default: { http: [url] } },
      },
      transport: http(url, { retryCount: 3, retryDelay: 1_500, timeout: 30_000 }),
    }) as PublicClient;

    this.clients.set(domain, client);
    return client;
  }

  private static key(role: WalletRole, domain: number): string {
    return `${role}:${domain}`;
  }
}
