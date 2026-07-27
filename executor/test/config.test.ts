import { describe, expect, it } from "vitest";
import {
  ARC_DOMAIN,
  BASE_SEPOLIA_DOMAIN,
  assertRouteSupported,
  chainFor,
  planLegs,
} from "../src/config.js";

describe("chainFor", () => {
  it("resolves configured domains", () => {
    expect(chainFor(ARC_DOMAIN).appKitChain).toBe("Arc_Testnet");
    expect(chainFor(BASE_SEPOLIA_DOMAIN).appKitChain).toBe("Base_Sepolia");
  });

  it("names the fix when a domain is unconfigured", () => {
    expect(() => chainFor(999)).toThrow(/No chain configured for CCTP domain 999/);
  });
});

describe("assertRouteSupported", () => {
  it("allows EURC on Arc, the only swap-enabled chain", () => {
    expect(() => assertRouteSupported("EURC", ARC_DOMAIN)).not.toThrow();
  });

  it("allows USDC anywhere configured", () => {
    expect(() => assertRouteSupported("USDC", ARC_DOMAIN)).not.toThrow();
    expect(() => assertRouteSupported("USDC", BASE_SEPOLIA_DOMAIN)).not.toThrow();
  });

  it("rejects EURC on a destination chain, since EURC cannot bridge", () => {
    expect(() => assertRouteSupported("EURC", BASE_SEPOLIA_DOMAIN)).toThrow(
      /EURC cannot be paid out on Base Sepolia/,
    );
  });
});

describe("planLegs", () => {
  it("plans the FX archetype: swap then pay, no bridge", () => {
    expect(planLegs("EURC", ARC_DOMAIN)).toEqual(["fx", "payout"]);
  });

  it("plans the cross-chain archetype as a single bridge that is also the payout", () => {
    // The mint lands on the recipient, so there is no separate payout leg. A second leg would
    // need native ETH on the destination that this project never holds. See V18 and D7.
    expect(planLegs("USDC", BASE_SEPOLIA_DOMAIN)).toEqual(["bridge"]);
  });

  it("plans a same-chain USDC payout as a single leg", () => {
    expect(planLegs("USDC", ARC_DOMAIN)).toEqual(["payout"]);
  });

  it("refuses to plan an unsupported route rather than planning a doomed one", () => {
    expect(() => planLegs("EURC", BASE_SEPOLIA_DOMAIN)).toThrow(/Unsupported route/);
  });
});
