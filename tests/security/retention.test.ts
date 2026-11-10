/**
 * @file Data retention (R-15): the purge deletes only expired operational rows, keeps live
 * sessions/idempotency records/unpublished events, refuses windows under 7 days, and the
 * runtime role still has no direct DELETE on the purged tables.
 * @module tests/security
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ok, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let A: Tenant;

beforeAll(async () => {
  t = await startApp();
  A = await tenant(t, 'RET', ['W1']);
});
afterAll(async () => {
  await t?.close();
});

describe('Retention purge', () => {
  it('deletes only expired operational data and records an audit entry', async () => {
    // Live data: an idempotent command, the admin session, an unpublished event.
    ok(await A.admin.post(`/api/wms/w/${A.wh.W1}/nodes`, { kind: 'STAGING', code: 'RET-REC', name: 'x' }));
    // Expired data, aged directly in the database (owner role).
    const old = "now() - interval '400 days'";
    await t.owner.query(`UPDATE command_log SET created_at = ${old} WHERE command = 'node.create' AND company_id = $1`, [A.companyId]);
    await t.owner.query(
      `INSERT INTO sessions (user_id, company_id, token_hash, csrf_hash, state, idle_expires_at, absolute_expires_at, revoked_at)
       VALUES ($1, $2, decode(md5(random()::text) || md5(random()::text), 'hex'), decode(md5(random()::text), 'hex'), 'ACTIVE', ${old}, ${old}, ${old})`,
      [A.admin.userId, A.companyId],
    );
    for (const published of [old, 'NULL']) {
      await t.owner.query(
        `INSERT INTO domain_outbox (company_id, event_type, event_version, aggregate_type, aggregate_id, payload, created_at, published_at)
         VALUES ($1, 'wms.test.event', 1, 'test', gen_random_uuid(), '{}', ${old}, ${published})`,
        [A.companyId],
      );
    }
    const unpublishedBefore = (
      await t.owner.query('SELECT count(*)::int AS n FROM domain_outbox WHERE company_id = $1 AND published_at IS NULL', [A.companyId])
    ).rows[0].n;

    const r = await t.services.retention.runOnce();
    expect(r.commandLog).toBeGreaterThanOrEqual(1);
    expect(r.sessions).toBeGreaterThanOrEqual(1);
    expect(r.domainOutbox).toBeGreaterThanOrEqual(1);

    // Live session and unpublished events untouched.
    expect((await A.admin.get('/api/auth/session')).status).toBe(200);
    const unpublishedAfter = (
      await t.owner.query('SELECT count(*)::int AS n FROM domain_outbox WHERE company_id = $1 AND published_at IS NULL', [A.companyId])
    ).rows[0].n;
    expect(unpublishedAfter).toBe(unpublishedBefore);
    // Business history is never touched.
    expect((await t.owner.query('SELECT count(*)::int AS n FROM storage_nodes WHERE company_id = $1', [A.companyId])).rows[0].n).toBe(1);
    const audit = (await t.owner.query(`SELECT count(*)::int AS n FROM security_audit_log WHERE action = 'system.retention.purge'`)).rows[0]
      .n;
    expect(audit).toBeGreaterThanOrEqual(1);
  });

  it('refuses windows under 7 days and keeps the runtime role without DELETE', async () => {
    const app = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
    await app.connect();
    try {
      await expect(app.query('SELECT * FROM app_retention_purge(1, 30, 30, 30)')).rejects.toThrow(/7-day minimum/);
      for (const table of ['command_log', 'sessions', 'one_time_tokens', 'domain_outbox']) {
        await expect(app.query(`DELETE FROM ${table}`), table).rejects.toThrow(/permission denied/);
      }
    } finally {
      await app.end();
    }
  });
});
