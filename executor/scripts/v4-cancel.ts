/**
 * v4 migration, step 2: cancel and refund. THIS SENDS TRANSACTIONS.
 *
 * Cancels exactly the policies named in TARGETS and nothing else. `cancel` is onlyOwner and refunds
 * the policy's funded balance to the owner, so this recovers funds and closes a liability; it does
 * not move money to anyone new.
 *
 * The list is hardcoded rather than computed, deliberately. Which policies may be cancelled was a
 * decision about the proof base (DECISIONS D14), not a query result: five of the nine Pending
 * policies back published proofs and must not be touched. A script that recomputed "everything
 * Pending" would quietly widen its own scope the next time it ran.
 *
 * Safety, in order:
 *   1. Re-runs the citation gate: refuses if any target is cited as a proof.
 *   2. Reads each target and refuses unless it is Pending with the funded balance expected.
 *   3. Prints the plan and requires --execute to send anything.
 *   4. Verifies each receipt and reconciles the owner's balance delta against the total refunded.
 *
 *   npm run v4:cancel              plan only, sends nothing
 *   npm run v4:cancel -- --execute send the cancellations
 */
import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import { createRequire } from "node:module";
import { chainFor, ARC_DOMAIN } from "../src/config.js";
import { CircleWalletProvider } from "../src/wallet/CircleWalletProvider.js";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const TERMINAL_OK = new Set(["COMPLETE", "CONFIRMED"]);
const TERMINAL_BAD = ["FAILED", "DENIED", "CANCELLED"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The approved cancellation list (DECISIONS D14). `expectedFunded` is in 6 decimal base units and is
 * checked before sending: if a balance has moved since the inventory, the decision was made against
 * a state that no longer holds, and this stops.
 */
const TARGETS = [
  {
    vault: "v2" as const,
    env: "POLICY_VAULT_ADDRESS",
    policyId: 5n,
    expectedFunded: 500_000n,
    why: "0.50 USDC live liability: a <=0.99 depeg policy, permissionlessly releasable on a vault about to go unwatched. Cited by nothing.",
  },
  {
    vault: "v3" as const,
    env: "POLICY_VAULT_V3_ADDRESS",
    policyId: 1n,
    expectedFunded: 20_000n,
    why: "0.02 USDC, uncited recurring policy, 0 of 5 periods released.",
  },
];

/** Policies that must never appear in TARGETS. Cross-checked at runtime, not just in review. */
const PROTECTED = [
  { vault: "v2", policyId: 3n, why: "RESULTS:187 failure path, premature timelock release" },
  { vault: "v2", policyId: 8n, why: "RESULTS:108 oracle negative, threshold unmet" },
  { vault: "v2", policyId: 9n, why: "RESULTS:109 oracle negative, stale price" },
  { vault: "v3", policyId: 3n, why: "RESULTS:137 catch-up bound, period held for the owner" },
  { vault: "v3", policyId: 5n, why: "RESULTS:146 sweep stays active, a live-state proof" },
];

const STATUS = ["Pending", "Releasable", "Executed", "Cancelled"];

// The JSON form, not parseAbi's human-readable one: viem cannot parse an inline named tuple.
const BASE = [
  { name: "recipient", type: "address" }, { name: "amount", type: "uint256" }, { name: "funded", type: "uint256" },
  { name: "payoutCurrency", type: "uint8" }, { name: "destinationDomain", type: "uint32" }, { name: "conditionType", type: "uint8" },
  { name: "releaseTime", type: "uint64" }, { name: "threshold", type: "uint8" }, { name: "approvalCount", type: "uint8" },
  { name: "status", type: "uint8" }, { name: "attester", type: "address" }, { name: "attested", type: "bool" },
  { name: "feed", type: "address" }, { name: "comparator", type: "uint8" }, { name: "maxStaleSeconds", type: "uint64" },
  { name: "oracleThreshold", type: "int256" },
] as const;
const RECURRING = [
  { name: "recurring", type: "bool" }, { name: "isSweep", type: "bool" }, { name: "amountPerPeriod", type: "uint256" },
  { name: "buffer", type: "uint256" }, { name: "minSweep", type: "uint256" }, { name: "interval", type: "uint64" },
  { name: "nextDue", type: "uint64" }, { name: "maxCatchUp", type: "uint64" }, { name: "periods", type: "uint32" },
  { name: "periodsReleased", type: "uint32" },
] as const;

const abiFor = (components: readonly unknown[]) => [
  { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getPolicy", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "tuple", components }] },
] as const;

const vaultAbi = abiFor([...BASE, ...RECURRING]);
// v2 predates the recurring fields, so it needs the shorter tuple or the read over-reads and reverts.
const vaultAbiV2 = abiFor(BASE);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const usdc = (v: bigint) => `${(Number(v) / 1e6).toFixed(6)} USDC`;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set.`);
  return v;
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");

  // A target that is also protected is a contradiction in the approved list, so it is caught here
  // rather than trusted to review.
  for (const t of TARGETS) {
    const clash = PROTECTED.find((p) => p.vault === t.vault && p.policyId === t.policyId);
    if (clash) {
      throw new Error(
        `Refusing to run: ${t.vault} policy ${t.policyId} is on the cancellation list AND protected (${clash.why}).`,
      );
    }
  }

  const rpc = process.env.ARC_TESTNET_RPC_URL;
  if (!rpc) throw new Error("ARC_TESTNET_RPC_URL is not set.");

  const arc = chainFor(ARC_DOMAIN);
  const chain = { id: arc.chainId, name: arc.name, nativeCurrency: arc.nativeCurrency, rpcUrls: { default: { http: [rpc] } } };
  const transport = http(rpc, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 });
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const usdcAddress = process.env.ARC_USDC_ADDRESS as `0x${string}`;

  /**
   * cancel is onlyOwner and both vaults are owned by the Circle treasury wallet, not the deployer
   * EOA. Owner-only calls therefore go through Circle, which holds the entity secret and signs
   * internally, exactly as VaultService does for creates and funding.
   */
  const circle = initiateDeveloperControlledWalletsClient({
    apiKey: need("CIRCLE_API_KEY"),
    entitySecret: need("CIRCLE_ENTITY_SECRET"),
  });
  const treasury = await CircleWalletProvider.fromEnv().getWallet("treasury", ARC_DOMAIN);
  const signer = treasury.address;

  /** Send an owner-only call through the treasury wallet and poll to a terminal state. */
  async function ownerSend(contractAddress: string, signature: string, params: unknown[]): Promise<string> {
    const created = await circle.createContractExecutionTransaction({
      walletId: treasury.walletId,
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
      if (tx && TERMINAL_BAD.includes(tx.state)) {
        throw new Error(`${signature} ended ${tx.state}: ${[tx.errorReason, tx.errorDetails].filter(Boolean).join(" - ")}`);
      }
      if (Date.now() > deadline) throw new Error(`${signature} did not settle within 180s`);
      await sleep(2_000);
    }
  }

  console.log(`Covenant v4 migration, step 2: cancel and refund  (${execute ? "EXECUTING" : "PLAN ONLY"})\n`);

  const plan: Array<{ label: string; address: `0x${string}`; abi: any; policyId: bigint; funded: bigint }> = [];
  let total = 0n;

  for (const t of TARGETS) {
    const address = process.env[t.env] as `0x${string}` | undefined;
    if (!address) throw new Error(`${t.env} is not set.`);
    const abi = t.vault === "v2" ? vaultAbiV2 : vaultAbi;

    const [policy, owner] = await Promise.all([
      publicClient.readContract({ address, abi, functionName: "getPolicy", args: [t.policyId] }) as Promise<any>,
      publicClient.readContract({ address, abi, functionName: "owner" }) as Promise<string>,
    ]);

    const status = STATUS[policy.status] ?? `#${policy.status}`;
    if (status !== "Pending") {
      throw new Error(`${t.vault} policy ${t.policyId} is ${status}, not Pending. State moved since the inventory; stopping.`);
    }
    if (policy.funded !== t.expectedFunded) {
      throw new Error(
        `${t.vault} policy ${t.policyId} holds ${usdc(policy.funded)}, expected ${usdc(t.expectedFunded)}. ` +
          `The decision was made against a different state; stopping.`,
      );
    }

    // cancel is onlyOwner. Owner-only calls elsewhere in this project go through the Circle treasury
    // wallet, so the deployer EOA signing here is not automatically the owner. Checked rather than
    // assumed: the alternative is a revert that looks like a contract problem.
    if (owner.toLowerCase() !== signer.toLowerCase()) {
      throw new Error(
        `${t.vault} is owned by ${owner}, but this script signs as ${signer}. ` +
          `cancel() is onlyOwner, so these transactions would revert. Cancel from the owner wallet instead.`,
      );
    }

    console.log(`  ${t.vault} policy ${t.policyId}  ${address}`);
    console.log(`      status ${status}, funded ${usdc(policy.funded)}, refund goes to owner ${owner}`);
    console.log(`      signer ${signer} (Circle treasury wallet) is the owner`);
    console.log(`      ${t.why}`);

    plan.push({ label: `${t.vault}/${t.policyId}`, address, abi, policyId: t.policyId, funded: policy.funded });
    total += policy.funded;
  }

  console.log(`\n  Protected and deliberately NOT in this list:`);
  for (const p of PROTECTED) console.log(`      ${p.vault} policy ${p.policyId}  ${p.why}`);

  console.log(`\n  Transactions to send: ${plan.length}`);
  console.log(`  Total refunded:       ${usdc(total)}`);

  if (!execute) {
    console.log("\nPlan only. Nothing was sent. Re-run with --execute to send these cancellations.");
    return;
  }

  const before = (await publicClient.readContract({
    address: usdcAddress, abi: erc20Abi, functionName: "balanceOf", args: [signer as `0x${string}`],
  })) as bigint;

  console.log(`\nOwner USDC before: ${usdc(before)}\n`);

  for (const p of plan) {
    const hash = await ownerSend(p.address, "cancel(uint256)", [p.policyId.toString()]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` });
    if (receipt.status === "reverted") {
      throw new Error(`cancel(${p.policyId}) on ${p.label} REVERTED in ${hash}. Stopping before the next one.`);
    }
    console.log(`  ${p.label}  cancelled, refunded ${usdc(p.funded)}`);
    console.log(`      ${arc.explorerTxUrl(hash)}`);
  }

  const after = (await publicClient.readContract({
    address: usdcAddress, abi: erc20Abi, functionName: "balanceOf", args: [signer as `0x${string}`],
  })) as bigint;
  const delta = after - before;

  console.log(`\nOwner USDC after:  ${usdc(after)}`);
  console.log(`Balance delta:     ${usdc(delta)}`);
  console.log(`Expected refund:   ${usdc(total)}`);

  // Gas is paid in native USDC on Arc, so the delta is the refund minus fees and will not match
  // exactly. It must not EXCEED the refund, and it should not fall far short of it.
  if (delta > total) {
    console.log("\nWARNING: the balance rose by more than the expected refund. Reconcile before continuing.");
  } else if (total - delta > 10_000n) {
    console.log("\nWARNING: the balance rose by more than 0.01 USDC less than expected. Reconcile before continuing.");
  } else {
    console.log("\nReconciled: the delta matches the refund, less gas.");
  }
}

main().catch((err) => {
  console.error(`\nCancellation failed: ${err?.shortMessage ?? err?.message ?? err}`);
  process.exit(1);
});
