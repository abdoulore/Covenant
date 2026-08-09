/**
 * The canary: both policy archetypes, end to end, on live testnets.
 *
 *   npm run canary
 *
 * Creates two policies, satisfies their conditions, and lets the executor settle them by watching
 * the chain. Nothing here tells the executor what to do: it finds work by scanning for
 * PolicyReleased, exactly as it would if the policies had been created by someone else.
 *
 * Policy A, FX archetype, entirely on Arc:
 *   deposit -> approval -> release -> swap USDC to EURC -> pay the recipient in EURC
 *
 * Policy B, cross-chain archetype:
 *   deposit -> approval -> release -> bridge USDC via CCTP -> pay the recipient on Base Sepolia
 *
 * See docs/DECISIONS.md D1 for why these two rather than one combined flow: EURC has no
 * cross-chain route, so a single settlement delivering EURC to another chain is not buildable.
 */

import { createPublicClient, http, parseAbi } from "viem";
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
import { ARC_DOMAIN, BASE_SEPOLIA_DOMAIN, chainFor } from "../src/config.js";
import type { SettlementRecord } from "../src/types.js";
import { currentVaultAddress } from "../src/api/vaults.js";

// Same CJS workaround as CircleWalletProvider. See docs/VERIFICATIONS.md V16.
const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const ConditionType = { Timelock: 0, Approval: 1 } as const;
const PayoutCurrency = { USDC: 0, EURC: 1 } as const;

/** Small on purpose. Faucet limits are tight and every leg costs gas in USDC (V6). */
const AMOUNT = "500000"; // 0.50 USDC

