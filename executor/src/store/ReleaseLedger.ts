/**
 * Every release the vault has emitted, and the query that finds the ones nobody paid.
 *
 * The settlement store records what the keeper did. It cannot record what the keeper never saw: a
 * release that happened while no keeper ran, one skipped because the keeper cold-started at the
 * chain head, or one stranded behind a scan that stalled. On v4, four releases (policies 6, 15, 16
 * and 20) sat in the executor wallet for six weeks with their recipients unpaid, and nothing noticed,
 * because nothing compared what the chain released with what was settled.
 *
 * This table is the chain's side of that comparison. It is filled from the vault's own events from
 * its deploy block onward, independently of the keeper, so its record does not depend on the keeper
 * having been running. Reconciliation is then a join: releases with no settled row.
 *
 * Rows are immutable facts about the chain, except for two columns that belong to people and alerts:
 * `resolution`, for a release a human has accounted for another way, and the alert state.
 */
import pg from "pg";
import type { PayoutCurrency, ReleasedPolicy } from "../types.js";
import { migrateSettlements, pgConnectionString, qualified } from "./PostgresSettlementStore.js";

/** Why a release is listed as needing attention. */
export type UnsettledKind =
  /** Released, and no settlement was ever started. The funds are in the executor wallet. */
  | "unpaid"
  /** A settlement started and has not finished. Usually a crash mid-leg. */
  | "stuck"
  /** A settlement failed and, by design, will not retry itself. */
  | "failed";

export interface LedgerRelease {
  vault: string;
  policyId: string;
  periodIndex: number;
  releaseTxHash: string;
  blockNumber: string;
  /** When the release happened onchain, if the block time could be read. */
  releasedAt: string | null;
  recipient: string;
  amount: string;
  payoutCurrency: PayoutCurrency;
  destinationDomain: number;
}

export interface Unsettled extends LedgerRelease {
  kind: UnsettledKind;
  /** Seconds since the release, or since the ledger first saw it when the block time is unknown. */
  ageSeconds: number;
  /** The last state an alert was sent for, so the same problem is not announced twice. */
  alertedState: string | null;
}

/** A release that was flagged, and has since been paid or accounted for. */
export interface Cleared extends LedgerRelease {
  alertedState: string;
  how: "settled" | "resolved";
  resolution: string | null;
}

export interface ReconcileThresholds {
  /** How long a release may go without a settlement starting. The keeper normally starts in seconds. */
  unpaidAfterSeconds: number;
  /** How long a settlement may stay in progress. A cross-chain leg takes about half a minute. */
  stuckAfterSeconds: number;
}

export const DEFAULT_THRESHOLDS: ReconcileThresholds = { unpaidAfterSeconds: 600, stuckAfterSeconds: 900 };

interface Row {
  vault: string; policy_id: string; period_index: number; release_tx: string; block_number: string;
  released_at: Date | null; recipient: string; amount: string; payout_currency: PayoutCurrency;
  destination_domain: number; age_seconds: string; kind: UnsettledKind; alerted_state: string | null;
  how?: "settled" | "resolved"; resolution?: string | null;
}

const toRelease = (r: Row): LedgerRelease => ({
  vault: r.vault, policyId: r.policy_id, periodIndex: r.period_index, releaseTxHash: r.release_tx,
  blockNumber: r.block_number, releasedAt: r.released_at ? r.released_at.toISOString() : null,
  recipient: r.recipient, amount: r.amount, payoutCurrency: r.payout_currency, destinationDomain: r.destination_domain,
});

export interface ReleaseLedgerOptions {
  connectionString: string;
  schema?: string;
  maxConnections?: number;
}

export class ReleaseLedger {
  private readonly pool: pg.Pool;
  private readonly schema: string;
  private readonly releases: string;
  private readonly settlements: string;
  private ready: Promise<void> | undefined;

  constructor(opts: ReleaseLedgerOptions) {
    this.schema = opts.schema ?? "public";
    this.releases = qualified(this.schema, "releases");
    this.settlements = qualified(this.schema, "settlements");
    this.pool = new pg.Pool({
      connectionString: pgConnectionString(opts.connectionString),
      max: opts.maxConnections ?? 2,
      idleTimeoutMillis: 30_000,
    });
  }

  migrate(): Promise<void> {
    this.ready ??= (async () => {
      const q = (sql: string) => this.pool.query(sql);
      // The join needs the settlements table, and a fresh database may meet the ledger first.
      await migrateSettlements(q, this.schema);
      await q(`
        create table if not exists ${this.releases} (
          vault              text           not null check (vault ~ '^0x[0-9a-f]{40}$'),
          policy_id          numeric(78, 0) not null,
          period_index       integer        not null,
          release_tx         text           not null,
          block_number       numeric(78, 0) not null,
          released_at        timestamptz,
          recipient          text           not null,
          amount             numeric(78, 0) not null,
          payout_currency    text           not null,
          destination_domain integer        not null,
          first_seen_at      timestamptz    not null default now(),
          resolution         text,
          resolved_at        timestamptz,
          alerted_state      text,
          alerted_at         timestamptz,
          primary key (vault, policy_id, period_index)
        )`);
      await q(`create index if not exists releases_by_tx on ${this.releases} (release_tx)`);
    })();
    return this.ready;
  }

