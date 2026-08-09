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

// ---- wall clock vs instant ----------------------------------------------
//
// A `datetime-local` input carries no timezone, so `new Date(value)` reads what was typed as local
// wall clock. That is the right reading, and it is also the whole problem: the vault stores a unix
// instant, and the two only look like the same thing to someone sitting at UTC. An operator in
// UTC+1 who types 14:30 has written 13:30 into the contract. Nothing here converts anything; these
// just make the browser say out loud which clock it used.

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The UTC offset in force at a given instant, as "UTC+01:00".
 *
 * Read at that instant rather than at now, because the offset is not a fixed property of a place:
 * a January release time picked during a July session is an hour off from the session's own offset.
 */
export function utcOffset(at: Date): string {
  const mins = -at.getTimezoneOffset();
  const abs = Math.abs(mins);
  return `UTC${mins < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The browser's timezone named and offset: "Europe/London (UTC+01:00)". */
export function localZone(at: Date = new Date()): string {
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = utcOffset(at);
  return name ? `${name} (${offset})` : offset;
}

/** A unix second on the operator's own clock, offset attached: "2026-08-09 14:30 (UTC+01:00)". */
export function localStamp(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${utcOffset(d)})`;
}

/** The same instant as the chain holds it: "2026-08-09 13:30 UTC". */
export function utcStamp(sec: number): string {
  return `${new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Decimal USDC to 6-decimal base units, or null if malformed or not positive. */
export function toBaseUnits(decimal: string): string | null {
  const s = decimal.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const base = BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
  return base > 0n ? base.toString() : null;
}
