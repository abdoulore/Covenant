/**
 * Real wiring for the v5 monitor: the live vault, Postgres for its memory, Telegram (or the log) for
 * alerts, and Circle's attestation API for cross-chain mints. Sandbox API on testnet, production on
 * mainnet, chosen by the chain the RPC reports rather than by a setting that could disagree with it.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { chainFor, ARC_DOMAIN } from "../config.js";
import { notifierFromEnv } from "../alerts/Notifier.js";
import { V5Reader } from "./V5Reader.js";
import { V5Monitor } from "./V5Monitor.js";
import { irisForwardStatus, PostgresMonitorStore } from "./PostgresMonitorStore.js";

const ARC_MAINNET = 5042;

export interface V5MonitorEnv {
  rpcUrl: string;
  logsRpcUrl?: string | undefined;
  vault: `0x${string}`;
  vaultLabel: string;
  deployBlock: bigint;
  databaseUrl: string;
  log?: (message: string) => void;
}

export async function v5MonitorFromEnv(opts: V5MonitorEnv) {
  const log = opts.log ?? ((m: string) => console.log(m));
  const client = createPublicClient({ transport: http(opts.rpcUrl, { retryCount: 3, retryDelay: 1_500, timeout: 30_000 }) }) as PublicClient;
  const logsClient = opts.logsRpcUrl
    ? (createPublicClient({ transport: http(opts.logsRpcUrl, { retryCount: 3, retryDelay: 2_000, timeout: 30_000 }) }) as PublicClient)
    : client;
  const chainId = await client.getChainId();
  const irisBase = chainId === ARC_MAINNET ? "https://iris-api.circle.com" : "https://iris-api-sandbox.circle.com";
  const store = new PostgresMonitorStore(opts.databaseUrl);
  await store.migrate();
  const reader = new V5Reader(client, opts.vault);
  const notifier = notifierFromEnv(process.env, log);
  const monitor = new V5Monitor({
    vaultLabel: opts.vaultLabel,
    store,
    notifier,
    txUrl: (h) => chainFor(ARC_DOMAIN).explorerTxUrl(h),
    forwardStatus: irisForwardStatus(irisBase),
    log,
  });

  return {
    describe: `alerts to ${notifier.describe}, Circle API ${irisBase}`,
    async runOnce() {
      const now = Math.floor(Date.now() / 1000);
      const recorded = await store.scanReleases(logsClient, opts.vault, opts.vaultLabel, opts.deployBlock, now);
      const r = await monitor.runOnce(await reader.pending(), now);
      return { ...r, crossChainRecorded: recorded };
    },
    end: () => store.end(),
  };
}
