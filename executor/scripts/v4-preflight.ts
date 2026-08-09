/**
 * v4 re-proof, pre-flight. READ ONLY. This script sends no transaction.
 *
 * Computes what the twelve-row pass needs, reads what the wallets actually hold, and reports the
 * shortfall per wallet so the whole pass can be funded before it starts.
 *
 * The reason this exists rather than a mid-pass faucet trip: a proof pass that pauses for funding
 * produces a timeline with an unexplained gap in it, and the timings are part of what is being
 * proven. Funding up front keeps the run clean and makes the balance accounting part of the record.
 *
 *   npm run v4:preflight
 */
import { createPublicClient, fallback, http, parseAbi, type PublicClient } from "viem";
import { chainFor, ARC_DOMAIN, BASE_SEPOLIA_DOMAIN } from "../src/config.js";

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

type Wallet = "treasury" | "executor" | "executorDest";

interface Need {
  row: string;
  wallet: Wallet;
  amount: bigint;
  why: string;
}

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/**
 * What each row of the re-proof pass costs, in 6 decimal USDC.
 *
 * Policy amounts are what the treasury must deposit. Executor working balance is separate and is
 * NOT the policy amount: transit fees are deducted from the amount in flight (V17), and the recipient
 * is grossed up from the executor's own balance so it never receives less than the policy says
 * (D6). Cross-chain rows therefore cost the executor real money beyond what the vault releases.
 */
const NEEDS: Need[] = [
  { row: "1 timelock FX on Arc", wallet: "treasury", amount: USDC(0.5), why: "policy amount, swapped to EURC" },
  { row: "1 timelock FX on Arc", wallet: "executor", amount: USDC(0.1), why: "swap slippage and gas headroom" },

  { row: "2 cross-chain to Base Sepolia", wallet: "treasury", amount: USDC(0.5), why: "policy amount" },
  { row: "2 cross-chain to Base Sepolia", wallet: "executor", amount: USDC(0.3), why: "CCTP forwarder fee gross-up, measured up to 1.9x the quote (V18)" },

  { row: "3 approval N-of-M", wallet: "treasury", amount: USDC(0.1), why: "policy amount" },
  { row: "4 attestation EIP-712", wallet: "treasury", amount: USDC(0.1), why: "policy amount" },

  { row: "5 oracle, pushed feed", wallet: "treasury", amount: USDC(0.1), why: "policy amount" },
  { row: "5 oracle, pushed feed", wallet: "executor", amount: USDC(0.01), why: "Pyth update fee, 1 wei plus gas" },

  { row: "6 oraclePull atomic", wallet: "treasury", amount: USDC(0.1), why: "policy amount" },
  { row: "6 oraclePull atomic", wallet: "executor", amount: USDC(0.01), why: "parsePriceFeedUpdates fee plus gas" },

  { row: "7 oraclePull confidence rejection", wallet: "treasury", amount: USDC(0.1), why: "policy amount, refused so not spent" },
  { row: "7 oraclePull confidence rejection", wallet: "executor", amount: USDC(0.01), why: "fee is still paid on a refused release" },

  { row: "8 fail-closed, future-dated feed", wallet: "executor", amount: USDC(0.02), why: "probe and release-attempt gas on two vaults" },

  { row: "9 recurring payroll", wallet: "treasury", amount: USDC(0.05), why: "5 periods of 0.01" },
  { row: "10 sweep above buffer", wallet: "treasury", amount: USDC(0.15), why: "0.05 buffer plus sweepable excess" },
  { row: "11 condition unmet reverts", wallet: "executor", amount: USDC(0.01), why: "forced-gas revert transaction" },
  { row: "12 Gateway funding", wallet: "treasury", amount: USDC(0.05), why: "policy amount, sourced cross-chain" },

  // Every row costs gas, and gas on Arc is USDC. Counted once rather than smeared across the rows.
  { row: "all rows", wallet: "treasury", amount: USDC(0.25), why: "create, approve, and deposit gas across the pass" },
  { row: "all rows", wallet: "executor", amount: USDC(0.15), why: "settlement leg gas across the pass" },
];

/** Margin on top of the computed requirement, so a fee moving does not stall the pass. */
const MARGIN = 1.5;

const usdc = (v: bigint) => `${(Number(v) / 1e6).toFixed(6)}`;

