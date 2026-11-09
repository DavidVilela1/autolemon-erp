/**
 * @file Forward-only SQL migration runner with checksum tamper detection.
 * @module platform/db
 *
 * Why hand-written SQL instead of drizzle-kit generated migrations: the schema relies on
 * composite tenant foreign keys, generated columns, triggers, RLS policies and grants that
 * must be reviewed line by line (ADR-0004). Each file runs in its own transaction under an
 * advisory lock so concurrent deploys cannot interleave. An already-applied migration whose
 * file content changed aborts the run (checksum mismatch) instead of silently diverging.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** Directory containing NNNN_name.sql files (works from src via tsx and from dist). */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** A migration file on disk. */
export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

/** Lists migration files in lexical (= version) order. */
export function listMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sqlText = readFileSync(join(dir, f), 'utf8');
      return {
        version: f.slice(0, 4),
        name: f,
        sql: sqlText,
        checksum: createHash('sha256').update(sqlText).digest('hex'),
      };
    });
}

/**
 * Applies pending migrations using the OWNER connection string.
 * @returns names of migrations applied in this run.
 * @throws when an applied migration's checksum differs from the file on disk.
 */
export async function migrate(ownerUrl: string, opts: { ssl?: pg.ClientConfig['ssl']; dir?: string } = {}): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl, ssl: opts.ssl ?? false });
  await client.connect();
  const applied: string[] = [];
  try {
    // Serialise concurrent migration runs (constant arbitrary lock id).
    await client.query('SELECT pg_advisory_lock(727274001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map(
      (await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [
        r.version,
        r.checksum,
      ]),
    );
    for (const m of listMigrations(opts.dir)) {
      const prev = done.get(m.version);
      if (prev) {
        if (prev !== m.checksum) {
          throw new Error(`Migration ${m.name} was modified after being applied (checksum mismatch). Create a new migration instead.`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum]);
        await client.query('COMMIT');
        applied.push(m.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274001)').catch(() => undefined);
    await client.end();
  }
  return applied;
}

/**
 * Development/test only: ensures the runtime role can log in with the password embedded in
 * APP_DATABASE_URL. Production provisions role credentials out of band (OPERATIONS.md).
 */
export async function ensureDevAppRoleLogin(ownerUrl: string, appUrl: string): Promise<void> {
  const u = new URL(appUrl);
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  if (user !== 'autolemon_app') throw new Error('APP_DATABASE_URL must use the autolemon_app role');
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(password)) throw new Error('Dev app role password must be 12-128 chars [A-Za-z0-9_-]');
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    // Role names/passwords cannot be bind parameters in DDL; the password was validated
    // against a strict allowlist above, so literal quoting is safe here.
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autolemon_app') THEN CREATE ROLE autolemon_app; END IF;
    END $$`);
    await client.query(`ALTER ROLE autolemon_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
  } finally {
    await client.end();
  }
}
