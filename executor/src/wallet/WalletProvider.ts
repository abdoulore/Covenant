/**
 * The wallet abstraction.
 *
 * This interface exists from the first commit so that migrating from developer-controlled to
 * user-controlled wallets later touches no settlement logic. Settlement code depends on this
 * file and never on a Circle SDK type.
 *
 * Note what is deliberately absent: there is no signing method and no key material. Circle's
 * wallet adapter signs internally, selected per operation by address, so the executor holds no
 * private keys. See docs/VERIFICATIONS.md V9.
 */

export type WalletRole = "treasury" | "executor" | "recipient";

export interface ManagedWallet {
  role: WalletRole;
  /** Onchain address. This is what App Kit calls take. */
  address: string;
  /** Provider-side identifier, opaque to settlement logic. */
  walletId: string;
  /** CCTP domain this wallet is provisioned on. */
  domain: number;
}

/**
 * The signing object handed to App Kit calls.
 *
 * Intentionally unknown: its concrete shape belongs to the SDK, and naming it here would leak
 * the Circle dependency into settlement code, which is the coupling this interface prevents.
 */
export type SigningAdapter = unknown;

export interface WalletProvider {
  /** Resolve a wallet by role and chain. Throws if it is not provisioned. */
  getWallet(role: WalletRole, domain: number): Promise<ManagedWallet>;

  /** The adapter passed to App Kit operations. */
  getAdapter(): SigningAdapter;

  /** Balance in base units, 6 decimals, for the given token on the wallet's chain. */
  getBalance(wallet: ManagedWallet, token: "USDC" | "EURC"): Promise<string>;

  /**
   * Balance of an arbitrary address on a chain, base units.
   *
   * Needed to measure what a payment actually delivered to a recipient we do not custody, which
   * is how the bridge leg records its true fee against the quote. Kept distinct from getBalance,
   * which resolves address and chain from a managed wallet.
   */
  getBalanceAt(domain: number, address: string, token: "USDC" | "EURC"): Promise<string>;
}
