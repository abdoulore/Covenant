/**
 * Settlement state in Postgres, keyed on (vault, policy id, period). DECISIONS.md D15.
 *
 * The JSON store keyed a settlement as `policyId:periodIndex`. Every PolicyVault deployment numbers
 * its policies from zero, so the first policy on a v5 vault would have collided with v4 policy 0.
 * tryClaim would have returned false, the engine would have logged "already claimed, skipping",
 * which it documents as the healthy outcome of a replayed scan, and a real payment would have been
 * skipped and reported as fine.
 *
 * Here the vault is part of the primary key and the database enforces it. Claiming is an INSERT
 * that either creates the row or does nothing, so "already claimed" is the database's answer, not a
 * check in one process's memory. That also makes it safe for more than one keeper to share a store,
 * which the JSON file never was.
 *
 * Written to work through a transaction-mode connection pooler (pgbouncer, as Neon and Vercel
 * Postgres provide): no session settings, no named prepared statements, and every multi-statement
 * operation holds one connection for its whole transaction. Tables are schema-qualified rather than
 * found through `search_path`, because `SET search_path` is session state a pooler does not keep.
 */
import pg from "pg";
import type { LegKind, ReleasedPolicy, SettlementLeg, SettlementRecord } from "../types.js";
import type { SettlementIdentity, SettlementStoreLike } from "./SettlementStore.js";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Same reason as the JSON store: SDK results carry BigInts and JSON.stringify throws on them. */
function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Pin full certificate verification.
 *
 * `pg` currently treats sslmode=require as verify-full, and warns that its next major version will
 * weaken `require` to libpq's meaning, which encrypts without checking who is on the other end.
 * Stating verify-full explicitly keeps today's behaviour through that upgrade instead of silently
 * losing it. A URL that asks for something else is left alone.
 */
export function pgConnectionString(url: string): string {
  const u = new URL(url);
  const mode = u.searchParams.get("sslmode");
  if (mode === "require" || mode === "prefer" || mode === "verify-ca") u.searchParams.set("sslmode", "verify-full");
  return u.toString();
}

/** A table name inside a validated schema, quoted. */
export function qualified(schema: string, table: string): string {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`Invalid schema name "${schema}"`);
  return `"${schema}".${table}`;
}

/**
 * The settlements table. Exported because the release ledger reconciles against it and must be
 * able to create it too, whichever of the two a fresh database meets first.
 */
export async function migrateSettlements(query: (sql: string) => Promise<unknown>, schema: string): Promise<void> {
  const table = qualified(schema, "settlements");
  if (schema !== "public") await query(`create schema if not exists "${schema}"`);
  await query(`
    create table if not exists ${table} (
      vault         text           not null check (vault ~ '^0x[0-9a-f]{40}$'),
      policy_id     numeric(78, 0) not null check (policy_id >= 0),
      period_index  integer        not null check (period_index >= 0),
      status        text           not null check (status in ('in_progress', 'settled', 'failed')),
      record        jsonb          not null,
      created_at    timestamptz    not null default now(),
      updated_at    timestamptz    not null default now(),
      primary key (vault, policy_id, period_index)
    )`);
  await query(`create index if not exists settlements_in_progress on ${table} (created_at) where status = 'in_progress'`);
}

export interface PostgresSettlementStoreOptions {
  connectionString: string;
  /** Schema holding the table. Defaults to public; tests use a throwaway schema per run. */
  schema?: string;
  /** Upper bound on connections. One keeper needs very few. */
  maxConnections?: number;
}

interface Row { record: SettlementRecord }

export class PostgresSettlementStore implements SettlementStoreLike {
  private readonly pool: pg.Pool;
  private readonly table: string;
  private readonly schema: string;
  private ready: Promise<void> | undefined;

  constructor(opts: PostgresSettlementStoreOptions) {
    this.schema = opts.schema ?? "public";
    this.table = qualified(this.schema, "settlements");
    this.pool = new pg.Pool({
      connectionString: pgConnectionString(opts.connectionString),
      max: opts.maxConnections ?? 3,
      idleTimeoutMillis: 30_000,
    });
  }

  /** Vault, policy, period. The same three columns the primary key is built from. */
  keyFor(id: SettlementIdentity): string {
    const vault = (id.vault ?? "").toLowerCase();
    if (!ADDRESS.test(vault)) {
      throw new Error(
        `Settlement for policy ${id.policyId} has no valid vault ("${id.vault ?? ""}"). ` +
          `Refusing to key it without one: that is the collision D15 exists to prevent.`,
      );
    }
    return `${vault}:${id.policyId}:${id.periodIndex}`;
  }

  /** Create the table if it does not exist. Idempotent, and run once per store instance. */
  migrate(): Promise<void> {
    this.ready ??= migrateSettlements((sql) => this.pool.query(sql), this.schema);
    return this.ready;
  }

