import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEE_QUOTE_BASE_UNITS,
  estimateBridgeFee,
  feeAllowance,
  fromDecimalString,
  toDecimalString,
} from "../src/legs/legs.js";
import type { LegContext } from "../src/legs/legs.js";
import type { ManagedWallet } from "../src/wallet/WalletProvider.js";

describe("fromDecimalString", () => {
  it("is the inverse of toDecimalString on exact values", () => {
    for (const base of ["0", "1", "10", "100000", "1000000", "1234567", "20000000"]) {
      expect(fromDecimalString(toDecimalString(base))).toBe(base);
    }
  });

  it("parses fee-shaped decimals", () => {
    expect(fromDecimalString("0.053247")).toBe("53247");
    expect(fromDecimalString("0.100153")).toBe("100153");
    expect(fromDecimalString("1.00")).toBe("1000000");
  });

  it("rounds sub-unit precision up, the safe direction for a fee", () => {
    // Anything finer than 6 decimals must never round a fee down, or the buffer could undersize.
    expect(fromDecimalString("0.0000001")).toBe("1");
    expect(fromDecimalString("0.1234561")).toBe("123457");
    expect(fromDecimalString("0.1234560")).toBe("123456");
  });
});

describe("feeAllowance", () => {
  it("uses three times the quote when that dominates", () => {
    // 3 * 0.053247 = 0.159741, well above quote + 0.05 floor.
    expect(feeAllowance("53247")).toBe("159741");
  });

  it("uses the floor when the quote is small", () => {
    // 3 * 0.01 = 0.03 is below 0.01 + 0.05 = 0.06, so the floor wins.
    expect(feeAllowance("10000")).toBe("60000");
  });

  it("covers the highest observed actual with headroom", () => {
    // Observed direct-to-recipient actual was 0.100153 against a 0.053247 quote. The allowance
    // must exceed it, or the recipient is short-changed.
    const allowance = BigInt(feeAllowance("53247"));
    expect(allowance).toBeGreaterThan(100153n);
  });

  it("never returns less than the quote", () => {
    for (const q of ["0", "1", "53247", "100000", "5000000"]) {
      expect(BigInt(feeAllowance(q))).toBeGreaterThanOrEqual(BigInt(q));
    }
  });
});

describe("estimateBridgeFee", () => {
  const source: ManagedWallet = { role: "executor", domain: 26, address: "0xexec", walletId: "w" };
  const ctx = (kit: unknown): LegContext => ({
    kit: kit as never,
    adapter: {},
    resolveChain: (d) => `chain-${d}`,
  });

  it("sums the fee entries into base units", async () => {
    const kit = {
      estimateBridge: async () => ({ fees: [{ amount: "0.053247" }, { amount: "0.001000" }] }),
    };
    expect(await estimateBridgeFee(ctx(kit), source, 6, "0xrecipient", "500000")).toBe("54247");
  });

  it("falls back to a conservative default when the estimate throws", async () => {
    const kit = {
      estimateBridge: async () => {
        throw new Error("Do not know how to serialize a BigInt");
      },
    };
    expect(await estimateBridgeFee(ctx(kit), source, 6, "0xrecipient", "500000")).toBe(
      DEFAULT_FEE_QUOTE_BASE_UNITS,
    );
  });

  it("falls back rather than trusting a zero quote", async () => {
    const kit = { estimateBridge: async () => ({ fees: [] }) };
    expect(await estimateBridgeFee(ctx(kit), source, 6, "0xrecipient", "500000")).toBe(
      DEFAULT_FEE_QUOTE_BASE_UNITS,
    );
  });
});
