import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GATEWAY_WALLET } from "../src/gateway/addresses.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * The Gateway funds-loss hazard, made unrepresentable rather than merely discouraged: a bare ERC-20
 * transfer to the GatewayWallet address loses the USDC. If the address literal lives in exactly one
 * file and USDC only ever moves into it via deposit(), no code path can express the mistake.
 */
describe("Gateway funds-loss hazard is unrepresentable", () => {
  const sources = [...tsFiles(join(root, "src")), ...tsFiles(join(root, "scripts"))];
  const addr = GATEWAY_WALLET.toLowerCase();

  it("the GatewayWallet address literal appears in exactly one file", () => {
    const offenders = sources.filter(
      (f) => !f.replace(/\\/g, "/").endsWith("src/gateway/addresses.ts") && readFileSync(f, "utf8").toLowerCase().includes(addr),
    );
    expect(offenders, `GatewayWallet address must only appear in src/gateway/addresses.ts; found in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("moves USDC into the GatewayWallet only via deposit(), never transfer()", () => {
    const funder = readFileSync(join(root, "src/gateway/GatewayFunder.ts"), "utf8");
    expect(funder).toContain('"deposit(address,uint256)"');
    // No transfer or transferFrom call anywhere near the GatewayWallet reference in the module.
    expect(/transfer(From)?\s*\([^)]*GATEWAY_WALLET/.test(funder)).toBe(false);
  });
});
