/**
 * Collect the v4 migration's hashes and costs from their sources of record, and print a
 * RESULTS-ready block.
 *
 * Nothing here is typed by hand. Deploy hashes and gas come from Foundry's broadcast artifacts; the
 * cancellation hashes are recovered by scanning the vaults for PolicyCancelled events, because those
 * went through Circle and never produced a broadcast file. That is the point: a hash reaches
 * RESULTS.md by being read from a receipt or a chain query, never by being copied out of a terminal
 * or a message. See DECISIONS D14.
 *
 *   node scripts/collect-v4-proof.mjs
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHAIN_ID = 5042002;

function loadEnv() {
  try {
    for (const line of readFileSync(join(root, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
}
loadEnv();

const rpc = process.env.ARC_TESTNET_RPC_URL;
if (!rpc) throw new Error("ARC_TESTNET_RPC_URL is not set.");

async function rpcCall(method, params) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/**
 * Deployments from every Foundry broadcast of a script, with the gas actually paid.
 *
 * All runs, not just run-latest.json: one script file can define several deploy contracts, and each
 * invocation overwrites run-latest. Reading only the newest silently drops everything deployed by an
 * earlier invocation, which is how the PythAdapter went missing from the first collection.
 */
function fromBroadcast(scriptName) {
  const dir = join(root, "contracts", "broadcast", scriptName, String(CHAIN_ID));
  if (!existsSync(dir)) return [];

  const runs = readdirSync(dir)
    .filter((f) => f.startsWith("run-") && f.endsWith(".json") && f !== "run-latest.json")
    .map((f) => join(dir, f));

  const seen = new Set();
  const out = [];
  for (const path of runs) {
    for (const d of deploysIn(JSON.parse(readFileSync(path, "utf8")))) {
      if (seen.has(d.address)) continue;
      seen.add(d.address);
      out.push(d);
    }
  }
  return out;
}

function deploysIn(run) {
  return run.transactions
    .filter((t) => t.transactionType === "CREATE")
    .map((t, i) => {
      const receipt = run.receipts?.[i];
      const gasUsed = receipt ? BigInt(receipt.gasUsed) : 0n;
      const gasPrice = receipt ? BigInt(receipt.effectiveGasPrice ?? "0x0") : 0n;
      return {
        contract: t.contractName,
        address: t.contractAddress,
        txHash: t.hash,
        gasUsed,
        // Arc's native token is USDC at 18 decimals, so cost in dollars is wei / 1e18.
        costUsdc: Number(gasUsed * gasPrice) / 1e18,
      };
    });
}

/**
 * Recover cancellation transactions by scanning for PolicyCancelled.
 *
 * The topic is computed rather than hardcoded, because a hardcoded event topic is the same class of
 * hand-typed constant the never-type-a-hash rule exists to stop.
 */
async function findCancellations(vaultLabel, address, fromBlock) {
  if (!address) return [];
  const topic = await keccakTopic("PolicyCancelled(uint256,address,uint256)");
  const latest = BigInt(await rpcCall("eth_blockNumber", []));

  const found = [];
  const SPAN = 9_000n; // Arc caps getLogs at 10,000 blocks
  for (let from = fromBlock; from <= latest; from += SPAN) {
    const to = from + SPAN - 1n > latest ? latest : from + SPAN - 1n;
    const logs = await rpcCall("eth_getLogs", [{
      address,
      topics: [topic],
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
    }]);
    for (const log of logs) {
      found.push({
        vault: vaultLabel,
        policyId: Number(BigInt(log.topics[1])),
        txHash: log.transactionHash,
        blockNumber: Number(BigInt(log.blockNumber)),
        refunded: Number(BigInt(log.data.slice(0, 66))) / 1e6,
      });
    }
  }
  return found;
}

/** Event topic, derived via the node's own keccak rather than written down. */
async function keccakTopic(signature) {
  const { keccak256, toHex } = await import("viem");
  return keccak256(toHex(signature));
}

const deploys = [...fromBroadcast("DeployPolicyVault.s.sol"), ...fromBroadcast("DeployV4.s.sol")];

console.log("v4 deployments, from the Foundry broadcast artifacts\n");
for (const d of deploys) {
  console.log(`  ${d.contract}`);
  console.log(`      address ${d.address}`);
  console.log(`      tx      ${d.txHash}`);
  console.log(`      gas     ${d.gasUsed}  cost ${d.costUsdc.toFixed(6)} USDC`);
}

// Only scan from a little before the migration, so the recent cancellations are found cheaply.
const latest = BigInt(await rpcCall("eth_blockNumber", []));
const scanFrom = latest > 60_000n ? latest - 60_000n : 0n;

const cancellations = [
  ...(await findCancellations("v2", process.env.POLICY_VAULT_ADDRESS, scanFrom)),
  ...(await findCancellations("v3", process.env.POLICY_VAULT_V3_ADDRESS, scanFrom)),
];

console.log("\nCancellations, recovered from PolicyCancelled logs onchain\n");
for (const c of cancellations) {
  console.log(`  ${c.vault} policy ${c.policyId}  refunded ${c.refunded.toFixed(6)} USDC`);
  console.log(`      tx    ${c.txHash}`);
  console.log(`      block ${c.blockNumber}`);
}

console.log("\n--- RESULTS.md block ---\n");
console.log("| Contract | Address | Deploy tx | Cost |");
console.log("| --- | --- | --- | --- |");
for (const d of deploys) {
  console.log(
    `| ${d.contract} | [\`${d.address}\`](https://testnet.arcscan.app/address/${d.address}) | ` +
      `[\`${d.txHash.slice(0, 10)}…\`](https://testnet.arcscan.app/tx/${d.txHash}) | ${d.costUsdc.toFixed(6)} USDC |`,
  );
}
console.log("\n| Cancelled | Refunded | Tx |");
console.log("| --- | --- | --- |");
for (const c of cancellations) {
  console.log(
    `| ${c.vault} policy ${c.policyId} | ${c.refunded.toFixed(6)} USDC | ` +
      `[\`${c.txHash.slice(0, 10)}…\`](https://testnet.arcscan.app/tx/${c.txHash}) |`,
  );
}