  /**
   * Claim a release. True if this call created the claim, false if it already existed.
   *
   * ON CONFLICT DO NOTHING is the whole idempotency boundary: two concurrent claims for the same
   * release cannot both succeed, whichever process they come from.
   */
  async tryClaim(policy: ReleasedPolicy, legs: LegKind[], releaseExplorerUrl: string): Promise<boolean> {
    await this.migrate();
    const [vault, policyId, periodIndex] = parseKey(this.keyFor(policy));
    const record: SettlementRecord = {
      vault,
      policyId: policy.policyId,
      periodIndex: policy.periodIndex,
      status: "in_progress",
      recipient: policy.recipient,
      amount: policy.amount,
      payoutCurrency: policy.payoutCurrency,
      destinationDomain: policy.destinationDomain,
      releaseTxHash: policy.releaseTxHash,
      releaseExplorerUrl,
      legs: legs.map((kind) => ({ kind, status: "pending", attempts: 0 })),
      startedAt: new Date().toISOString(),
    };
    const res = await this.pool.query(
      `insert into ${this.table} (vault, policy_id, period_index, status, record)
       values ($1, $2, $3, 'in_progress', $4::jsonb)
       on conflict (vault, policy_id, period_index) do nothing`,
      [vault, policyId, periodIndex, JSON.stringify(record, bigintSafe)],
    );
    return res.rowCount === 1;
  }

  async get(key: string): Promise<SettlementRecord | undefined> {
    await this.migrate();
    const res = await this.pool.query<Row>(
      `select record from ${this.table} where vault = $1 and policy_id = $2 and period_index = $3`,
      parseKey(key),
    );
    return res.rows[0]?.record;
  }

  async all(): Promise<SettlementRecord[]> {
    await this.migrate();
    const res = await this.pool.query<Row>(`select record from ${this.table} order by created_at`);
    return res.rows.map((r) => r.record);
  }

  async inProgress(): Promise<SettlementRecord[]> {
    await this.migrate();
    const res = await this.pool.query<Row>(
      `select record from ${this.table} where status = 'in_progress' order by created_at`,
    );
    return res.rows.map((r) => r.record);
  }

  async updateLeg(key: string, kind: LegKind, patch: Partial<SettlementLeg>): Promise<void> {
    await this.mutate(key, (record) => {
      const leg = record.legs.find((l) => l.kind === kind);
      if (!leg) throw new Error(`Settlement ${key} has no ${kind} leg`);
      Object.assign(leg, patch);
    });
  }

  async markSettled(key: string): Promise<void> {
    await this.mutate(key, (record) => {
      const completedAt = new Date().toISOString();
      const elapsed = Date.parse(completedAt) - Date.parse(record.startedAt);
      record.status = "settled";
      record.completedAt = completedAt;
      record.durationMs = elapsed;
      record.custodyGapMs = elapsed;
    });
  }

  async markFailed(key: string, failedLeg: LegKind, error: string): Promise<void> {
    await this.mutate(key, (record) => {
      record.status = "failed";
      record.failedLeg = failedLeg;
      record.completedAt = new Date().toISOString();
      const leg = record.legs.find((l) => l.kind === failedLeg);
      if (leg) {
        leg.status = "failed";
        leg.error = error;
      }
    });
  }

  /** Clear a failed settlement for a manual retry. Refuses a settled one: that path pays twice. */
  async reopen(key: string): Promise<void> {
    await this.inTransaction(key, async (client, params) => {
      const res = await client.query<{ status: string }>(
        `select status from ${this.table} where vault = $1 and policy_id = $2 and period_index = $3 for update`,
        params,
      );
      const status = res.rows[0]?.status;
      if (!status) throw new Error(`No settlement for ${key}`);
      if (status === "settled") {
        throw new Error(`Refusing to reopen settled ${key}. Reprocessing it would pay the recipient twice.`);
      }
      await client.query(
        `delete from ${this.table} where vault = $1 and policy_id = $2 and period_index = $3`,
        params,
      );
    });
  }

  /** Close the pool. For shutdown and tests. */
  async end(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Read, change, and write one record inside a transaction that holds its row lock throughout, so
   * two writers cannot interleave a read-modify-write on the same settlement. The status column is
   * written from the record in the same statement, so the two can never disagree.
   */
  private async mutate(key: string, fn: (record: SettlementRecord) => void): Promise<void> {
    await this.inTransaction(key, async (client, params) => {
      const res = await client.query<Row>(
        `select record from ${this.table} where vault = $1 and policy_id = $2 and period_index = $3 for update`,
        params,
      );
      const record = res.rows[0]?.record;
      if (!record) throw new Error(`No settlement for ${key}`);
      fn(record);
      await client.query(
        `update ${this.table} set record = $4::jsonb, status = $5, updated_at = now()
         where vault = $1 and policy_id = $2 and period_index = $3`,
        [...params, JSON.stringify(record, bigintSafe), record.status],
      );
    });
  }

  /** One connection, one transaction, rolled back on any throw. Pooler-safe by construction. */
  private async inTransaction(
    key: string,
    work: (client: pg.PoolClient, params: [string, string, number]) => Promise<void>,
  ): Promise<void> {
    await this.migrate();
    const params = parseKey(key);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await work(client, params);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Split a key back into its three columns, refusing anything that is not one of ours. */
function parseKey(key: string): [string, string, number] {
  const parts = key.split(":");
  const [vault, policyId, period] = parts;
  if (parts.length !== 3 || !ADDRESS.test(vault ?? "") || !/^\d+$/.test(policyId ?? "") || !/^\d+$/.test(period ?? "")) {
    throw new Error(`Not a vault-scoped settlement key: "${key}"`);
  }
  return [vault!, policyId!, Number(period)];
}
