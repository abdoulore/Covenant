/**
 * The user's own wallet: finding it, connecting it, and keeping the app's view of it current.
 *
 * Wallets are discovered through EIP-6963, which lets several installed wallets announce themselves
 * without fighting over window.ethereum, with window.ethereum as the fallback for one that does not.
 * Nothing here holds a key: every signature is made inside the wallet, after the user sees it there.
 *
 * Connecting is remembered per browser (which wallet, not which account), so a reload reconnects
 * without a prompt when the wallet still grants access, and asks again when it does not.
 */
import { useEffect, useSyncExternalStore } from "react";
import { getAddress, numberToHex, type EIP1193Provider } from "viem";
import { ARC } from "./chain";

export interface WalletInfo { id: string; name: string; icon?: string; provider: EIP1193Provider }

export interface WalletState {
  wallets: WalletInfo[];
  /** The wallet in use, once the user has connected one. */
  wallet: WalletInfo | null;
  account: `0x${string}` | null;
  chainId: number | null;
  connecting: boolean;
  error: string | null;
}

const REMEMBER = "covenant.wallet";
let state: WalletState = { wallets: [], wallet: null, account: null, chainId: null, connecting: false, error: null };
const listeners = new Set<() => void>();

function set(patch: Partial<WalletState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

const remembered = (): string | null => { try { return localStorage.getItem(REMEMBER); } catch { return null; } };
const remember = (id: string | null) => {
  try { id ? localStorage.setItem(REMEMBER, id) : localStorage.removeItem(REMEMBER); } catch { /* per-browser convenience only */ }
};

function addWallet(w: WalletInfo) {
  if (state.wallets.some((x) => x.id === w.id || x.provider === w.provider)) return;
  set({ wallets: [...state.wallets, w] });
  if (!state.wallet && remembered() === w.id) void connect(w, { silent: true });
}

let discovering = false;
function discover() {
  if (discovering || typeof window === "undefined") return;
  discovering = true;
  window.addEventListener("eip6963:announceProvider", ((e: CustomEvent) => {
    const { info, provider } = e.detail ?? {};
    if (info?.uuid && provider) addWallet({ id: info.rdns || info.uuid, name: info.name, icon: info.icon, provider });
  }) as EventListener);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  // A wallet that predates EIP-6963 only sets window.ethereum. Give announcements a moment first so
  // the same wallet is not listed twice under two names.
  setTimeout(() => {
    const legacy = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
    if (legacy) addWallet({ id: "injected", name: "Browser wallet", provider: legacy });
  }, 300);
}

let detach: (() => void) | null = null;

function watch(w: WalletInfo) {
  detach?.();
  const onAccounts = (accounts: string[]) => {
    if (!accounts.length) { forget(); return; }
    set({ account: getAddress(accounts[0]!) });
  };
  const onChain = (id: string) => set({ chainId: Number(id) });
  w.provider.on?.("accountsChanged", onAccounts as never);
  w.provider.on?.("chainChanged", onChain as never);
  detach = () => {
    w.provider.removeListener?.("accountsChanged", onAccounts as never);
    w.provider.removeListener?.("chainChanged", onChain as never);
  };
}

/** Ask the wallet for access. `silent` only checks for access already granted: no prompt. */
export async function connect(w: WalletInfo, { silent = false } = {}): Promise<void> {
  set({ connecting: !silent, error: null });
  try {
    if (!silent) await chooseAccounts(w);
    const accounts = (await w.provider.request({ method: "eth_accounts" })) as string[];
    if (!accounts.length) { set({ connecting: false }); return; }
    const chainId = Number(await w.provider.request({ method: "eth_chainId" }));
    watch(w);
    remember(w.id);
    set({ wallet: w, account: getAddress(accounts[0]!), chainId, connecting: false });
  } catch (e) {
    set({ connecting: false, error: silent ? null : walletMessage(e) });
  }
}

/**
 * Open the wallet's own account picker.
 *
 * A plain eth_requestAccounts is answered silently with whichever account already has access, so
 * a user could never bring in a different one: disconnecting and connecting again returned the same
 * account, and switching in the wallet to an account without access told the app nothing. Asking
 * for the permission again shows the picker, where any number of accounts can be granted; switching
 * between granted accounts in the wallet then reaches the app through accountsChanged.
 */
async function chooseAccounts(w: WalletInfo): Promise<void> {
  try {
    await w.provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] } as never);
  } catch (e) {
    const code = (e as { code?: number }).code;
    // A wallet without the permissions API: fall back to the plain request.
    if (code === 4200 || code === -32601) await w.provider.request({ method: "eth_requestAccounts" });
    else throw e;
  }
}

/** Bring in another account, or change which accounts the app may see. */
export async function switchAccount(): Promise<void> {
  if (state.wallet) await connect(state.wallet);
}

/**
 * Stop using the wallet in this app, and ask the wallet to withdraw the site's access too, so the
 * next connect starts from the picker. A wallet that cannot revoke keeps it; the user can do so there.
 */
export function forget() {
  const w = state.wallet;
  if (w) void w.provider.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] } as never).catch(() => {});
  detach?.();
  detach = null;
  remember(null);
  set({ wallet: null, account: null, chainId: null, error: null });
}

/** Put the wallet on Arc, adding the network first if the wallet has never seen it. */
export async function switchToArc(): Promise<void> {
  const w = state.wallet;
  if (!w) return;
  const chainId = numberToHex(ARC.id);
  try {
    await w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) { set({ error: walletMessage(e) }); return; }
    try {
      await w.provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId, chainName: ARC.name, nativeCurrency: ARC.nativeCurrency,
          rpcUrls: ARC.rpcUrls.default.http, blockExplorerUrls: [ARC.blockExplorers!.default.url],
        }],
      });
    } catch (e2) {
      set({ error: walletMessage(e2) });
    }
  }
}

export function useWallet(): WalletState {
  useEffect(discover, []);
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

/** A wallet error in words. A refusal in the wallet is the user's decision, not a failure. */
export function walletMessage(e: unknown): string {
  const err = e as { code?: number; shortMessage?: string; message?: string; cause?: { code?: number } };
  if (err?.code === 4001 || err?.cause?.code === 4001) return "You declined the request in your wallet.";
  if (err?.code === -32002) return "Your wallet already has a request open. Finish or close it there first.";
  return err?.shortMessage ?? err?.message ?? String(e);
}
