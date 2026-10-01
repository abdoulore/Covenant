/**
 * The v5 vault, read straight from the chain: no Covenant server in between.
 *
 * Used by the mainnet build (agreed with Ore, 2026-10-01). Reads go to Arc's public RPCs, falling
 * through every one Arc lists, so the list shows before anyone connects; with a wallet connected on
 * Arc, the wallet's own connection is the last resort, which a browser's privacy shield does not
 * block (Brave blocked the public RPC on the first live load). Reads are batched through Multicall3,
 * so a page of policies costs a couple of requests, not hundreds.
 *
 * The shape matches what the API's read model returns for a v5 policy (executor/src/api/readModel.ts,
 * readV5Policy), so the same screens render either source.
 */
import { createPublicClient, custom, fallback, http, type EIP1193Provider, type PublicClient } from "viem";
import type { Policy } from "../api";
import { ARC, READ_RPCS } from "./chain";
import { VAULT_ABI } from "./vault";

const CONDITION = ["Timelock", "Approval", "Attestation", "Oracle", "Schedule", "OraclePull"];
const STATUS = ["Pending", "Releasable", "Executed", "Cancelled"];
const COMPARATOR = ["Gte", "Lte"];

/** How many of the newest policies to read. Ample for a beta capped at a small total. */
const PAGE = 100;

const rpc = (wallet?: EIP1193Provider) =>
  createPublicClient({
    chain: ARC,
    transport: fallback([
      ...READ_RPCS.map((url) => http(url, { retryCount: 1, retryDelay: 500, timeout: 15_000 })),
      ...(wallet ? [custom(wallet)] : []),
    ]),
    batch: { multicall: true },
  }) as PublicClient;

export interface VaultView {
  policies: Policy[];
  fundsCap: bigint;
  totalHeld: bigint;
  paused: boolean;
  readAt: number;
}

/** `wallet`: the connected wallet's provider, only when it is on Arc; the last of the read paths. */
export async function readVault(vault: `0x${string}`, label: string, wallet?: EIP1193Provider): Promise<VaultView> {
  const c = rpc(wallet);
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    c.readContract({ address: vault, abi: VAULT_ABI, functionName, args } as never) as Promise<T>;

  const [next, fundsCap, totalHeld, paused] = await Promise.all([
    read<bigint>("nextPolicyId"), read<bigint>("fundsCap"), read<bigint>("totalHeld"), read<boolean>("paused"),
  ]);
  const first = next > BigInt(PAGE) ? next - BigInt(PAGE) : 0n;
  const ids: bigint[] = [];
  for (let id = next - 1n; id >= first; id--) ids.push(id);

  // Newest first. With batch.multicall on, these calls leave as one Multicall3 request per batch.
  const policies = await Promise.all(ids.map(async (id): Promise<Policy> => {
    const [p, status, effectiveDeadline] = await Promise.all([
      read<any>("getPolicy", [id]), read<number>("statusOf", [id]), read<bigint>("effectiveDeadline", [id]),
    ]);
    return {
      vault: label, address: vault, id: id.toString(),
      writable: false, selfCustody: true,
      owner: p.owner, recipient: p.recipient, amount: p.amount.toString(), funded: p.funded.toString(),
      feeAllowance: p.feeAllowance.toString(), maxFeePerTransfer: p.maxFeePerTransfer.toString(),
      payoutCurrency: "USDC", destinationDomain: Number(p.destinationDomain),
      conditionType: p.recurring ? (p.isSweep ? "Sweep" : "Recurring") : CONDITION[p.conditionType] ?? "Unknown",
      status: STATUS[p.status] ?? "Unknown", effectiveStatus: STATUS[status] ?? "Unknown",
      deadline: p.deadline.toString(), effectiveDeadline: effectiveDeadline.toString(),
      releaseTime: p.releaseTime.toString(), threshold: Number(p.threshold), approvalCount: Number(p.approvalCount),
      attester: p.attester, attested: p.attested,
      feed: p.feed, comparator: COMPARATOR[p.comparator], oracleThreshold: p.oracleThreshold.toString(),
      maxStaleSeconds: p.maxStaleSeconds.toString(),
      adapter: p.adapter, feedId: p.feedId, maxConfBps: Number(p.maxConfBps),
      recurring: p.recurring, isSweep: p.isSweep,
      amountPerPeriod: p.amountPerPeriod.toString(), buffer: p.buffer.toString(), minSweep: p.minSweep.toString(),
      interval: p.interval.toString(), nextDue: p.nextDue.toString(), stoppedAt: p.stoppedAt.toString(),
      periods: Number(p.periods), periodsReleased: Number(p.periodsReleased),
    };
  }));

  return { policies, fundsCap, totalHeld, paused, readAt: Date.now() };
}
