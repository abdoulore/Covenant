/**
 * v4 migration, step 1: inventory. READ ONLY. This script sends no transaction.
 *
 * It answers two questions before anything is cancelled:
 *
 *   1. Which policies on v3 and v2 are still Pending, and therefore in scope for cancel-and-refund?
 *   2. Is any policy cited as a proof in RESULTS.md among them?
 *
 * The second question is the gate. `cancel` requires Pending, so the assumption behind the whole
 * migration is that every cited proof is Executed and structurally untouchable. If that assumption
 * is wrong for even one policy, cancelling would destroy a proof the project's credibility rests on,
 * and this script says STOP rather than letting the migration proceed on an assumption.
 *
 *   npm run v4:inventory
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { chainFor, ARC_DOMAIN } from "../src/config.js";

const STATUS = ["Pending", "Releasable", "Executed", "Cancelled"];
const CONDITION = ["Timelock", "Approval", "Attestation", "Oracle", "Schedule", "OraclePull"];

/**
 * Policies cited as proofs in docs/RESULTS.md, listed explicitly rather than scraped.
 *
 * A regex over the prose would fail open: a citation phrased slightly differently would simply not
 * match, and the gate would pass by missing it. This list is maintained by hand against the document
 * and each entry carries the line that cites it, so a reviewer can check it rather than trust it.
 */
const CITED: Array<{ vault: "v2" | "v3"; id: number; where: string }> = [
  // v2, the four condition types and the oracle demo.
  { vault: "v2", id: 0, where: "RESULTS:78,82,87  attestation demo, settled in 6.8s" },
  { vault: "v2", id: 1, where: "RESULTS:51  FX archetype, entirely on Arc" },
  { vault: "v2", id: 2, where: "RESULTS:63  cross-chain archetype, Arc to Base Sepolia" },
  { vault: "v2", id: 3, where: "RESULTS:17,181  failure path, release refused when condition unmet" },
  { vault: "v2", id: 7, where: "RESULTS:99  oracle depeg demo, settled in 9.0s" },
  // v3, scheduling and Gateway.
  { vault: "v3", id: 2, where: "RESULTS:127  payroll, three periods then retires" },
  { vault: "v3", id: 3, where: "RESULTS:137  catch-up bound, overdue period held for the owner" },
  { vault: "v3", id: 4, where: "RESULTS:169  Gateway-funded policy" },
  { vault: "v3", id: 5, where: "RESULTS:146  sweep, keeps a buffer and stays active" },
];

/**
 * Proofs RESULTS cites by transaction hash alone, with no policy id in the prose.
 *
 * These are the reason the by-id list above is not sufficient on its own. A gate that only knew
 * about ids would pass these policies as uncited and cancel them, which is failing open in exactly
 * the way the explicit list was meant to avoid. Each hash is resolved to its policy id onchain
 * below, so the mapping is a fact rather than an inference from the amounts.
 */
const HASH_CITED: Array<{ vault: "v2" | "v3"; txHash: `0x${string}`; where: string }> = [
  {
    vault: "v2",
    txHash: "0x8b219f28d552f2fba5efa276ec0f8d9f5528a417488304474784c61a3b7f707b",
    where: "RESULTS:108  oracle negative, threshold unmet by a healthy live price",
  },
  {
    vault: "v2",
    txHash: "0x624f6928348ec453333aa919c598f76d62ffe77f78d324a0989351586e37aea7",
    where: "RESULTS:109  oracle negative, maxStaleSeconds exceeded",
  },
  {
    vault: "v2",
    txHash: "0x26e1acf092070b3f3731662aeb2c549d0bff50daee3a102ad6cf3826664019ee",
    where: "RESULTS:187  failure path, premature timelock release, reverted with status 0",
  },
];

/** release(uint256) and releasePeriod(uint256) both take the id as the first calldata word. */
function policyIdFromCalldata(input: string): number | undefined {
  // 0x + 8 selector chars, then a 32-byte argument.
  if (!input || input.length < 10 + 64) return undefined;
  try {
    return Number(BigInt(`0x${input.slice(10, 10 + 64)}`));
  } catch {
    return undefined;
  }
}

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
  { type: "function", name: "nextPolicyId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "statusOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint8" }] },
  { type: "function", name: "getPolicy", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }], outputs: [{ type: "tuple", components }] },
] as const;

interface Row {
  vault: "v2" | "v3";
  id: number;
  conditionType: string;
  storedStatus: string;
  effectiveStatus: string;
  funded: bigint;
  recipient: string;
  cited?: string | undefined;
  /** Enough config to tell one Pending policy from another when deciding what to cancel. */
  detail: string;
}

