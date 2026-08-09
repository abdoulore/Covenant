/**
 * Row 8: the fail-closed fix, proven onchain against both the defective and the fixed vault.
 *
 * The defect that forced v4: the Oracle condition computed `block.timestamp - updatedAt` outside the
 * try that catches a misbehaving feed, so a feed answer dated ahead of the block underflowed and
 * reverted the read instead of returning false.
 *
 * Pyth cannot be asked to publish a future timestamp on demand, so the feed is a synthetic
 * FutureDatedAggregator deployed to Arc: a valid, positive, complete answer whose only unusual
 * property is that it is dated ahead. The VAULTS are the real deployed ones. What is being proven is
 * the vault's guard, not the price's meaning.
 *
 * checkCondition is a view and produces no hash, so ConditionProbe calls it and emits the result,
 * making the read observable as a transaction. That is what turns "returns false instead of
 * reverting" from an assertion into a pair of hashes.
 *
 * BOTH transactions fail with status 0 on the defective vault and one succeeds on the fixed one, so
 * the decoded reason is the evidence, not the revert. Every hash below is recorded with its reason.
 *
 *   npm run demo:fail-closed
 */
import { createPublicClient, createWalletClient, decodeErrorResult, fallback, http, parseAbi, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRequire } from "node:module";
import { chainFor, ARC_DOMAIN } from "../src/config.js";
import { currentVaultAddress, vaultAddress } from "../src/api/vaults.js";
import { CircleWalletProvider } from "../src/wallet/CircleWalletProvider.js";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const TERMINAL_OK = new Set(["COMPLETE", "CONFIRMED"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const probeAbi = parseAbi([
  "function probe(address vault, uint256 policyId) returns (bool met)",
  "event Probed(address indexed vault, uint256 indexed policyId, bool met)",
]);
const vaultAbi = parseAbi([
  "function nextPolicyId() view returns (uint256)",
  "function release(uint256)",
]);

/** The vault's custom errors, so a revert decodes to a name rather than "unknown reason". */
const vaultErrorsAbi = parseAbi([
  "error ConditionNotMet(uint256 policyId)",
  "error Underfunded(uint256 policyId, uint256 funded, uint256 required)",
  "error PolicyNotPending(uint256 policyId, uint8 status)",
  "error UnknownPolicy(uint256 policyId)",
  "error UseReleasePeriod(uint256 policyId)",
  "error UseReleaseWithProof(uint256 policyId)",
  "error ConfidenceTooWide(uint256 policyId, uint256 conf, uint256 value, uint16 maxConfBps)",
  "error CatchUpStale(uint256 policyId, uint64 nextDue)",
  "error SweepBelowMin(uint256 policyId, uint256 slice, uint256 minSweep)",
  "error PeriodNotDue(uint256 policyId, uint64 nextDue, uint256 nowTs)",
  "error NotAnApprover(uint256 policyId, address caller)",
  "error InsufficientFee(uint256 required, uint256 sent)",
]);

const need = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set.`);
  return v;
};

const started = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

interface Outcome {
  vault: string;
  label: string;
  action: string;
  txHash: string;
  status: string;
  reason: string;
}

async function main(): Promise<void> {
  const arc = chainFor(ARC_DOMAIN);
  const rpc = need("ARC_TESTNET_RPC_URL");
  const chain = { id: arc.chainId, name: arc.name, nativeCurrency: arc.nativeCurrency, rpcUrls: { default: { http: [rpc] } } };
  const transport = fallback(
    [rpc, process.env.ARC_TESTNET_RPC_FALLBACK_URL].filter(Boolean)
      .map((u) => http(u as string, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 })),
  );
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const account = privateKeyToAccount(need("DEPLOYER_PRIVATE_KEY") as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport });

  const V4 = currentVaultAddress();
  const V3 = vaultAddress("v3");
  if (!V3) throw new Error("POLICY_VAULT_V3_ADDRESS is not set; the comparison needs the defective vault.");
  const FEED = need("ARC_FUTURE_DATED_FEED") as `0x${string}`;
  const PROBE = need("ARC_CONDITION_PROBE") as `0x${string}`;
  const RECIPIENT = need("RECIPIENT_WALLET_ADDRESS") as `0x${string}`;

  console.log(`defective vault  ${V3}  (v3)`);
  console.log(`fixed vault      ${V4}  (v4)`);
  console.log(`synthetic feed   ${FEED}  (valid answer, dated 300s ahead of each block)`);
  console.log(`probe            ${PROBE}\n`);

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

  /**
   * Create the same unfunded Oracle policy on a vault, pointing at the future-dated feed.
   *
   * Deliberately unfunded: the policy exists only to be read. It can never release on either vault
   * whatever the condition says, so creating one on the superseded v3 adds a policy that cannot move
   * money. This is the one write made to v3 after it went read-only, and it is made to produce the
   * comparison rather than to operate the vault.
   */
  async function createProbePolicy(vaultAddr: string, label: string): Promise<bigint> {
    const hash = await ownerSend(
      vaultAddr,
      "createOraclePolicy(address,uint256,uint8,uint32,address,uint8,int256,uint64)",
      [RECIPIENT, "100000", 0, ARC_DOMAIN, FEED, 0, "99500000", "60"],
    );
    const id = (await publicClient.readContract({
      address: vaultAddr as `0x${string}`, abi: vaultAbi, functionName: "nextPolicyId",
    })) as bigint - 1n;
    log(`${label}: created unfunded oracle policy ${id} pointing at the future-dated feed, ${hash}`);
    return id;
  }

  /**
   * Decode why a transaction failed.
   *
   * On this row both vaults produce a status-0 failure, so "reverted" alone would say nothing and
   * would read as if the two behaved identically. The custom-error ABI is supplied explicitly
   * because without it viem reports "execution reverted for an unknown reason" for a custom error,
   * which is exactly the uninformative answer this row exists to avoid.
   */
  async function reasonFor(txHash: `0x${string}`): Promise<string> {
    try {
      const tx = await publicClient.getTransaction({ hash: txHash });
      // value MUST be forwarded. Replaying a payable call without it makes every such transaction
      // look like it failed the fee check, which reports a reason the original never had: the
      // confidence-guard proof first decoded as InsufficientFee(1, 0) purely because of this.
      await publicClient.call({
        to: tx.to!, data: tx.input, account: tx.from, value: tx.value, blockNumber: tx.blockNumber,
      });
      return "no revert reason (call succeeded on replay)";
    } catch (err: any) {
      // Walk the error chain for raw revert data, then decode it against the vault's errors.
      let data: string | undefined;
      for (let e: any = err; e; e = e.cause) {
        if (typeof e?.data === "string" && e.data.startsWith("0x")) { data = e.data; break; }
        if (typeof e?.raw === "string" && e.raw.startsWith("0x")) { data = e.raw; break; }
      }

      if (data && data !== "0x") {
        // Solidity's Panic(uint256): 0x4e487b71 followed by the code.
        if (data.startsWith("0x4e487b71")) {
          const code = BigInt(`0x${data.slice(10)}`);
          return code === 0x11n ? "Panic(0x11) arithmetic underflow" : `Panic(0x${code.toString(16)})`;
        }
        try {
          const decoded = decodeErrorResult({ abi: vaultErrorsAbi, data: data as `0x${string}` });
          const args = decoded.args?.length ? `(${decoded.args.join(", ")})` : "";
          return `${decoded.errorName}${args}`;
        } catch {
          return `custom error ${data.slice(0, 10)}`;
        }
      }

      const short = err?.shortMessage ?? err?.message ?? String(err);
      if (/panic|underflow|overflow/i.test(short)) return "Panic(0x11) arithmetic underflow";
      return short.split("\n")[0];
    }
  }

  const outcomes: Outcome[] = [];

  /**
   * Re-decode hashes from a previous run instead of creating fresh policies.
   *
   *   npm run demo:fail-closed -- --decode <hash> <hash> ...
   *
   * Exists because the first run produced valid hashes but an undecoded reason, and re-running the
   * whole demo to fix the decoding would mean a second write to a vault documented as read-only.
   * The transactions are already onchain; only the reading of them was wrong.
   */
  const decodeIdx = process.argv.indexOf("--decode");
  if (decodeIdx !== -1) {
    for (const h of process.argv.slice(decodeIdx + 1)) {
      const receipt = await publicClient.getTransactionReceipt({ hash: h as `0x${string}` });
      const reason = receipt.status === "success" ? "succeeded" : await reasonFor(h as `0x${string}`);
      console.log(`${h}  ${receipt.status.padEnd(9)} ${reason}`);
    }
    return;
  }

  for (const [label, vaultAddr] of [["v3 (defective)", V3], ["v4 (fixed)", V4]] as const) {
    const policyId = await createProbePolicy(vaultAddr, label);

    // --- the probe: does reading the condition work at all? ---
    let probeHash: `0x${string}`;
    try {
      probeHash = await wallet.writeContract({
        address: PROBE, abi: probeAbi, functionName: "probe",
        args: [vaultAddr as `0x${string}`, policyId], account, chain,
        gas: 400_000n, // skip estimation, which would refuse to submit a reverting call
      });
    } catch (err: any) {
      log(`${label}: probe could not be broadcast: ${err?.shortMessage ?? err?.message}`);
      continue;
    }
    const probeReceipt = await publicClient.waitForTransactionReceipt({ hash: probeHash });
    const probeOk = probeReceipt.status === "success";
    const probeReason = probeOk
      ? `succeeded, emitted Probed(met=false)`
      : await reasonFor(probeHash);

    log(`${label}: probe ${probeOk ? "SUCCEEDED" : "REVERTED"} in ${probeHash}  (${probeReason})`);
    outcomes.push({
      vault: label, label, action: "probe checkCondition", txHash: probeHash,
      status: probeOk ? "success" : "reverted", reason: probeReason,
    });

    // --- the release attempt: refused on both, but for different reasons ---
    let releaseHash: `0x${string}`;
    try {
      releaseHash = await wallet.writeContract({
        address: vaultAddr as `0x${string}`, abi: vaultAbi, functionName: "release",
        args: [policyId], account, chain, gas: 400_000n,
      });
    } catch (err: any) {
      log(`${label}: release could not be broadcast: ${err?.shortMessage ?? err?.message}`);
      continue;
    }
    const releaseReceipt = await publicClient.waitForTransactionReceipt({ hash: releaseHash });
    const releaseReason = releaseReceipt.status === "success" ? "SUCCEEDED, which it must not" : await reasonFor(releaseHash);
    log(`${label}: release reverted in ${releaseHash}  (${releaseReason})`);
    outcomes.push({
      vault: label, label, action: "release attempt", txHash: releaseHash,
      status: releaseReceipt.status, reason: releaseReason,
    });
  }

  console.log("\n=== result ===\n");
  console.log("Identical input, identical synthetic feed. The status is the same; the reason is not.\n");
  for (const o of outcomes) {
    console.log(`  ${o.label.padEnd(16)} ${o.action.padEnd(22)} ${o.status.padEnd(9)} ${o.reason}`);
  }

  console.log("\n--- markdown for RESULTS.md ---\n");
  console.log("| Vault | Action | Status | Decoded reason | Tx |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const o of outcomes) {
    console.log(
      `| ${o.label} | ${o.action} | ${o.status} | \`${o.reason}\` | ` +
        `[\`${o.txHash.slice(0, 10)}…\`](https://testnet.arcscan.app/tx/${o.txHash}) |`,
    );
  }
}

main().catch((err) => {
  console.error(`\nfailed: ${err?.shortMessage ?? err?.message ?? err}`);
  process.exit(1);
});