  /** Record a release. Idempotent: the chain does not change its mind, so a replay changes nothing. */
  async record(release: ReleasedPolicy, releasedAt: Date | null): Promise<void> {
    await this.migrate();
    await this.pool.query(
      `insert into ${this.releases}
         (vault, policy_id, period_index, release_tx, block_number, released_at, recipient, amount, payout_currency, destination_domain)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (vault, policy_id, period_index) do nothing`,
      [
        release.vault.toLowerCase(), release.policyId, release.periodIndex, release.releaseTxHash.toLowerCase(),
        release.releaseBlockNumber.toString(), releasedAt, release.recipient.toLowerCase(), release.amount,
        release.payoutCurrency, release.destinationDomain,
      ],
    );
  }

  /**
   * Releases that need a person, oldest first.
   *
   * Age runs from the onchain release when its block time is known, else from when the ledger first
   * saw it. A release backfilled weeks late therefore surfaces at once rather than waiting out a
   * grace period it has long since exceeded.
   */
  async unsettled(t: ReconcileThresholds = DEFAULT_THRESHOLDS): Promise<Unsettled[]> {
    await this.migrate();
    const res = await this.pool.query<Row>(
      `select r.*, extract(epoch from now() - coalesce(r.released_at, r.first_seen_at))::bigint as age_seconds,
              case when s.status is null then 'unpaid'
                   when s.status = 'failed' then 'failed'
                   else 'stuck' end as kind
         from ${this.releases} r
         left join ${this.settlements} s using (vault, policy_id, period_index)
        where r.resolution is null
          and (
                (s.status is null and now() - coalesce(r.released_at, r.first_seen_at) > make_interval(secs => $1::double precision))
             or (s.status = 'in_progress' and now() - s.updated_at > make_interval(secs => $2::double precision))
             or  s.status = 'failed'
              )
        order by coalesce(r.released_at, r.first_seen_at)`,
      [t.unpaidAfterSeconds, t.stuckAfterSeconds],
    );
    return res.rows.map((r) => ({ ...toRelease(r), kind: r.kind, ageSeconds: Number(r.age_seconds), alertedState: r.alerted_state }));
  }

  /** Releases that were alerted on and have since been paid or accounted for, not yet announced. */
  async cleared(): Promise<Cleared[]> {
    await this.migrate();
    const res = await this.pool.query<Row>(
      `select r.*, 0 as age_seconds, 'unpaid' as kind,
              case when r.resolution is not null then 'resolved' else 'settled' end as how
         from ${this.releases} r
         left join ${this.settlements} s using (vault, policy_id, period_index)
        where r.alerted_state is not null and r.alerted_state <> 'cleared'
          and (r.resolution is not null or s.status = 'settled')`,
    );
    return res.rows.map((r) => ({ ...toRelease(r), alertedState: r.alerted_state!, how: r.how!, resolution: r.resolution ?? null }));
  }

  /** Remember what an alert was sent for, so it is sent once per problem, and once when it clears. */
  async markAlerted(r: Pick<LedgerRelease, "vault" | "policyId" | "periodIndex">, state: UnsettledKind | "cleared"): Promise<void> {
    await this.migrate();
    await this.pool.query(
      `update ${this.releases} set alerted_state = $4, alerted_at = now()
        where vault = $1 and policy_id = $2 and period_index = $3`,
      [r.vault, r.policyId, r.periodIndex, state],
    );
  }

  /**
   * Record that a person has accounted for a release outside the settlement store: paid by a script
   * whose receipt lives elsewhere, or paid with the receipt lost. Takes the release transaction,
   * because that is the one identifier a person can copy from an explorer. Refuses a note-less
   * resolution; the note is the only record of why the ledger stopped asking.
   */
  async resolve(releaseTxHash: string, note: string): Promise<LedgerRelease[]> {
    if (!note.trim()) throw new Error("A resolution needs a note saying how the release was accounted for.");
    await this.migrate();
    const res = await this.pool.query<Row>(
      `update ${this.releases} set resolution = $2, resolved_at = now()
        where release_tx = $1 and resolution is null
        returning *, 0 as age_seconds, 'unpaid' as kind`,
      [releaseTxHash.toLowerCase(), note.trim()],
    );
    return res.rows.map(toRelease);
  }

  /** One release by its transaction, with whatever the ledger knows about it. */
  async byTx(releaseTxHash: string): Promise<(LedgerRelease & { resolution: string | null; settlementStatus: string | null })[]> {
    await this.migrate();
    const res = await this.pool.query<Row & { settlement_status: string | null }>(
      `select r.*, s.status as settlement_status, 0 as age_seconds, 'unpaid' as kind
         from ${this.releases} r
         left join ${this.settlements} s using (vault, policy_id, period_index)
        where r.release_tx = $1`,
      [releaseTxHash.toLowerCase()],
    );
    return res.rows.map((r) => ({ ...toRelease(r), resolution: r.resolution ?? null, settlementStatus: r.settlement_status }));
  }

  async count(): Promise<number> {
    await this.migrate();
    const res = await this.pool.query<{ n: string }>(`select count(*) as n from ${this.releases}`);
    return Number(res.rows[0]?.n ?? 0);
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
