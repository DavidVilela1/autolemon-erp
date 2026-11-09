/**
 * @file Verifies a restored database (called by scripts/restore-smoke.mjs).
 * @module platform/db
 *
 * Connects with the OWNER role to the disposable restored database (RESTORE_DATABASE_URL) and
 * checks schema version, ledger/reservation reconciliation, audit hash chains and decryption of
 * every encrypted field with the current key provider. Exits non-zero on any failure.
 */
import { sql } from 'drizzle-orm';
import { loadConfig } from '../../config/env.js';
import { keyProviderFor } from '../../composition.js';
import { Database, rows } from '../database.js';
import { listMigrations } from '../migrator.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ENCRYPTED_FIELDS, FieldCrypto } from '../../platform/crypto/field-crypto.js';

const url = process.env.RESTORE_DATABASE_URL;
if (!url) throw new Error('RESTORE_DATABASE_URL required');
const cfg = loadConfig({ ...process.env, APP_DATABASE_URL: url } as Record<string, string>);
const db = new Database({ ...cfg, APP_DATABASE_URL: url });
const failures: string[] = [];
try {
  const applied = await rows<{ version: string; checksum: string }>(
    db.db,
    sql`SELECT version, checksum FROM schema_migrations ORDER BY version`,
  );
  const files = listMigrations();
  if (JSON.stringify(applied.map((a) => [a.version, a.checksum])) !== JSON.stringify(files.map((f) => [f.version, f.checksum]))) {
    failures.push('schema_migrations does not match this build');
  }
  const ledger = await rows(
    db.db,
    sql`SELECT p.id FROM stock_positions p LEFT JOIN inventory_ledger l ON l.position_id = p.id
        GROUP BY p.id HAVING p.qty_on_hand <> coalesce(sum(l.qty_delta), 0)`,
  );
  if (ledger.length) failures.push(`${ledger.length} positions do not reconcile with the ledger`);
  const res = await rows(
    db.db,
    sql`SELECT p.id FROM stock_positions p LEFT JOIN reservations r ON r.position_id = p.id AND r.status = 'ACTIVE'
        GROUP BY p.id HAVING p.qty_reserved <> coalesce(sum(r.qty_open), 0)`,
  );
  if (res.length) failures.push(`${res.length} positions have inconsistent reservations`);
  const audit = new AuditService(db);
  const chains = await rows<{ chain_key: string }>(db.db, sql`SELECT DISTINCT chain_key FROM security_audit_log`);
  for (const c of chains) {
    const v = await audit.verifyChain(c.chain_key);
    if (!v.ok) failures.push(`audit chain ${c.chain_key} broken at ${v.brokenAtSeq}`);
  }
  const crypto = new FieldCrypto(db, keyProviderFor(cfg));
  let decrypted = 0;
  for (const f of ENCRYPTED_FIELDS) {
    // Identifiers come from the ENCRYPTED_FIELDS constant (reviewed).
    const items = await rows<{ id: string; company_id: string; v: string }>(
      db.db,
      sql`SELECT ${sql.raw(f.idColumn)}::text AS id, company_id, ${sql.raw(f.column)} AS v FROM ${sql.raw(f.table)} WHERE ${sql.raw(f.column)} IS NOT NULL`,
    );
    for (const it of items) {
      await crypto.decrypt({ companyId: it.company_id, table: f.table, recordId: it.id, field: f.field }, it.v);
      decrypted++;
    }
  }
  const totals = await rows<{ positions: number; ledger: number; audit: number }>(
    db.db,
    sql`SELECT (SELECT count(*)::int FROM stock_positions) AS positions, (SELECT count(*)::int FROM inventory_ledger) AS ledger,
               (SELECT count(*)::int FROM security_audit_log) AS audit`,
  );
  console.log(
    `[verify] positions=${totals[0]?.positions} ledger=${totals[0]?.ledger} audit=${totals[0]?.audit} chains=${chains.length} decrypted=${decrypted}`,
  );
} catch (e) {
  failures.push(`verification error: ${(e as Error).message}`);
} finally {
  await db.close();
}
if (failures.length) {
  console.error(`[verify] FAILED:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log('[verify] restored database verified: schema, ledger, reservations, audit chains, encrypted fields');
