/**
 * Clients for the connected wallet. Kept apart from the wallet store because viem's clients are most
 * of its size: the top bar needs only the store, and these load with the screens that sign.
 */
import { createPublicClient, createWalletClient, custom, type PublicClient, type WalletClient } from "viem";
import { ARC } from "./chain";
import type { WalletState } from "./wallet";

export interface Signer { account: `0x${string}`; wallet: WalletClient; client: PublicClient }

/**
 * Clients for the connected account, or null unless it is connected on Arc.
 *
 * Reads go through the wallet's own connection too, so the app still runs no RPC of its own and
 * everything it shows before a signature comes from the same chain the wallet will sign on.
 */
export function signerFor(s: WalletState): Signer | null {
  if (!s.wallet || !s.account || s.chainId !== ARC.id) return null;
  const transport = custom(s.wallet.provider);
  return {
    account: s.account,
    wallet: createWalletClient({ account: s.account, chain: ARC, transport }),
    client: createPublicClient({ chain: ARC, transport }) as PublicClient,
  };
}
