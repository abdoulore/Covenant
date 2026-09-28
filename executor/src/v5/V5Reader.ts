/**
 * Reads a self-custody (v5) vault's live policies for the releaser and the monitor.
 *
 * Executed and cancelled policies never change again, so once seen they are remembered and not
 * read again: a vault's history grows forever, and re-reading all of it every few seconds would
 * cost an RPC call per dead policy per pass.
 */
import type { PublicClient } from "viem";
import { V5_ABI, V5_STATUS_CODE } from "../chain/policyVaultV5.js";

export interface V5Policy {
  id: bigint;
  owner: string;
  recipient: string;
  amount: bigint;
  funded: bigint;
  feeAllowance: bigint;
  maxFeePerTransfer: bigint;
  destinationDomain: number;
  conditionType: number;
  status: number;
  recurring: boolean;
  isSweep: boolean;
  nextDue: bigint;
  stoppedAt: bigint;
  adapter: string;
  feedId: string;
  /** statusOf(): Releasable when a release would succeed now (pull oracles excepted). */
  effectiveStatus: number;
  /** The deadline moved out by any pause. Unix seconds. */
  effectiveDeadline: bigint;
}

export interface V5ReaderLike {
  pending(): Promise<V5Policy[]>;
  paused(): Promise<boolean>;
}

export class V5Reader implements V5ReaderLike {
  private readonly terminal = new Set<bigint>();

  constructor(
    private readonly client: PublicClient,
    readonly vault: `0x${string}`,
    private readonly concurrency = 6,
  ) {}

  async paused(): Promise<boolean> {
    return (await this.client.readContract({ address: this.vault, abi: V5_ABI, functionName: "paused" })) as boolean;
  }

  /** Every policy still Pending, with its live status and effective deadline. */
  async pending(): Promise<V5Policy[]> {
    const next = (await this.client.readContract({ address: this.vault, abi: V5_ABI, functionName: "nextPolicyId" })) as bigint;
    const ids: bigint[] = [];
    for (let i = 0n; i < next; i++) if (!this.terminal.has(i)) ids.push(i);

    const out: V5Policy[] = [];
    for (let i = 0; i < ids.length; i += this.concurrency) {
      const batch = await Promise.all(ids.slice(i, i + this.concurrency).map((id) => this.read(id)));
      for (const p of batch) if (p) out.push(p);
    }
    return out;
  }

  private async read(id: bigint): Promise<V5Policy | undefined> {
    const [p, effectiveStatus, effectiveDeadline] = await Promise.all([
      this.client.readContract({ address: this.vault, abi: V5_ABI, functionName: "getPolicy", args: [id] }) as Promise<any>,
      this.client.readContract({ address: this.vault, abi: V5_ABI, functionName: "statusOf", args: [id] }) as Promise<number>,
      this.client.readContract({ address: this.vault, abi: V5_ABI, functionName: "effectiveDeadline", args: [id] }) as Promise<bigint>,
    ]);
    if (p.status === V5_STATUS_CODE.Executed || p.status === V5_STATUS_CODE.Cancelled) {
      this.terminal.add(id);
      return undefined;
    }
    return {
      id, owner: p.owner, recipient: p.recipient, amount: p.amount, funded: p.funded,
      feeAllowance: p.feeAllowance, maxFeePerTransfer: p.maxFeePerTransfer,
      destinationDomain: Number(p.destinationDomain), conditionType: Number(p.conditionType), status: Number(p.status),
      recurring: p.recurring, isSweep: p.isSweep, nextDue: p.nextDue, stoppedAt: p.stoppedAt,
      adapter: p.adapter, feedId: p.feedId,
      effectiveStatus: Number(effectiveStatus), effectiveDeadline,
    };
  }
}