async function main(): Promise<void> {
  const need = (n: string): string => {
    const v = process.env[n];
    if (!v) throw new Error(`${n} is not set.`);
    return v;
  };

  const arc = chainFor(ARC_DOMAIN);
  const base = chainFor(BASE_SEPOLIA_DOMAIN);
  const arcRpc = need("ARC_TESTNET_RPC_URL");
  const baseRpc = need("BASE_SEPOLIA_RPC_URL");

  /**
   * Build a client over the primary endpoint with the documented fallback behind it.
   *
   * viem's fallback transport is why both _RPC_URL and _RPC_FALLBACK_URL exist in .env: the public
   * endpoints rate limit, and a pre-flight that reports "balance read failed" for a transient 429
   * would send someone to a faucet they may not need.
   */
  const clientFor = (chainCfg: typeof arc, primary: string, secondary?: string) =>
    createPublicClient({
      chain: {
        id: chainCfg.chainId,
        name: chainCfg.name,
        nativeCurrency: chainCfg.nativeCurrency,
        rpcUrls: { default: { http: secondary ? [primary, secondary] : [primary] } },
      },
      transport: fallback(
        [primary, ...(secondary ? [secondary] : [])].map((url) =>
          http(url, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 }),
        ),
      ),
    }) as PublicClient;

  const arcClient = clientFor(arc, arcRpc, process.env.ARC_TESTNET_RPC_FALLBACK_URL);
  const baseClient = clientFor(base, baseRpc, process.env.BASE_SEPOLIA_RPC_FALLBACK_URL);

  const wallets: Record<Wallet, { label: string; address: `0x${string}`; client: PublicClient; token: `0x${string}`; chainName: string }> = {
    treasury: {
      label: "treasury (Arc)", address: need("TREASURY_WALLET_ADDRESS") as `0x${string}`,
      client: arcClient, token: need("ARC_USDC_ADDRESS") as `0x${string}`, chainName: arc.name,
    },
    executor: {
      label: "executor (Arc)", address: need("EXECUTOR_WALLET_ADDRESS") as `0x${string}`,
      client: arcClient, token: need("ARC_USDC_ADDRESS") as `0x${string}`, chainName: arc.name,
    },
    executorDest: {
      label: "executor (Base Sepolia)", address: need("EXECUTOR_DEST_WALLET_ADDRESS") as `0x${string}`,
      client: baseClient, token: need("BASE_SEPOLIA_USDC_ADDRESS") as `0x${string}`, chainName: base.name,
    },
  };

  console.log("Covenant v4 re-proof pre-flight (READ ONLY, no transactions)\n");
  console.log("Requirement per row:\n");

  const required: Record<Wallet, bigint> = { treasury: 0n, executor: 0n, executorDest: 0n };
  for (const n of NEEDS) {
    required[n.wallet] += n.amount;
    console.log(`  ${n.row.padEnd(36)} ${wallets[n.wallet].label.padEnd(26)} ${usdc(n.amount).padStart(10)}  ${n.why}`);
  }

  console.log("\nBalances and shortfall:\n");
  console.log(`  ${"wallet".padEnd(28)}${"required".padStart(12)}${"+margin".padStart(12)}${"held".padStart(12)}${"shortfall".padStart(12)}`);
  console.log("  " + "-".repeat(76));

  let anyShort = false;
  const topUps: string[] = [];

  for (const key of Object.keys(wallets) as Wallet[]) {
    const w = wallets[key];
    const target = BigInt(Math.round(Number(required[key]) * MARGIN));
    let held = 0n;
    try {
      held = (await w.client.readContract({
        address: w.token, abi: erc20Abi, functionName: "balanceOf", args: [w.address],
      })) as bigint;
    } catch (err: any) {
      console.log(`  ${w.label.padEnd(28)} balance read failed: ${err?.shortMessage ?? err?.message ?? err}`);
      continue;
    }

    const short = target > held ? target - held : 0n;
    if (short > 0n) {
      anyShort = true;
      topUps.push(`  ${w.label}  ${w.address}  needs ${usdc(short)} USDC on ${w.chainName}`);
    }

    console.log(
      `  ${w.label.padEnd(28)}${usdc(required[key]).padStart(12)}${usdc(target).padStart(12)}` +
        `${usdc(held).padStart(12)}${(short > 0n ? usdc(short) : "ok").padStart(12)}`,
    );
  }

  console.log(`\n  Margin applied: ${MARGIN}x, so a fee moving mid-pass does not stall it.`);

  if (!anyShort) {
    console.log("\nPRE-FLIGHT PASSED: every wallet holds enough for the full twelve-row pass.");
    console.log("Record these balances in the RESULTS re-proof preamble before starting.");
    return;
  }

  console.log("\nTOP UP BEFORE STARTING. Faucet: https://faucet.circle.com (Arc Testnet and Base Sepolia)\n");
  for (const t of topUps) console.log(t);
  console.log(
    "\nThe pass is not started until these clear. A run that pauses for funding leaves an\n" +
      "unexplained gap in a timeline that is itself part of the proof.",
  );
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(`\nPre-flight failed: ${err?.shortMessage ?? err?.message ?? err}`);
  process.exit(1);
});
