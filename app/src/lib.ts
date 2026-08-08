/** Formatting helpers, shared by the read views. Ported from the monitor. */

export const shortHash = (h?: string) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : "");
export const shortAddr = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

export const usdc = (base?: string | null) =>
  base == null ? "" : `${(Number(base) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} USDC`;

export function agoUnix(sec?: number) {
  if (sec == null) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  return s < 90 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

export function agoIso(iso?: string) {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

export function relUnix(sec?: string | number) {
  if (sec == null) return "";
  const s = Math.round(Number(sec) - Date.now() / 1000);
  const a = Math.abs(s);
  const t = a < 90 ? `${a}s` : a < 5400 ? `${Math.round(a / 60)}m` : a < 172800 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
  return s >= 0 ? `in ${t}` : `${t} ago`;
}

/** The domain that is Arc, so cross-chain settlements can be tagged. */
export const ARC_DOMAIN = 26;
