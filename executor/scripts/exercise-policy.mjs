/**
 * Exercise PolicyVault end to end on Arc testnet, including the failure path.
 *
 *   node --env-file=.env executor/scripts/exercise-policy.mjs
 *
 * Proves the contract primitive before any routing legs exist: a policy is created, a release is
 * attempted before its condition is met and reverts onchain, then the condition is satisfied and
 * the release succeeds, moving funds to the executor wallet.
 *
 * Writes are signed by Circle developer-controlled wallets. Reads go straight to the Arc RPC.
 * All amounts are in the 6 decimal ERC-20 view. See VERIFICATIONS.md V1a.
 */

import { createPublicClient, http, parseAbi } from "viem";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { executeContract, executeContractExpectingRevert } from "./lib/circle-tx.mjs";

const ConditionType = { Timelock: 0, Approval: 1 };
const PayoutCurrency = { USDC: 0, EURC: 1 };
const ARC_DOMAIN = 26;

const AMOUNT = 1_000_000n; // 1.00 USDC. Keep small, faucet limits are tight (V6).

const env = (n) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set`);
  return v;
};

const VAULT = env("POLICY_VAULT_ADDRESS");
const USDC = env("ARC_USDC_ADDRESS");
const RPC = env("ARC_TESTNET_RPC_URL");
const TREASURY_ID = env("TREASURY_WALLET_ID");
const TREASURY_ADDR = env("TREASURY_WALLET_ADDRESS");
const RECIPIENT_ADDR = env("RECIPIENT_WALLET_ADDRESS");
const EXECUTOR_ADDR = env("EXECUTOR_WALLET_ADDRESS");

const vaultAbi = parseAbi([
  "function nextPolicyId() view returns (uint256)",
  "function checkCondition(uint256) view returns (bool)",
  "function statusOf(uint256) view returns (uint8)",
  "function policyOf(uint256) view returns (address,uint256,uint256,uint8,uint32,uint8,uint64,uint8,uint8,uint8)",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/**
 * Declaring the chain matters for more than tidiness: without it viem re-queries eth_chainId on
 * every call, which doubles request count against a public RPC that rate limits. nativeCurrency
 * is 18 decimals because that is the native gas view; policy amounts use the 6 decimal ERC-20
 * view and never touch this. See VERIFICATIONS.md V1a.
 */
const arcTestnet = {
  id: Number(process.env.ARC_CHAIN_ID ?? 5042002),
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(RPC, { retryCount: 0, timeout: 30_000 }),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The public Arc RPC rate limits hard, and viem's built-in retry makes it worse by retrying fast.
 * Back off geometrically instead, and pace every read. Reads here are few and not latency
 * sensitive, so paying a second per call is cheaper than a failed run.
 */
async function read(fn, label) {
  let delay = 2_000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await sleep(800);
      return await fn();
    } catch (err) {
      const limited = /request limit|rate limit|429/i.test(String(err?.message ?? err));
      if (!limited || attempt === 6) throw err;
      console.log(`  (rate limited on ${label}, retrying in ${delay / 1000}s)`);
      await sleep(delay);
      delay *= 2;
    }
  }
}
const circle = initiateDeveloperControlledWalletsClient({
  apiKey: env("CIRCLE_API_KEY"),
  entitySecret: env("CIRCLE_ENTITY_SECRET"),
});

const usdc = (raw) => `${(Number(raw) / 1e6).toFixed(6)} USDC`;
const legs = [];

function record(name, txHash, startedAt) {
  const ms = Date.now() - startedAt;
  legs.push({ name, txHash, ms });
  console.log(`  ${name.padEnd(22)} ${txHash ?? "(reverted)"}  ${ms}ms`);
}

async function balanceOf(address) {
  return read(
    () => publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    `balanceOf(${address.slice(0, 10)})`,
  );
}

async function main() {
  console.log(`vault    ${VAULT}`);
  console.log(`treasury ${TREASURY_ADDR}  ${usdc(await balanceOf(TREASURY_ADDR))}`);
  console.log(`executor ${EXECUTOR_ADDR}  ${usdc(await balanceOf(EXECUTOR_ADDR))}`);

  const policyId = await read(
    () => publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "nextPolicyId" }),
    "nextPolicyId",
  );
  console.log(`\nPolicy A (FX archetype): 1 USDC, payout EURC on Arc, 1-of-1 approval\npolicyId ${policyId}\n`);

  const runStart = Date.now();

  // 1. Create. Owner only, so this is signed by the treasury wallet.
  let t = Date.now();
  let r = await executeContract(circle, {
    walletId: TREASURY_ID,
    contractAddress: VAULT,
    signature: "createPolicy(address,uint256,uint8,uint32,uint8,uint64,address[],uint8)",
    params: [RECIPIENT_ADDR, AMOUNT.toString(), PayoutCurrency.EURC, ARC_DOMAIN, ConditionType.Approval, "0", [TREASURY_ADDR], 1],
    label: "createPolicy",
  });
  record("createPolicy", r.txHash, t);

  // 2. Failure path, before anything is funded or approved. This revert is a deliverable.
  console.log("\n  failure path: release before condition met");
  t = Date.now();
  const failed = await executeContractExpectingRevert(circle, {
    walletId: TREASURY_ID,
    contractAddress: VAULT,
    signature: "release(uint256)",
    params: [policyId.toString()],
    label: "release (premature)",
  });
  record("release (premature)", null, t);
  console.log(`  reverted as required`);

  // 3. Approve the vault to pull USDC, then fund the policy.
  t = Date.now();
  r = await executeContract(circle, {
    walletId: TREASURY_ID,
    contractAddress: USDC,
    signature: "approve(address,uint256)",
    params: [VAULT, AMOUNT.toString()],
    label: "usdc.approve",
  });
  record("usdc.approve", r.txHash, t);

  t = Date.now();
  r = await executeContract(circle, {
    walletId: TREASURY_ID,
    contractAddress: VAULT,
    signature: "deposit(uint256,uint256)",
    params: [policyId.toString(), AMOUNT.toString()],
    label: "deposit",
  });
  record("deposit", r.txHash, t);

  // 4. Satisfy the condition.
  t = Date.now();
  r = await executeContract(circle, {
    walletId: TREASURY_ID,
    contractAddress: VAULT,
    signature: "approve(uint256)",
    params: [policyId.toString()],
    label: "approve(policyId)",
  });
  record("approve(policy)", r.txHash, t);

  const releasable = await read(
    () => publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "checkCondition", args: [policyId] }),
    "checkCondition",
  );
  console.log(`  checkCondition -> ${releasable}`);
  if (!releasable) throw new Error("condition still not met after approval");

  // 5. Release. Permissionless, but signed here by treasury for convenience.
  t = Date.now();
  r = await executeContract(circle, {
    walletId: TREASURY_ID,
    contractAddress: VAULT,
    signature: "release(uint256)",
    params: [policyId.toString()],
    label: "release",
  });
  record("release", r.txHash, t);

  const total = Date.now() - runStart;
  console.log(`\nexecutor balance now ${usdc(await balanceOf(EXECUTOR_ADDR))}`);
  console.log(`total wall clock ${(total / 1000).toFixed(1)}s`);

  console.log("\n--- for RESULTS.md ---");
  for (const l of legs) {
    console.log(`| ${l.name} | ${l.txHash ?? "reverted, see failure path"} | ${l.ms}ms |`);
  }
}

main().catch((err) => {
  console.error("\nFAILED:", err?.message ?? err);
  if (err?.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
