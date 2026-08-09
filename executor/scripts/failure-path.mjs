/**
 * Demonstrate the failure path onchain, with a captured transaction hash.
 *
 *   node --env-file=.env executor/scripts/failure-path.mjs
 *
 * Creates a timelock policy whose release time is in the future, then attempts to release it and
 * records the reverted transaction. Never demo only the happy path.
 *
 * Why this does not use a Circle wallet
 * ------------------------------------
 * Circle developer-controlled wallets simulate before broadcasting and refuse to submit anything
 * that would revert, failing with ESTIMATION_ERROR and no txHash. That is correct behaviour for a
 * payments product and useless for proving a revert happened onchain. So the release attempt is
 * sent from a raw EOA with an explicit gas limit, which skips estimation and puts the failing
 * transaction on chain where it can be linked and verified. The policy is still created by the
 * treasury Circle wallet, because createPolicy is owner-gated.
 */

import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { executeContract } from "./lib/circle-tx.mjs";
import { currentVaultAddress } from "./lib/vault-address.mjs";

const ConditionType = { Timelock: 0, Approval: 1 };
const PayoutCurrency = { USDC: 0, EURC: 1 };
const ARC_DOMAIN = 26;
const AMOUNT = 1_000_000n;

/** Enough for the call to run and revert. Estimation is skipped, so this must be set by hand. */
const FORCED_GAS_LIMIT = 300_000n;

const env = (n) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set`);
  return v;
};

const VAULT = currentVaultAddress();
const RPC = env("ARC_TESTNET_RPC_URL");

const arcTestnet = {
  id: Number(process.env.ARC_CHAIN_ID ?? 5042002),
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const transport = http(RPC, { retryCount: 0, timeout: 30_000 });
const publicClient = createPublicClient({ chain: arcTestnet, transport });
const account = privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY"));
const walletClient = createWalletClient({ account, chain: arcTestnet, transport });

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: env("CIRCLE_API_KEY"),
  entitySecret: env("CIRCLE_ENTITY_SECRET"),
});

const vaultAbi = parseAbi([
  "function nextPolicyId() view returns (uint256)",
  "function checkCondition(uint256) view returns (bool)",
  "function release(uint256)",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function read(fn, label) {
  let delay = 2_000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await sleep(800);
      return await fn();
    } catch (err) {
      if (!/request limit|rate limit|429/i.test(String(err?.message ?? err)) || attempt === 6) throw err;
      console.log(`  (rate limited on ${label}, retrying in ${delay / 1000}s)`);
      await sleep(delay);
      delay *= 2;
    }
  }
}

async function main() {
  const policyId = await read(
    () => publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "nextPolicyId" }),
    "nextPolicyId",
  );

  const releaseTime = BigInt(Math.floor(Date.now() / 1000) + 86_400); // 24h out, never reachable in this run
  console.log(`creating timelock policy ${policyId}, releasable at ${releaseTime} (24h from now)`);

  const created = await executeContract(circle, {
    walletId: env("TREASURY_WALLET_ID"),
    contractAddress: VAULT,
    signature: "createPolicy(address,uint256,uint8,uint32,uint8,uint64,address[],uint8)",
    params: [
      env("RECIPIENT_WALLET_ADDRESS"),
      AMOUNT.toString(),
      PayoutCurrency.USDC,
      ARC_DOMAIN,
      ConditionType.Timelock,
      releaseTime.toString(),
      [],
      0,
    ],
    label: "createPolicy (timelock)",
  });
  console.log(`  createPolicy  ${created.txHash}`);

  const releasable = await read(
    () => publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "checkCondition", args: [policyId] }),
    "checkCondition",
  );
  console.log(`  checkCondition -> ${releasable} (must be false)`);
  if (releasable) throw new Error("policy is releasable, cannot demonstrate the failure path");

  console.log(`\nattempting release before the timelock expires, from ${account.address}`);
  const hash = await walletClient.writeContract({
    address: VAULT,
    abi: vaultAbi,
    functionName: "release",
    args: [policyId],
    gas: FORCED_GAS_LIMIT, // skip estimation so the revert lands onchain
  });
  console.log(`  broadcast ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  status    ${receipt.status}`);
  console.log(`  gas used  ${receipt.gasUsed}`);

  if (receipt.status !== "reverted") {
    throw new Error(`expected the release to revert, got status=${receipt.status}. The condition gate is broken.`);
  }

  console.log("\n--- for RESULTS.md ---");
  console.log(`| failure path: premature release | ${hash} | reverted onchain, status 0 |`);
  console.log(`https://testnet.arcscan.app/tx/${hash}`);
}

main().catch((err) => {
  console.error("\nFAILED:", err?.message ?? err);
  process.exit(1);
});

