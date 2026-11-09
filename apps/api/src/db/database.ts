/**
 * @file Database access: connection pool, Drizzle executor and tenant-scoped transactions.
 * @module platform/db
 *
 * Every application query runs inside {@link Database.tenantTx} or {@link Database.systemTx}.
 * tenantTx sets the RLS context with `set_config(..., true)` — transaction-local — so a
 * pooled connection can never leak one tenant's context into another request. All SQL is
 * written with Drizzle's `sql` tagged template, which sends values as bind parameters
 * (never string concatenation). The only `sql.raw` uses take code-defined constants
 * (allowlisted identifiers) and are listed in docs/DATABASE.md "Reviewed raw SQL".
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql, type SQL } from 'drizzle-orm';
import type { AppConfig } from '../config/env.js';
import { NotFound } from '../common/errors.js';

/** Drizzle database handle type. */
export type Db = NodePgDatabase<Record<string, never>>;
/** Transaction handle passed to service code. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** RLS scope: company plus warehouse visibility ('*' = all warehouses of the company). */
export interface TenantScope {
  companyId: string;
  whScope: '*' | string;
}

// Return numeric/bigint as strings (exact decimals), timestamps as Date (pg default).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

/** Retryable PostgreSQL errors: serialization failure and deadlock. */
const RETRYABLE = new Set(['40001', '40P01']);

/** Builds TLS options for node-postgres from configuration. */
export function sslOptions(cfg: Pick<AppConfig, 'DB_SSL' | 'DB_SSL_CA_FILE'>): pg.PoolConfig['ssl'] {
  if (cfg.DB_SSL === 'disable') return false;
  if (cfg.DB_SSL === 'require') return { rejectUnauthorized: false, minVersion: 'TLSv1.2' };
  // verify-full: validate certificate chain and hostname; prefer TLS 1.3.
  return {
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    ...(cfg.DB_SSL_CA_FILE ? { ca: readFileSync(cfg.DB_SSL_CA_FILE, 'utf8') } : {}),
  };
}

/** Owns the pool and provides transaction helpers. One instance per process. */
export class Database {
  readonly pool: pg.Pool;
  readonly db: Db;

  /** @param cfg Runtime configuration (uses APP_DATABASE_URL — the least-privileged role). */
  constructor(cfg: Pick<AppConfig, 'APP_DATABASE_URL' | 'DB_SSL' | 'DB_SSL_CA_FILE' | 'DB_POOL_MAX'>) {
    this.pool = new pg.Pool({
      connectionString: cfg.APP_DATABASE_URL,
      max: cfg.DB_POOL_MAX,
      ssl: sslOptions(cfg),
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 30_000,
      application_name: 'autolemon-api',
    });
    // An idle client error (e.g. DB restart/failover) must not crash the process; the pool
    // discards the client and the next query reconnects.
    this.pool.on('error', (err) => process.emitWarning(`postgres pool error: ${err.message}`));
    this.db = drizzle(this.pool);
  }

  /**
   * Runs `fn` in a READ COMMITTED transaction with the tenant RLS context set.
   * Deadlocks / serialization failures are retried up to 3 times; this is safe because the
   * whole transaction (including idempotency log rows) rolls back on failure.
   */
  async tenantTx<T>(scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.retrying(() =>
      this.db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.company_id', ${scope.companyId}, true), set_config('app.wh_scope', ${scope.whScope}, true)`,
        );
        return fn(tx);
      }),
    );
  }

  /**
   * Runs `fn` in a transaction WITHOUT tenant context. Only for platform tables that are not
   * tenant-browsable (sessions, users lookup at login, audit chain, key registry). RLS-protected
   * WMS tables return no rows here (fail closed).
   */
  async systemTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.retrying(() => this.db.transaction(async (tx) => fn(tx)));
  }

  /** Closes the pool (tests, graceful shutdown). */
  async close(): Promise<void> {
    await this.pool.end();
  }

  private async retrying<T>(op: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (err) {
        const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
        if (attempt < 3 && code && RETRYABLE.has(code)) {
          await new Promise((r) => setTimeout(r, 20 * attempt + Math.floor(Math.random() * 30)));
          continue;
        }
        throw err;
      }
    }
  }
}

/** Executes a query and returns all rows typed as T. */
export async function rows<T>(tx: Tx | Db, query: SQL): Promise<T[]> {
  const res = await tx.execute(query);
  return res.rows as T[];
}

/** Executes a query and returns the first row or undefined. */
export async function row<T>(tx: Tx | Db, query: SQL): Promise<T | undefined> {
  return (await rows<T>(tx, query))[0];
}

/** Executes a query and returns the first row, throwing NotFound when absent. */
export async function one<T>(tx: Tx | Db, query: SQL, what = 'Recurso'): Promise<T> {
  const r = await row<T>(tx, query);
  if (!r) throw new NotFound(what);
  return r;
}

/**
 * Normalises a timestamp column value. Drizzle's node-postgres session returns timestamptz
 * values from raw `execute()` as strings, so every Date comparison must go through this.
 */
export function asDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v : new Date(v);
}

/**
 * Unwraps Drizzle's wrapped driver errors so PG error codes can be translated.
 * Drizzle 0.45 wraps failures in DrizzleQueryError with the pg error in `cause`.
 */
export function pgCause(err: unknown): unknown {
  const e = err as { code?: string; cause?: unknown };
  if (e && typeof e === 'object' && !e.code && e.cause) return e.cause;
  return err;
}