/** A one-line description of what a policy is set up to do, for the Pending detail listing. */
function describe(p: any, conditionType: string): string {
  if (conditionType === "Recurring") {
    return `${(Number(p.amountPerPeriod) / 1e6).toFixed(6)} every ${p.interval}s, ${p.periodsReleased}${p.periods ? `/${p.periods}` : " (open-ended)"} released, nextDue ${new Date(Number(p.nextDue) * 1000).toISOString()}`;
  }
  if (conditionType === "Sweep") {
    return `buffer ${(Number(p.buffer) / 1e6).toFixed(6)}, minSweep ${(Number(p.minSweep) / 1e6).toFixed(6)}, every ${p.interval}s`;
  }
  if (conditionType === "Oracle") {
    const cmp = Number(p.comparator) === 1 ? "<=" : ">=";
    return `USDC/USD ${cmp} ${(Number(p.oracleThreshold) / 1e8).toFixed(4)}, maxStale ${p.maxStaleSeconds}s, amount ${(Number(p.amount) / 1e6).toFixed(6)}`;
  }
  if (conditionType === "Timelock") {
    return `releaseTime ${new Date(Number(p.releaseTime) * 1000).toISOString()}, amount ${(Number(p.amount) / 1e6).toFixed(6)}`;
  }
  if (conditionType === "Approval") {
    return `${p.approvalCount}/${p.threshold} approvals, amount ${(Number(p.amount) / 1e6).toFixed(6)}`;
  }
  if (conditionType === "Attestation") {
    return `attester ${p.attester}, attested ${p.attested}, amount ${(Number(p.amount) / 1e6).toFixed(6)}`;
  }
  return `amount ${(Number(p.amount) / 1e6).toFixed(6)}`;
}

const usdc = (v: bigint) => `${(Number(v) / 1e6).toFixed(6)} USDC`;

async function readVault(
  client: PublicClient,
  vault: "v2" | "v3",
  address: `0x${string}`,
  abi: any,
): Promise<Row[]> {
  const next = (await client.readContract({ address, abi, functionName: "nextPolicyId" })) as bigint;
  const rows: Row[] = [];

  for (let id = 0n; id < next; id++) {
    const [p, effective] = await Promise.all([
      client.readContract({ address, abi, functionName: "getPolicy", args: [id] }) as Promise<any>,
      client.readContract({ address, abi, functionName: "statusOf", args: [id] }) as Promise<number>,
    ]);
    rows.push({
      vault,
      id: Number(id),
      conditionType: p.recurring ? (p.isSweep ? "Sweep" : "Recurring") : (CONDITION[p.conditionType] ?? `#${p.conditionType}`),
      storedStatus: STATUS[p.status] ?? `#${p.status}`,
      effectiveStatus: STATUS[effective] ?? `#${effective}`,
      funded: p.funded as bigint,
      recipient: p.recipient as string,
      cited: CITED.find((c) => c.vault === vault && c.id === Number(id))?.where,
      detail: describe(p, p.recurring ? (p.isSweep ? "Sweep" : "Recurring") : (CONDITION[p.conditionType] ?? "")),
    });
  }
  return rows;
}

