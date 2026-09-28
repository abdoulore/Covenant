/**
 * The v5 monitor's memory, in the same Postgres as the settlement store and the release ledger.
 * Pooler-safe in the same way: schema-qualified tables, no session state, one statement per call.
 */
import pg from "pg";
import { decodeEventLog, type PublicClient } from "viem";
import { pgConnectionString, qualified } from "../store/PostgresSettlementStore.js";
import { classifyLogsError } from "../chain/EventWatcher.js";
import { V5_ABI } from "../chain/policyVaultV5.js";
import type { CrossChainRelease, MonitorStore, ProblemKind } from "./V5Monitor.js";

const ARC_DOMAIN = 26;
const RELEASED = V5_ABI.find((e) => e.type === "event" && e.name === "PolicyReleased")!;

export class PostgresMonitorStore implements MonitorStore {
  private readonly pool: pg.Pool;
  private readonly t: { releasable: string; crosschain: string; alerts: string; cursor: string };
  private ready: Promise<void> | undefined;

  constructor(connectionString: string, private readonly schema = "public") {
    this.pool = new pg.Pool({ connectionString: pgConnectionString(connectionString), max: 2, idleTimeoutMillis: 30_000 });
    this.t = {
      releasable: qualified(schema, "v5_releasable"),
      crosschain: qualified(schema, "v5_crosschain"),
      alerts: qualified(schema, "v5_alerts"),
      cursor: qualified(schema, "v5_cursor"),
    };
  }

  migrate(): Promise<void> {
    this.ready ??= (async () => {
      const q = (sql: string) => this.pool.query(sql);
      if (this.schema !== "public") await q(`create schema if not exists "${this.schema}"`);
      await q(`create table if not exists ${this.t.releasable} (key text primary key, first_seen bigint not null)`);
      await q(`create table if not exists ${this.t.crosschain} (
        release_tx text primary key, vault text not null, policy_id numeric(78,0) not null, period_index integer not null,
        amount numeric(78,0) not null, destination_domain integer not null, seen_at bigint not null,
        forward_state text, mint_tx text)`);
      await q(`create table if not exists ${this.t.alerts} (
        key text primary key, kind text not null, announced_at timestamptz not null default now(), cleared_at timestamptz)`);
      await q(`create table if not exists ${this.t.cursor} (vault text primary key, block numeric(78,0) not null)`);
    })();
    return this.ready;
  }

  async firstSeenReleasable(key: string, now: number): Promise<number> {
    await this.migrate();
    const r = await this.pool.query<{ first_seen: string }>(
      `insert into ${this.t.releasable} (key, first_seen) values ($1, $2)
       on conflict (key) do update set key = excluded.key returning first_seen`,
      [key, now],
    );
    return Number(r.rows[0]!.first_seen);
  }

  async forgetReleasable(keys: string[]): Promise<void> {
    if (!keys.length) return;
    await this.migrate();
    await this.pool.query(`delete from ${this.t.releasable} where key = any($1::text[])`, [keys]);
  }

  async openCrossChain(): Promise<CrossChainRelease[]> {
    await this.migrate();
    const r = await this.pool.query(`select * from ${this.t.crosschain} where forward_state is distinct from 'COMPLETE' order by seen_at`);
    return r.rows.map((x: any) => ({
      releaseTx: x.release_tx, policyId: x.policy_id, periodIndex: x.period_index, amount: x.amount,
      destinationDomain: x.destination_domain, seenAt: Number(x.seen_at), forwardState: x.forward_state, mintTx: x.mint_tx,
    }));
  }

  async updateCrossChain(releaseTx: string, forwardState: string | null, mintTx: string | null): Promise<void> {
    await this.migrate();
    await this.pool.query(`update ${this.t.crosschain} set forward_state = $2, mint_tx = $3 where release_tx = $1`, [releaseTx, forwardState, mintTx]);
  }

  async announced(): Promise<Map<string, ProblemKind>> {
    await this.migrate();
    const r = await this.pool.query<{ key: string; kind: ProblemKind }>(`select key, kind from ${this.t.alerts} where cleared_at is null`);
    return new Map(r.rows.map((x) => [x.key, x.kind]));
  }

  async markAnnounced(key: string, kind: ProblemKind): Promise<void> {
    await this.migrate();
    await this.pool.query(
      `insert into ${this.t.alerts} (key, kind) values ($1, $2)
       on conflict (key) do update set kind = excluded.kind, announced_at = now(), cleared_at = null`,
      [key, kind],
    );
  }

  async markCleared(key: string): Promise<void> {
    await this.migrate();
    await this.pool.query(`update ${this.t.alerts} set cleared_at = now() where key = $1`, [key]);
  }

  /**
   * Record the vault's cross-chain releases since the last scan, so their mints can be checked.
   * Same-chain releases need no follow-up: the vault paid the recipient in the release itself.
   * Learns the provider's range limit the way the watcher does (V: Arc RPC limits).
   */
  async scanReleases(client: PublicClient, vault: `0x${string}`, vaultLabel: string, deployBlock: bigint, now: number): Promise<number> {
    await this.migrate();
    const row = await this.pool.query<{ block: string }>(`select block from ${this.t.cursor} where vault = $1`, [vault.toLowerCase()]);
    let from = row.rows[0] ? BigInt(row.rows[0].block) + 1n : deployBlock;
    const head = (await client.getBlockNumber()) - 2n;
    let span = 10_000n;
    let recorded = 0;
    while (from <= head) {
      const to = from + span - 1n > head ? head : from + span - 1n;
      let logs;
      try {
        logs = await client.getLogs({ address: vault, event: RELEASED as any, fromBlock: from, toBlock: to });
      } catch (err) {
        if (classifyLogsError(err) === "range" && span > 10n) { span /= 2n; continue; }
        throw err;
      }
      for (const log of logs) {
        const a = (decodeEventLog({ abi: [RELEASED], data: log.data, topics: log.topics }) as any).args;
        if (Number(a.destinationDomain) === ARC_DOMAIN) continue;
        await this.pool.query(
          `insert into ${this.t.crosschain} (release_tx, vault, policy_id, period_index, amount, destination_domain, seen_at)
           values ($1, $2, $3, $4, $5, $6, $7) on conflict (release_tx) do nothing`,
          [log.transactionHash!.toLowerCase(), vaultLabel, a.policyId.toString(), Number(a.periodIndex), a.amount.toString(), Number(a.destinationDomain), now],
        );
        recorded++;
      }
      await this.pool.query(
        `insert into ${this.t.cursor} (vault, block) values ($1, $2) on conflict (vault) do update set block = excluded.block`,
        [vault.toLowerCase(), to.toString()],
      );
      from = to + 1n;
    }
    return recorded;
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

/** Circle's forwarding state for a burn, from the attestation API. Sandbox on testnet. */
export function irisForwardStatus(irisBase: string) {
  return async (releaseTx: string): Promise<{ forwardState: string | null; mintTx: string | null }> => {
    const res = await fetch(`${irisBase.replace(/\/+$/, "")}/v2/messages/${ARC_DOMAIN}?transactionHash=${releaseTx}`);
    if (res.status === 404) return { forwardState: null, mintTx: null }; // not indexed yet
    if (!res.ok) throw new Error(`Circle's API returned ${res.status}`);
    const m = ((await res.json()) as any).messages?.[0];
    return { forwardState: m?.forwardState ?? null, mintTx: m?.destinationMintTxHash ?? m?.forwardTxHash ?? null };
  };
}
