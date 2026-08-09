import { describe, expect, it } from "vitest";
import { createLegRunner } from "../src/legs/createLegRunner.js";
import { feeAllowance } from "../src/legs/legs.js";
import { ARC_DOMAIN, BASE_SEPOLIA_DOMAIN } from "../src/config.js";
import type { ManagedWallet, WalletProvider } from "../src/wallet/WalletProvider.js";
import type { ReleasedPolicy } from "../src/types.js";

const RECIPIENT = "0xrecipient";

function policy(over: Partial<ReleasedPolicy> = {}): ReleasedPolicy {
  return {
    policyId: "1",
    periodIndex: 0, // single-shot release; recurring policies number theirs from 1
    recipient: RECIPIENT,
    amount: "500000",
    payoutCurrency: "USDC",
    destinationDomain: BASE_SEPOLIA_DOMAIN,
    executor: "0xexec",
    releaseTxHash: "0xrelease",
    releaseBlockNumber: 1n,
    ...over,
  };
}

/**
 * Provider whose destination balance rises by `mintDelivers` after a bridge, so the runner can
 * measure a real delta. Quote comes from the fake kit; the runner sizes the allowance itself.
 */
function fakeProvider(recipientBalances: string[]): WalletProvider {
  const balances = [...recipientBalances];
  return {
    getWallet: async (role, domain): Promise<ManagedWallet> => ({
      role,
      domain,
      address: `0x${role}-${domain}`,
      walletId: `${role}-${domain}`,
    }),
    getAdapter: () => ({}),
    // Ample working balance so the same-chain payout guard never trips in these tests.
    getBalance: async () => "100000000",
    getBalanceAt: async () => balances.shift() ?? balances.at(-1) ?? "0",
  };
}

interface FakeKit {
  estimateBridge: (p: unknown) => Promise<{ fees: Array<{ amount: string }> }>;
  bridge: (p: { amount: string }) => Promise<unknown>;
  send?: (p: { amount: string }) => Promise<unknown>;
}

function fakeKit(quoteDecimal: string, capture: { burnAmount?: string }): FakeKit {
  return {
    estimateBridge: async () => ({ fees: [{ amount: quoteDecimal }] }),
    bridge: async (params) => {
      capture.burnAmount = params.amount;
      return { state: "success", steps: [{ name: "mint", state: "success", txHash: "0xmint" }] };
    },
  };
}

describe("createLegRunner bridge gross-up", () => {
  it("burns the policy amount plus the fee allowance", async () => {
    const capture: { burnAmount?: string } = {};
    // recipient starts at 0, then holds the minted amount after the bridge.
    const provider = fakeProvider(["0", "500000"]);
    const runLeg = createLegRunner(provider, { kit: fakeKit("0.053247", capture) as never });

    await runLeg("bridge", policy(), provider, "500000");

    // 0.500000 policy + max(3 * 0.053247, 0.053247 + 0.05) = 0.500000 + 0.159741 burned.
    const expectedBurn = (500_000n + BigInt(feeAllowance("53247"))).toString();
    // burn amount reaches the SDK as a decimal string.
    expect(capture.burnAmount).toBe("0.659741");
    expect(expectedBurn).toBe("659741");
  });

  it("records quote, allowance, actual and delivered", async () => {
    const capture: { burnAmount?: string } = {};
    // Burn 0.659741, recipient receives 0.600000, so the actual fee was 0.059741.
    const provider = fakeProvider(["0", "600000"]);
    const runLeg = createLegRunner(provider, { kit: fakeKit("0.053247", capture) as never });

    const result = await runLeg("bridge", policy(), provider, "500000");

    expect(result.fee).toMatchObject({
      quote: "53247",
      allowance: "159741",
      delivered: "600000",
      actual: "59741",
      divergence: false,
    });
  });

  it("flags divergence when the recipient receives less than the policy amount", async () => {
    const capture: { burnAmount?: string } = {};
    // A fee spike: recipient ends up with 0.450000, below the 0.500000 policy amount.
    const provider = fakeProvider(["0", "450000"]);
    const runLeg = createLegRunner(provider, { kit: fakeKit("0.053247", capture) as never });

    const result = await runLeg("bridge", policy(), provider, "500000");

    expect(result.fee?.divergence).toBe(true);
    expect(result.fee?.delivered).toBe("450000");
  });

  it("records quote and allowance even when delivery cannot be measured", { timeout: 15_000 }, async () => {
    const capture: { burnAmount?: string } = {};
    // Balance never rises (measurement fails), so actual and delivered stay absent.
    const provider = fakeProvider(["0", "0", "0", "0"]);
    const runLeg = createLegRunner(provider, { kit: fakeKit("0.053247", capture) as never });

    const result = await runLeg("bridge", policy(), provider, "500000");

    expect(result.fee?.quote).toBe("53247");
    expect(result.fee?.allowance).toBe("159741");
    expect(result.fee?.actual).toBeUndefined();
    expect(result.fee?.divergence).toBeUndefined();
  });

  it("does not gross up the same-chain payout path", async () => {
    const capture: { burnAmount?: string } = {};
    const provider = fakeProvider(["0"]);
    const kit = fakeKit("0.053247", capture);
    kit.send = async (p) => {
      capture.burnAmount = p.amount;
      return { txHash: "0xsend" };
    };
    const runLeg = createLegRunner(provider, { kit: kit as never });

    await runLeg("payout", policy({ destinationDomain: ARC_DOMAIN }), provider, "500000");

    // Same-chain payout sends the exact amount, no allowance added.
    expect(capture.burnAmount).toBe("0.5");
  });
});
