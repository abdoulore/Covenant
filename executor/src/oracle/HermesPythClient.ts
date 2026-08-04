/**
 * Keyless Pyth price source, backed by Hermes.
 *
 * The keeper uses this to pre-check a policy's threshold for free before paying to post an update.
 * fetch returns the latest price in the feed's own decimals (the raw Pyth integer, the same scale a
 * policy threshold is expressed in) and the signed update blob to submit onchain. No API key.
 */
import type { PythClient, PythPrice } from "./OracleKeeper.js";

export class HermesPythClient implements PythClient {
  constructor(private readonly baseUrl = "https://hermes.pyth.network") {}

  async fetch(priceId: string): Promise<PythPrice> {
    const id = priceId.startsWith("0x") ? priceId : `0x${priceId}`;
    const res = await fetch(`${this.baseUrl}/v2/updates/price/latest?ids[]=${id}&encoding=hex`);
    if (!res.ok) throw new Error(`Hermes returned ${res.status} for ${id}`);
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
