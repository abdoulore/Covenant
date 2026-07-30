/**
 * Attestation condition, proven onchain end to end (Phase 2).
 *
 *   npm run demo:attestation
 *
 * A policy that releases when a named attester signs an EIP-712 statement, then settles through the
 * same executor as everything else. The flow:
 *
 *   create (owner) -> fund -> attest (a real signature) -> release -> payout to the recipient
 *
 * The attester is an ephemeral key generated here. It signs the exact digest the contract exposes
 * via attestationDigest, so the signature is bound to this contract, this chain, and this policyId.
 */

import { createPublicClient, http, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { AppKit } from "@circle-fin/app-kit";
import { createRequire } from "node:module";
import { join } from "node:path";
import { EventWatcher } from "../src/chain/EventWatcher.js";
import { CursorStore } from "../src/store/CursorStore.js";
import { SettlementStore } from "../src/store/SettlementStore.js";
import { SettlementEngine } from "../src/SettlementEngine.js";
import { createLegRunner } from "../src/legs/createLegRunner.js";
import { toDecimalString } from "../src/legs/legs.js";
import { CircleWalletProvider } from "../src/wallet/CircleWalletProvider.js";
import { ARC_DOMAIN, chainFor } from "../src/config.js";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const PayoutCurrency = { USDC: 0, EURC: 1 } as const;
const AMOUNT = "500000"; // 0.50 USDC

const env = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set.`);
  return v;
};

const VAULT = env("POLICY_VAULT_ADDRESS") as `0x${string}`;
const RPC = env("ARC_TESTNET_RPC_URL");
const arc = chainFor(ARC_DOMAIN);

const publicClient = createPublicClient({
  chain: { id: arc.chainId, name: arc.name, nativeCurrency: arc.nativeCurrency, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 }),
});

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: env("CIRCLE_API_KEY"),
  entitySecret: env("CIRCLE_ENTITY_SECRET"),
});

const vaultAbi = parseAbi([
  "function nextPolicyId() view returns (uint256)",
  "function checkCondition(uint256) view returns (bool)",
  "function attestationDigest(uint256) view returns (bytes32)",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

const TERMINAL_OK = new Set(["COMPLETE", "CONFIRMED"]);

async function send(walletId: string, contractAddress: string, signature: string, params: unknown[]) {
  const created = await circle.createContractExecutionTransaction({
    walletId,
    contractAddress,
    abiFunctionSignature: signature,
    abiParameters: params,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
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

async function main() {
  const wallets = CircleWalletProvider.fromEnv();
  const treasury = await wallets.getWallet("treasury", ARC_DOMAIN);
  const recipient = env("RECIPIENT_WALLET_ADDRESS");

  // Ephemeral attester. It never needs gas or funds: it only signs.
  const attesterPk = generatePrivateKey();
  const attester = privateKeyToAccount(attesterPk);

  console.log("=== Attestation demo ===");
  console.log(`vault     ${VAULT}`);
  console.log(`attester  ${attester.address}  (ephemeral, signs only)`);
  console.log(`recipient ${recipient}`);
  console.log();

  const head = await publicClient.getBlockNumber();
  const policyId = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "nextPolicyId" });

  log(`creating attestation policy ${policyId}`);
  const createTx = await send(
    treasury.walletId,
    VAULT,
    "createAttestationPolicy(address,uint256,uint8,uint32,address)",
    [recipient, AMOUNT, PayoutCurrency.USDC, ARC_DOMAIN, attester.address],
  );
  log(`created in ${createTx}`);

  log(`funding ${toDecimalString(AMOUNT)} USDC`);
  await send(treasury.walletId, env("ARC_USDC_ADDRESS"), "approve(address,uint256)", [VAULT, AMOUNT]);
  await send(treasury.walletId, VAULT, "deposit(uint256,uint256)", [policyId.toString(), AMOUNT]);

  // Sign the exact digest the contract will verify against.
  const digest = await publicClient.readContract({
    address: VAULT, abi: vaultAbi, functionName: "attestationDigest", args: [policyId],
  });
  const signature = await sign({ hash: digest, privateKey: attesterPk, to: "hex" });
  log(`attester signed digest ${digest.slice(0, 18)}...`);

  log(`submitting attestation`);
  const attestTx = await send(treasury.walletId, VAULT, "attest(uint256,bytes)", [policyId.toString(), signature]);
  log(`attested in ${attestTx}`);

  const met = await publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "checkCondition", args: [policyId] });
  if (!met) throw new Error(`policy ${policyId} is not releasable after a valid attestation`);
  log(`checkCondition is now true`);

  log(`releasing`);
  const releaseTx = await send(treasury.walletId, VAULT, "release(uint256)", [policyId.toString()]);
  log(`released in ${releaseTx}`);

  // Settle through the normal executor path.
  const cursors = new CursorStore(join(process.cwd(), ".state", "attestation-cursor.json"));
  await cursors.set(head);
  const store = new SettlementStore(join(process.cwd(), ".state", "attestation-settlements.json"));
  const engine = new SettlementEngine({
    store,
    wallets,
    runLeg: createLegRunner(wallets, { kit: new AppKit(), kitKey: process.env.CIRCLE_KIT_KEY }),
    log,
  });
  const watcher = new EventWatcher({ client: publicClient, vaultAddress: VAULT, cursors, deployBlock: head, confirmations: 1n });

  log(`settling by watching the chain`);
  let record;
  const deadline = Date.now() + 10 * 60_000;
  while (!record && Date.now() < deadline) {
    await watcher.scanOnce(async (policy) => {
      const r = await engine.settle(policy);
      if (r) record = r;
    });
    if (!record) await sleep(3_000);
  }
  if (!record) throw new Error("policy did not settle before the deadline");

  console.log("\n=== result ===\n");
  console.log(`Attestation policy ${record.policyId}: ${toDecimalString(record.amount)} USDC on Arc`);
  console.log(`  status    ${record.status}`);
  console.log(`  attester  ${attester.address}`);
  for (const leg of record.legs) {
    console.log(`  ${leg.kind.padEnd(7)} ${leg.status}  ${leg.txHash ?? ""}`);
  }
  console.log(`  duration  ${((record.durationMs ?? 0) / 1000).toFixed(1)}s`);

  console.log("\n--- markdown for RESULTS.md ---\n");
  console.log(`| create | ${createTx} | attestation policy ${record.policyId} |`);
  console.log(`| attest | ${attestTx} | signed by ${attester.address} |`);
  console.log(`| release | ${releaseTx} | condition met |`);
  for (const leg of record.legs) {
    console.log(`| ${leg.kind} | ${leg.txHash ?? "-"} | ${leg.status} |`);
  }
}

main().catch((err) => {
  console.error("\nATTESTATION DEMO FAILED:", err?.message ?? err);
  process.exit(1);
});