const env = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set. Copy .env.example to .env and fill it.`);
  return v;
};

const VAULT = currentVaultAddress();
const RPC = env("ARC_TESTNET_RPC_URL");

const arc = chainFor(ARC_DOMAIN);
const publicClient = createPublicClient({
  chain: {
    id: arc.chainId,
    name: arc.name,
    nativeCurrency: arc.nativeCurrency,
    rpcUrls: { default: { http: [RPC] } },
  },
  transport: http(RPC, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 }),
});

const circle = initiateDeveloperControlledWalletsClient({
  apiKey: env("CIRCLE_API_KEY"),
  entitySecret: env("CIRCLE_ENTITY_SECRET"),
});

const vaultAbi = parseAbi([
  "function nextPolicyId() view returns (uint256)",
  "function checkCondition(uint256) view returns (bool)",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

async function read<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let delay = 2_000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await sleep(500);
      return await fn();
    } catch (err) {
      if (!/request limit|rate limit|429/i.test(String(err)) || attempt === 6) throw err;
      log(`rate limited on ${label}, retrying in ${delay / 1000}s`);
      await sleep(delay);
      delay *= 2;
    }
  }
  throw new Error("unreachable");
}

const TERMINAL_OK = new Set(["COMPLETE", "CONFIRMED"]);

/** Submit a contract call from a Circle wallet and wait for it to land. See V14 for state notes. */
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

interface PolicySpec {
  label: string;
  payoutCurrency: 0 | 1;
  destinationDomain: number;
  recipientEnv: string;
}

/** Create, fund, approve and release one policy. Returns its id. */
async function stagePolicy(spec: PolicySpec, treasuryId: string, treasuryAddr: string): Promise<bigint> {
  const policyId = await read(
    () => publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "nextPolicyId" }),
    "nextPolicyId",
  );

  log(`${spec.label}: creating policy ${policyId}`);
  await send(treasuryId, VAULT, "createPolicy(address,uint256,uint8,uint32,uint8,uint64,address[],uint8)", [
    env(spec.recipientEnv),
    AMOUNT,
    spec.payoutCurrency,
    spec.destinationDomain,
    ConditionType.Approval,
    "0",
    [treasuryAddr],
    1,
  ]);

  log(`${spec.label}: approving vault to pull ${toDecimalString(AMOUNT)} USDC`);
  await send(treasuryId, env("ARC_USDC_ADDRESS"), "approve(address,uint256)", [VAULT, AMOUNT]);

  log(`${spec.label}: depositing`);
  await send(treasuryId, VAULT, "deposit(uint256,uint256)", [policyId.toString(), AMOUNT]);

  log(`${spec.label}: satisfying approval condition`);
  await send(treasuryId, VAULT, "approve(uint256)", [policyId.toString()]);

  const releasable = await read(
    () => publicClient.readContract({ address: VAULT, abi: vaultAbi, functionName: "checkCondition", args: [policyId] }),
    "checkCondition",
  );
  if (!releasable) throw new Error(`policy ${policyId} is not releasable after approval`);

  log(`${spec.label}: releasing`);
  const releaseTx = await send(treasuryId, VAULT, "release(uint256)", [policyId.toString()]);
  log(`${spec.label}: released in ${releaseTx}`);

  return policyId;
}

async function main() {
  const wallets = CircleWalletProvider.fromEnv();
  const treasury = await wallets.getWallet("treasury", ARC_DOMAIN);
  const executorArc = await wallets.getWallet("executor", ARC_DOMAIN);
  const executorDest = await wallets.getWallet("executor", BASE_SEPOLIA_DOMAIN);

  console.log("=== Covenant canary ===");
  console.log(`vault     ${VAULT}`);
  console.log(`treasury  ${treasury.address}  ${toDecimalString(await wallets.getBalance(treasury, "USDC"))} USDC`);
  console.log(`executor  ${executorArc.address}  ${toDecimalString(await wallets.getBalance(executorArc, "USDC"))} USDC on Arc`);
  console.log(`executor  ${executorDest.address}  (destination chain)`);
  console.log();

  // Start scanning from the current head, not the deploy block: policies settled in earlier runs
  // are already recorded, and replaying them would be rejected but would waste a long scan.
  const head = await publicClient.getBlockNumber();
  const cursors = new CursorStore(join(process.cwd(), ".state", "canary-cursor.json"));
  await cursors.set(head);

  const store = new SettlementStore(join(process.cwd(), ".state", "canary-settlements.json"));
  const engine = new SettlementEngine({
    store,
    wallets,
    runLeg: createLegRunner(wallets, { kit: new AppKit(), kitKey: process.env.CIRCLE_KIT_KEY }),
    log,
  });

  const watcher = new EventWatcher({
    client: publicClient,
    vaultAddress: VAULT,
    cursors,
    deployBlock: head,
    confirmations: 1n,
  });

  const specs: PolicySpec[] = [
    { label: "Policy A (FX)", payoutCurrency: PayoutCurrency.EURC, destinationDomain: ARC_DOMAIN, recipientEnv: "RECIPIENT_WALLET_ADDRESS" },
    { label: "Policy B (cross-chain)", payoutCurrency: PayoutCurrency.USDC, destinationDomain: BASE_SEPOLIA_DOMAIN, recipientEnv: "RECIPIENT_DEST_WALLET_ADDRESS" },
  ];

  const expected: bigint[] = [];
  for (const spec of specs) {
    expected.push(await stagePolicy(spec, treasury.walletId, treasury.address));
  }

  log(`staged ${expected.length} policies, now settling by watching the chain`);

  const settled = new Map<string, SettlementRecord>();
  const deadline = Date.now() + 15 * 60_000;

  while (settled.size < expected.length && Date.now() < deadline) {
    await watcher.scanOnce(async (policy) => {
      const record = await engine.settle(policy);
      if (record) settled.set(record.policyId, record);
    });
    if (settled.size < expected.length) await sleep(3_000);
  }

  if (settled.size < expected.length) {
    throw new Error(`only ${settled.size}/${expected.length} policies settled before the deadline`);
  }

  report([...settled.values()]);
}

function report(records: SettlementRecord[]) {
  console.log("\n=== results ===\n");
  for (const r of records) {
    const chain = chainFor(r.destinationDomain);
    console.log(`Policy ${r.policyId}: ${toDecimalString(r.amount)} -> ${r.payoutCurrency} on ${chain.name}`);
    console.log(`  status    ${r.status}`);
    console.log(`  release   ${r.releaseExplorerUrl}`);
    for (const leg of r.legs) {
      const out = leg.outputAmount ? ` (produced ${toDecimalString(leg.outputAmount)})` : "";
      console.log(`  ${leg.kind.padEnd(7)} ${leg.status}${out}`);
      if (leg.explorerUrl) console.log(`          ${leg.explorerUrl}`);
    }
    console.log(`  duration  ${((r.durationMs ?? 0) / 1000).toFixed(1)}s`);
    console.log(`  custody   ${((r.custodyGapMs ?? 0) / 1000).toFixed(1)}s in the executor wallet\n`);
  }

  console.log("--- markdown for RESULTS.md ---\n");
  for (const r of records) {
    console.log(`| policy ${r.policyId} | release | ${r.releaseTxHash} | |`);
    for (const leg of r.legs) {
      console.log(`| policy ${r.policyId} | ${leg.kind} | ${leg.txHash ?? "-"} | ${leg.status} |`);
    }
  }
}

main().catch((err) => {
  console.error("\nCANARY FAILED:", err?.message ?? err);
  process.exit(1);
});

