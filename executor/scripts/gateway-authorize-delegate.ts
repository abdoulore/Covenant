/**
 * One-time Gateway setup: generate a DEDICATED delegate key and authorize it on the source
 * GatewayWallet. The delegate can sign spends of the entire unified balance, so it must be its own
 * key, never the deployer (DECISIONS D11, key-authority map). The key is written to .env and never
 * printed. After this, the delegate needs ~10 to 15 minutes of Base Sepolia hard finality (V23)
 * before the Gateway API will honor its spends.
 *
 *   npm run gateway:authorize
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { GATEWAY_WALLET } from "../src/gateway/addresses.js";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const env = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set.`);
  return v;
};

const BASE_USDC = env("BASE_SEPOLIA_USDC_ADDRESS");
const DEPOSITOR_WALLET_ID = env("GATEWAY_DEPOSITOR_WALLET_ID");

const circle = initiateDeveloperControlledWalletsClient({ apiKey: env("CIRCLE_API_KEY"), entitySecret: env("CIRCLE_ENTITY_SECRET") });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL_OK = new Set(["COMPLETE", "CONFIRMED"]);

async function send(walletId: string, contractAddress: string, signature: string, params: unknown[]) {
  const created = await circle.createContractExecutionTransaction({
    walletId, contractAddress, abiFunctionSignature: signature, abiParameters: params,
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
    await sleep(2_500);
  }
}

async function main() {
  let pk = process.env.DELEGATE_PRIVATE_KEY;
  if (!pk) {
    pk = generatePrivateKey();
    await appendFile(resolve(process.cwd(), "../.env"), `\n# Dedicated Gateway spend delegate. Can spend the whole unified balance. Never the deployer (D11).\nDELEGATE_PRIVATE_KEY=${pk}\n`);
    console.log("generated a dedicated delegate key and wrote it to .env (not printed here)");
  } else {
    console.log("reusing existing DELEGATE_PRIVATE_KEY from .env");
  }
  const delegate = privateKeyToAccount(pk as `0x${string}`);
  console.log(`delegate address: ${delegate.address}`);

  console.log("authorizing the dedicated delegate on the source GatewayWallet...");
  const tx = await send(DEPOSITOR_WALLET_ID, GATEWAY_WALLET, "addDelegate(address,address)", [BASE_USDC, delegate.address]);
  console.log(`addDelegate ${tx}`);
  console.log("\nDelegate authorized. It needs ~10 to 15 min of Base Sepolia hard finality before it can spend (V23).");
  console.log("Record DELEGATE_ADDRESS for the key-authority map. The deployer stays a delegate until removed separately.");
}

main().catch((err) => { console.error("\nDELEGATE AUTHORIZE FAILED:", err?.message ?? err); process.exit(1); });
