/**
 * Create the developer-controlled wallets this project needs, idempotently.
 *
 *   node --env-file=.env executor/scripts/create-wallets.mjs          # dry run, shows the plan
 *   node --env-file=.env executor/scripts/create-wallets.mjs --write  # create, then update .env
 *
 * Idempotency is by refId. Re-running never creates a second wallet for the same role, which
 * matters because this Circle account already contains unrelated wallets from another project.
 * Nothing outside this project's wallet set is read or modified.
 *
 * Five wallets, not three. DECISIONS.md D1 makes bridge and payout separate legs for the
 * cross-chain archetype, so the executor needs a wallet on the destination chain to receive the
 * bridged USDC before paying it onward.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

/**
 * One wallet set per chain, deliberately.
 *
 * Circle derives addresses within a wallet set by index, and the index restarts per blockchain.
 * Creating Arc and Base wallets in a single set therefore hands the first Base wallet the same
 * address as the first Arc wallet. That still settles correctly, since balances on the two chains
 * are independent, but it makes the audit trail unreadable: the recipient address on Base ends up
 * identical to the executor address on Arc, so the final payout looks like a transfer back to the
 * executor. Separate sets have independent key material and keep every role visually distinct.
 */
const WALLET_SETS = {
  "ARC-TESTNET": "covenant-canary",
  "BASE-SEPOLIA": "covenant-canary-base",
};

/** refId is the idempotency key, scoped to its wallet set. Never reuse one for a different role. */
const WALLETS = [
  { refId: "covenant:treasury:arc", role: "treasury", blockchain: "ARC-TESTNET", envPrefix: "TREASURY" },
  { refId: "covenant:executor:arc", role: "executor", blockchain: "ARC-TESTNET", envPrefix: "EXECUTOR" },
  { refId: "covenant:recipient:arc", role: "recipient", blockchain: "ARC-TESTNET", envPrefix: "RECIPIENT" },
  { refId: "covenant:executor:base", role: "executor", blockchain: "BASE-SEPOLIA", envPrefix: "EXECUTOR_DEST" },
  { refId: "covenant:recipient:base", role: "recipient", blockchain: "BASE-SEPOLIA", envPrefix: "RECIPIENT_DEST" },
];

const write = process.argv.includes("--write");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Copy .env.example to .env and fill it.`);
  return v;
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey: requireEnv("CIRCLE_API_KEY"),
  entitySecret: requireEnv("CIRCLE_ENTITY_SECRET"),
});

async function findOrCreateWalletSet(name) {
  const existing = await client.listWalletSets({});
  const found = (existing.data?.walletSets ?? []).find((s) => s.name === name);
  if (found) {
    console.log(`wallet set: reusing ${found.id} (${name})`);
    return found.id;
  }
  if (!write) {
    console.log(`wallet set: would create "${name}"`);
    return null;
  }
  const created = await client.createWalletSet({ name });
  const id = created.data?.walletSet?.id;
  console.log(`wallet set: created ${id} (${name})`);
  return id;
}

async function main() {
  /** walletSetId and the refIds already present in it, per chain. */
  const sets = {};
  for (const [blockchain, setName] of Object.entries(WALLET_SETS)) {
    const walletSetId = await findOrCreateWalletSet(setName);
    const listed = walletSetId ? await client.listWallets({ walletSetId }) : { data: { wallets: [] } };
    const wallets = listed.data?.wallets ?? [];
    sets[blockchain] = {
      walletSetId,
      byRefId: new Map(wallets.filter((w) => w.refId).map((w) => [w.refId, w])),
    };
  }

  const results = [];
  for (const spec of WALLETS) {
    const { walletSetId, byRefId } = sets[spec.blockchain];
    const found = byRefId.get(spec.refId);
    if (found) {
      console.log(`  ${spec.refId.padEnd(28)} exists   ${found.address}`);
      results.push({ ...spec, id: found.id, address: found.address });
      continue;
    }
    if (!write) {
      console.log(`  ${spec.refId.padEnd(28)} would create on ${spec.blockchain}`);
      continue;
    }
    const created = await client.createWallets({
      walletSetId,
      blockchains: [spec.blockchain],
      count: 1,
      metadata: [{ name: `covenant-${spec.role}-${spec.blockchain.toLowerCase()}`, refId: spec.refId }],
    });
    const wallet = created.data?.wallets?.[0];
    if (!wallet) throw new Error(`createWallets returned no wallet for ${spec.refId}`);
    console.log(`  ${spec.refId.padEnd(28)} created  ${wallet.address}`);
    results.push({ ...spec, id: wallet.id, address: wallet.address });
  }

  if (!write) {
    console.log("\nDry run. Nothing was created. Re-run with --write to apply.");
    return;
  }

  updateEnvFile(results);

  console.log("\nFund these from https://faucet.circle.com (Arc Testnet), see VERIFICATIONS.md V6:");
  for (const r of results.filter((r) => r.blockchain === "ARC-TESTNET")) {
    console.log(`  ${r.role.padEnd(10)} ${r.address}`);
  }
  console.log("\nTreasury needs USDC to deposit. Executor needs USDC for gas, which on Arc is USDC.");
}

/** Rewrite only the keys we own. Never reorders or drops anything else in the file. */
function updateEnvFile(results) {
  const path = ".env";
  let content = readFileSync(path, "utf8");

  for (const r of results) {
    for (const [suffix, value] of [["WALLET_ID", r.id], ["WALLET_ADDRESS", r.address]]) {
      const key = `${r.envPrefix}_${suffix}`;
      const line = `${key}=${value}`;
      const re = new RegExp(`^${key}=.*$`, "m");
      content = re.test(content) ? content.replace(re, line) : `${content.trimEnd()}\n${line}\n`;
    }
  }

  writeFileSync(path, content);
  console.log(`\nUpdated ${path} with ${results.length * 2} values.`);
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  if (err?.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
