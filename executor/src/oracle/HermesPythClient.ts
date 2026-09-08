/**
 * Pyth price source, backed by Hermes.
 *
 * The keeper uses this to pre-check a policy's threshold for free before paying to post an update,
 * and the write API uses it to fetch the signed blob a `releaseWithProof` submits onchain. `fetch`
 * returns the latest price in the feed's own decimals (the raw Pyth integer, the same scale a policy
 * threshold is expressed in) plus that blob.
 *
 * Hermes used to be keyless. It is not any more: the Pyth Core upgrade put every instance behind an
 * API key, and an unauthenticated request now returns 401 with the body `unauthorized`. That is not
 * a transient failure and no amount of retrying fixes it, so the error thrown here says what to do
 * instead of reporting a bare status code.
 *
 * Both the host and the key come from the environment, so a future host change is a variable edit
 * rather than a deploy of new code. The Pyth docs also serve the upgraded API from
 * https://pyth.dourolabs.app/hermes, which is what PYTH_HERMES_BASE_URL is for.
 */
import type { PythClient, PythPrice } from "./OracleKeeper.js";

const DEFAULT_HERMES = "https://hermes.pyth.network";

export interface HermesConfig {
  baseUrl: string;
  headers: Record<string, string>;
  /** False when no key is configured, so a caller can explain the 401 before it happens. */
  authenticated: boolean;
}

/** Where Hermes lives and how to authenticate to it. One source of truth for every call site. */
export function hermesConfig(env: NodeJS.ProcessEnv = process.env): HermesConfig {
  const key = env.PYTH_API_KEY?.trim();
  return {
    baseUrl: (env.PYTH_HERMES_BASE_URL?.trim() || DEFAULT_HERMES).replace(/\/+$/, ""),
    headers: key ? { authorization: `Bearer ${key}` } : {},
    authenticated: Boolean(key),
  };
}

/** The same sentence wherever a Hermes call fails for want of a key. */
export function hermesAuthMessage(status: number, cfg: HermesConfig): string {
  if (status !== 401 && status !== 403) return `Hermes returned ${status}`;
  return cfg.authenticated
    ? `Hermes rejected the configured PYTH_API_KEY (${status}). Check the key is valid for ${cfg.baseUrl}.`
    : `Hermes returned ${status} and no PYTH_API_KEY is set. Hermes now requires an API key; set ` +
      `PYTH_API_KEY (and PYTH_HERMES_BASE_URL if your key is issued for another instance).`;
}

export interface HermesPythClientOptions {
  baseUrl?: string;
  apiKey?: string;
}

export class HermesPythClient implements PythClient {
  private readonly cfg: HermesConfig;

  constructor(opts: HermesPythClientOptions = {}) {
    const base = hermesConfig();
    this.cfg = {
      baseUrl: (opts.baseUrl ?? base.baseUrl).replace(/\/+$/, ""),
      headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : base.headers,
      authenticated: opts.apiKey ? true : base.authenticated,
    };
  }

  async fetch(priceId: string): Promise<PythPrice> {
    const id = priceId.startsWith("0x") ? priceId : `0x${priceId}`;
    const res = await globalThis.fetch(
      `${this.cfg.baseUrl}/v2/updates/price/latest?ids[]=${id}&encoding=hex`,
      { headers: this.cfg.headers },
    );
    if (!res.ok) throw new Error(`${hermesAuthMessage(res.status, this.cfg)} for ${id}`);
    const body = (await res.json()) as {
      binary: { data: string[] };
      parsed: { price: { price: string } }[];
    };
    if (!body.parsed?.[0]) throw new Error(`Hermes returned no price for ${id}`);
    const updateData = body.binary.data.map((d) => `0x${d}` as `0x${string}`);
    const price = BigInt(body.parsed[0].price.price);
    return { price, updateData };
  }
}