async function main(): Promise<void> {
  const rpc = process.env.ARC_TESTNET_RPC_URL;
  if (!rpc) throw new Error("ARC_TESTNET_RPC_URL is not set.");
  const v3 = process.env.POLICY_VAULT_V3_ADDRESS as `0x${string}` | undefined;
  const v2 = process.env.POLICY_VAULT_ADDRESS as `0x${string}` | undefined;

  const arc = chainFor(ARC_DOMAIN);
  const client = createPublicClient({
    chain: { id: arc.chainId, name: arc.name, nativeCurrency: arc.nativeCurrency, rpcUrls: { default: { http: [rpc] } } },
    transport: http(rpc, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 }),
  }) as PublicClient;

  console.log("Covenant v4 migration, step 1: inventory (READ ONLY, no transactions)\n");

  const rows: Row[] = [];
  if (v3) {
    console.log(`v3 ${v3}`);
    rows.push(...(await readVault(client, "v3", v3, abiFor([...BASE, ...RECURRING]))));
  }
  if (v2) {
    console.log(`v2 ${v2}`);
    rows.push(...(await readVault(client, "v2", v2, abiFor(BASE))));
  }

  console.log(`\n${"vault".padEnd(6)}${"id".padEnd(5)}${"condition".padEnd(14)}${"stored".padEnd(11)}${"effective".padEnd(12)}${"funded".padEnd(18)}cited as a proof`);
  console.log("-".repeat(110));
  for (const r of rows) {
    console.log(
      r.vault.padEnd(6) + String(r.id).padEnd(5) + r.conditionType.padEnd(14) +
        r.storedStatus.padEnd(11) + r.effectiveStatus.padEnd(12) + usdc(r.funded).padEnd(18) +
        (r.cited ?? ""),
    );
  }

  /**
   * Resolve the hash-only citations to policy ids, so those policies are recognised as cited too.
   *
   * This is part of the gate, not a report. The by-id list alone once passed v2 policies 8 and 9 as
   * uncited, because RESULTS names those two proofs by transaction hash and never by id; a gate that
   * only reads ids fails open on exactly the proofs most easily lost. An unresolvable citation is
   * therefore fatal: if the gate cannot establish what a proof points at, it cannot certify that
   * cancelling is safe, and it must not guess.
   */
  console.log("\nResolving proofs that RESULTS cites by transaction hash only:");
  const unresolved: string[] = [];
  for (const h of HASH_CITED) {
    try {
      const tx = await client.getTransaction({ hash: h.txHash });
      const id = policyIdFromCalldata(tx.input);
      if (id === undefined) {
        unresolved.push(`${h.txHash} (${h.where}): no policy id in the calldata`);
        console.log(`  ${h.txHash.slice(0, 12)}...  could not decode a policy id from the calldata`);
        continue;
      }
      console.log(`  ${h.txHash.slice(0, 12)}...  ->  ${h.vault} policy ${id}   (${h.where})`);
      const row = rows.find((r) => r.vault === h.vault && r.id === id);
      if (row) row.cited = row.cited ? `${row.cited}; ${h.where}` : h.where;
    } catch (err: any) {
      const why = err?.shortMessage ?? err?.message ?? String(err);
      unresolved.push(`${h.txHash} (${h.where}): ${why}`);
      console.log(`  ${h.txHash.slice(0, 12)}...  LOOKUP FAILED: ${why}`);
    }
  }

  if (unresolved.length) {
    console.log(`\n${"!".repeat(110)}`);
    console.log("STOP. A hash-cited proof could not be resolved to a policy:\n");
    for (const u of unresolved) console.log(`  ${u}`);
    console.log(
      "\nThe gate cannot tell which policies these proofs protect, so it cannot certify that any\n" +
        "cancellation is safe. Resolve the citation before running the migration.",
    );
    process.exitCode = 2;
    return;
  }

  // Cancellable = stored status Pending. cancel() checks the STORED status, not the effective one,
  // so a policy showing Releasable is still Pending underneath and is still in scope.
  const cancellable = rows.filter((r) => r.storedStatus === "Pending");
  const citedAndPending = cancellable.filter((r) => r.cited);
  const refundTotal = cancellable.reduce((sum, r) => sum + r.funded, 0n);

  console.log(`\n${"=".repeat(110)}`);
  console.log(`Policies read:            ${rows.length}`);
  console.log(`Pending (cancel scope):   ${cancellable.length}`);
  console.log(`Refund if all cancelled:  ${usdc(refundTotal)}`);

  console.log("\nEvery Pending policy, in detail. RESULTS cites some negative-path policies only by");
  console.log("transaction hash and not by id, so an uncited row here is NOT proof that nothing points");
  console.log("at it. Read the config before deciding.\n");
  for (const r of cancellable) {
    console.log(`  ${r.vault} policy ${r.id}  ${r.conditionType}  funded ${usdc(r.funded)}${r.cited ? "  [CITED BY ID]" : ""}`);
    console.log(`      ${r.detail}`);
  }

  const missing = CITED.filter((c) => !rows.some((r) => r.vault === c.vault && r.id === c.id));
  if (missing.length) {
    console.log(`\nWARNING: ${missing.length} cited policy(ies) were not found onchain at all:`);
    for (const m of missing) console.log(`  ${m.vault} policy ${m.id}  (${m.where})`);
  }

  if (citedAndPending.length === 0) {
    console.log("\nGATE PASSED: every policy cited in RESULTS.md is Executed or Cancelled.");
    console.log("The cancellation list above cannot damage the proof base.");
    return;
  }

  console.log(`\n${"!".repeat(110)}`);
  console.log(`STOP. ${citedAndPending.length} policy(ies) cited as proofs in RESULTS.md are still Pending:\n`);
  for (const r of citedAndPending) {
    console.log(`  ${r.vault} policy ${r.id}  ${r.conditionType}  funded ${usdc(r.funded)}`);
    console.log(`      cited: ${r.cited}`);
  }
  console.log(
    "\nCancelling these would change the onchain state a published proof points at. That is a\n" +
      "decision about the proof base, not a migration step, so this script stops here rather than\n" +
      "listing them for cancellation.",
  );
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(`\nInventory failed: ${err?.shortMessage ?? err?.message ?? err}`);
  process.exit(1);
});
