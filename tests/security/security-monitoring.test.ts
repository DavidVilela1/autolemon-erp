/**
 * @file Security monitoring (gate S-05 code part; ADR-0026): threshold rules over the audit log,
 * one open alert per (company, rule) under concurrency, acknowledgement (admin + step-up,
 * one-way, tenant-isolated, audited), re-raise only for new events, incremental and full
 * audit-chain verification with tamper detection, outbox backlog and job-failure alerts,
 * signed webhook delivery with retries and no personal data, database guards for the runtime
 * role, and configuration validation of the webhook.
 * @module tests/security
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signWebhook } from '../../apps/api/src/platform/monitoring/alert-sinks.js';
import { MAX_NOTIFY_ATTEMPTS, SecurityMonitor } from '../../apps/api/src/platform/monitoring/security-monitor.js';
import { ok, staff, startApp, tenant, testConfig, type Tenant, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let A: Tenant;
let B: Tenant;
const logged: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  t = await startApp();
  A = await tenant(t, 'MON-A', ['W1']);
  B = await tenant(t, 'MON-B', ['W1']);
  t.services.monitor.useLogger({ warn: (o) => logged.push(o), error: (o) => logged.push(o) });
});
afterAll(async () => {
  await t?.close();
});

/** Records `n` audit events for a company (the monitor's only signal source). */
async function events(companyId: string | null, action: string, outcome: 'SUCCESS' | 'FAILURE' | 'DENIED', n: number) {
  for (let i = 0; i < n; i++) {
    await t.services.audit.record({ companyId, action, outcome, clientIp: '203.0.113.77', details: { reason: 'bad_password' } });
  }
}

async function alertRows(companyId: string | null, rule: string) {
  return (
    await t.owner.query(
      'SELECT id, status, occurrences, severity, notified_at, notify_attempts, notify_error FROM security_alerts WHERE company_id IS NOT DISTINCT FROM $1 AND rule = $2 ORDER BY first_seen_at',
      [companyId, rule],
    )
  ).rows;
}

describe('Threshold rules and alert lifecycle', () => {
  it('raises one HIGH alert for a burst of failed logins, delivers it to the log without personal data, and refreshes instead of duplicating', async () => {
    await events(A.companyId, 'auth.login', 'FAILURE', 9);
    await t.services.monitor.runOnce();
    expect(await alertRows(A.companyId, 'auth.login_failures')).toHaveLength(0); // below threshold

    await events(A.companyId, 'auth.login', 'FAILURE', 1);
    const r = await t.services.monitor.runOnce();
    expect(r.raised).toBeGreaterThanOrEqual(1);
    const [alert] = await alertRows(A.companyId, 'auth.login_failures');
    expect(alert).toMatchObject({ status: 'OPEN', severity: 'HIGH', occurrences: 10 });
    expect(alert.notified_at).not.toBeNull();

    const line = logged.find((l) => l.securityAlert === true && (l.alert as { id: string }).id === alert.id);
    expect(line).toBeDefined();
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain('203.0.113.77');
    expect(serialized).not.toContain(A.adminEmail.split('@')[0]);

    // Sustained attack: same open alert, higher count, no second row.
    await events(A.companyId, 'auth.login', 'FAILURE', 3);
    await t.services.monitor.runOnce();
    const rows = await alertRows(A.companyId, 'auth.login_failures');
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrences).toBe(13);

    // Tenant isolation of the listing; the raise is in A's audit history.
    const listA = ok(await A.admin.get('/api/admin/security/alerts'));
    expect(listA.map((x: { id: string }) => x.id)).toContain(alert.id);
    expect(ok(await B.admin.get('/api/admin/security/alerts?status=ALL'))).toHaveLength(0);
    const raised = await t.owner.query(
      `SELECT count(*)::int AS n FROM security_audit_log WHERE company_id = $1 AND action = 'security.alert.raised'`,
      [A.companyId],
    );
    expect(raised.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('acknowledgement needs admin.security + step-up, is one-way, tenant-isolated and audited; only NEW events re-raise', async () => {
    const [alert] = await alertRows(A.companyId, 'auth.login_failures');
    const url = `/api/admin/security/alerts/${alert.id}/ack`;

    const op = await staff(t, A, A.wh.W1!, ['wms.view']);
    expect((await op.post(url, {})).status).toBe(403); // admin-only route
    const noStep = await A.admin.post(url, { note: 'investigado' });
    expect(noStep.status).toBe(403);
    expect(noStep.body.error.code).toBe('STEP_UP_REQUIRED');
    await B.admin.stepUp();
    expect((await B.admin.post(url, {})).status).toBe(404); // other company: no existence oracle

    await A.admin.stepUp();
    expect(ok(await A.admin.post(url, { note: 'IP bloqueado na firewall' }))).toEqual({ id: alert.id, status: 'ACKNOWLEDGED' });
    const again = await A.admin.post(url, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALERT_ALREADY_ACKNOWLEDGED');
    expect((await A.admin.post(url, { note: 'x'.repeat(301) })).status).toBe(400);

    const acked = ok(await A.admin.get('/api/admin/security/alerts?status=ACKNOWLEDGED'));
    expect(acked[0]).toMatchObject({ id: alert.id, ackNote: 'IP bloqueado na firewall', status: 'ACKNOWLEDGED' });
    const audit = await t.owner.query(
      `SELECT actor_user_id FROM security_audit_log WHERE action = 'security.alert.acknowledged' AND resource_id = $1`,
      [alert.id],
    );
    expect(audit.rows).toHaveLength(1);

    // Already-seen events do not re-raise; a new burst does.
    await t.services.monitor.runOnce();
    expect(await alertRows(A.companyId, 'auth.login_failures')).toHaveLength(1);
    await events(A.companyId, 'auth.login', 'FAILURE', 10);
    await t.services.monitor.runOnce();
    const after = await alertRows(A.companyId, 'auth.login_failures');
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({ status: 'OPEN', occurrences: 10 });
  });

  it('single events (recovery code, MFA reset) alert at threshold 1; unknown-account failures raise a system alert invisible to companies', async () => {
    await events(A.companyId, 'auth.login.recovery_code_used', 'SUCCESS', 1);
    await events(null, 'auth.login', 'FAILURE', 50);
    await t.services.monitor.runOnce();
    expect(await alertRows(A.companyId, 'auth.recovery_code_used')).toHaveLength(1);
    const sys = await alertRows(null, 'auth.unknown_account_failures');
    expect(sys).toHaveLength(1);
    expect(sys[0].severity).toBe('HIGH');
    const all = ok(await A.admin.get('/api/admin/security/alerts?status=ALL'));
    expect(all.some((x: { rule: string }) => x.rule === 'auth.unknown_account_failures')).toBe(false);
  });

  it('concurrent monitors never open two alerts for the same (company, rule)', async () => {
    await events(B.companyId, 'authz.denied', 'DENIED', 20);
    const m1 = new SecurityMonitor(t.services.database, t.services.audit, t.services.cfg);
    const m2 = new SecurityMonitor(t.services.database, t.services.audit, t.services.cfg);
    await Promise.all([m1.runOnce(), m2.runOnce(), t.services.monitor.runOnce()]);
    expect(await alertRows(B.companyId, 'authz.denied_spike')).toHaveLength(1);
  });
});

describe('Overview endpoint', () => {
  it('returns bounded company counters, open alerts and monitor state; validates the window', async () => {
    const o = ok(await A.admin.get('/api/admin/security/overview?windowMinutes=60'));
    expect(o.counters.loginFailure).toBeGreaterThanOrEqual(23);
    expect(o.counters.recoveryCodeUsed).toBe(1);
    expect(o.openAlerts.HIGH).toBeGreaterThanOrEqual(1);
    expect(o.auditChain).toMatchObject({ result: 'OK' });
    expect(o.monitor.channels).toEqual(['log']);
    expect(JSON.stringify(o)).not.toMatch(/webhook|secret/i);
    // B sees only its own activity.
    const ob = ok(await B.admin.get('/api/admin/security/overview'));
    expect(ob.counters.loginFailure).toBe(0);
    expect((await A.admin.get('/api/admin/security/overview?windowMinutes=4')).status).toBe(400);
    expect((await A.admin.get('/api/admin/security/overview?windowMinutes=10081')).status).toBe(400);
    expect((await A.admin.get('/api/admin/security/alerts?status=DELETED')).status).toBe(400);
  });
});

describe('Event alerts', () => {
  it('raises system.outbox_stuck once per stuck event and refreshes while it stays stuck', async () => {
    await t.owner.query(
      `INSERT INTO domain_outbox (company_id, event_type, event_version, aggregate_type, aggregate_id, payload, created_at)
       VALUES ($1, 'wms.test.event', 1, 'test', gen_random_uuid(), '{}', now() - interval '2 hours')`,
      [B.companyId],
    );
    await t.services.monitor.runOnce();
    await t.services.monitor.runOnce();
    const rows = await alertRows(B.companyId, 'system.outbox_stuck');
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe('MEDIUM');
    await t.owner.query('UPDATE domain_outbox SET published_at = now() WHERE company_id = $1', [B.companyId]);
  });

  it('job failures raise one system alert per job and hour and one audit entry, without the error message', async () => {
    expect(await t.services.monitor.reportJobFailure('retention', new TypeError('relation "x" value 4111-1111'))).toBe('raised');
    expect(await t.services.monitor.reportJobFailure('retention', new TypeError('again'))).toBe('skipped');
    const rows = await alertRows(null, 'system.retention_failed');
    expect(rows).toHaveLength(1);
    const audit = await t.owner.query(`SELECT details FROM security_audit_log WHERE action = 'system.retention.failed'`);
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0].details)).not.toContain('4111');
    const stored = await t.owner.query(`SELECT details FROM security_alerts WHERE rule = 'system.retention_failed'`);
    expect(JSON.stringify(stored.rows[0].details)).not.toContain('4111');
  });
});

describe('Webhook delivery', () => {
  it('signs the payload, refuses redirects, carries no personal data, records failures and retries a bounded number of times', async () => {
    const secret = 'webhook-test-signing-material-0123456789';
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let status = 500;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    const cfg = { ...t.services.cfg, ALERT_WEBHOOK_URL: 'https://siem.example.test/hooks/autolemon', ALERT_WEBHOOK_SECRET: secret };
    const m = new SecurityMonitor(t.services.database, t.services.audit, cfg, fakeFetch);
    m.useLogger({ warn: () => undefined, error: () => undefined });

    await events(B.companyId, 'admin.keys.rotate', 'SUCCESS', 1);
    await m.runOnce();
    let [alert] = await alertRows(B.companyId, 'admin.key_rotation');
    expect(alert.notified_at).toBeNull();
    expect(alert.notify_attempts).toBe(1);
    expect(alert.notify_error).toBe('webhook: webhook HTTP 500');
    expect(alert.notify_error).not.toContain('siem.example.test');

    const call = calls.find((c) => JSON.parse(String(c.init.body)).alert.id === alert.id)!;
    expect(call.init.redirect).toBe('error');
    const headers = call.init.headers as Record<string, string>;
    const body = String(call.init.body);
    expect(headers['X-AutoLemon-Signature']).toBe(`v1=${signWebhook(secret, headers['X-AutoLemon-Timestamp']!, body)}`);
    expect(JSON.parse(body)).toMatchObject({
      type: 'autolemon.security_alert',
      alert: { rule: 'admin.key_rotation', companyId: B.companyId },
    });
    expect(body).not.toContain('203.0.113.77');
    expect(body).not.toContain(B.adminEmail);

    for (let i = 1; i < MAX_NOTIFY_ATTEMPTS + 2; i++) await m.runOnce();
    [alert] = await alertRows(B.companyId, 'admin.key_rotation');
    expect(alert.notify_attempts).toBe(MAX_NOTIFY_ATTEMPTS); // gives up, stays visible in the UI

    status = 204;
    await events(B.companyId, 'admin.pii.read', 'SUCCESS', 5);
    await m.runOnce();
    const [pii] = await alertRows(B.companyId, 'admin.pii_read_burst');
    expect(pii.notified_at).not.toBeNull();
    expect(pii.notify_error).toBeNull();
  });

  it('configuration refuses unsafe webhook settings', () => {
    expect(() => testConfig({ ALERT_WEBHOOK_URL: 'http://siem.example.test/x', ALERT_WEBHOOK_SECRET: 's'.repeat(32) })).toThrow(
      /must be https/,
    );
    expect(() => testConfig({ ALERT_WEBHOOK_URL: 'https://siem.example.test/x' })).toThrow(/ALERT_WEBHOOK_SECRET is required/);
    expect(() => testConfig({ ALERT_WEBHOOK_URL: 'https://u:p@siem.example.test/x', ALERT_WEBHOOK_SECRET: 's'.repeat(32) })).toThrow(
      /credentials/,
    );
    expect(() => testConfig({ ALERT_WEBHOOK_URL: 'https://siem.example.test/x', ALERT_WEBHOOK_SECRET: 'short' })).toThrow();
    expect(
      testConfig({ ALERT_WEBHOOK_URL: 'http://127.0.0.1:9000/x', ALERT_WEBHOOK_SECRET: 's'.repeat(32) }).ALERT_WEBHOOK_URL,
    ).toBeDefined();
  });
});

describe('Database guards for the runtime role', () => {
  it('cannot delete alerts, rewrite their identity, or reopen an acknowledged alert', async () => {
    const app = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
    await app.connect();
    try {
      const [acked] = (await alertRows(A.companyId, 'auth.login_failures')).filter((r) => r.status === 'ACKNOWLEDGED');
      await expect(app.query('DELETE FROM security_alerts WHERE id = $1', [acked.id])).rejects.toThrow(/permission denied/);
      await expect(app.query(`UPDATE security_alerts SET rule = 'x.y' WHERE id = $1`, [acked.id])).rejects.toThrow(/permission denied/);
      await expect(
        app.query(`UPDATE security_alerts SET status = 'OPEN', acknowledged_at = NULL WHERE id = $1`, [acked.id]),
      ).rejects.toThrow(/cannot be reopened/);
      await expect(app.query(`UPDATE security_alerts SET ack_note = 'rewritten' WHERE id = $1`, [acked.id])).rejects.toThrow(/immutable/);
      await expect(app.query('DELETE FROM audit_chain_checkpoints')).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });
});

describe('Audit-chain verification by the monitor', () => {
  async function tamper(companyId: string, seq: 'latest' | 'first') {
    const order = seq === 'latest' ? 'DESC' : 'ASC';
    await t.owner.query('ALTER TABLE security_audit_log DISABLE TRIGGER security_audit_append_only');
    try {
      const r = await t.owner.query(
        `UPDATE security_audit_log SET details = '{"forged":true}'::jsonb
          WHERE id = (SELECT id FROM security_audit_log WHERE chain_key = $1 ORDER BY seq ${order} LIMIT 1) RETURNING seq::text`,
        [companyId],
      );
      return r.rows[0].seq as string;
    } finally {
      await t.owner.query('ALTER TABLE security_audit_log ENABLE TRIGGER security_audit_append_only');
    }
  }

  it('detects tampering of a new entry incrementally and raises one CRITICAL alert', async () => {
    const C = await tenant(t, 'MON-C', ['W1']);
    await t.services.monitor.runOnce(); // checkpoint covers the current chain
    const cp = await t.owner.query('SELECT seq::text, last_result FROM audit_chain_checkpoints WHERE chain_key = $1', [C.companyId]);
    expect(cp.rows[0].last_result).toBe('OK');

    await events(C.companyId, 'auth.password_change', 'SUCCESS', 3);
    const brokenSeq = await tamper(C.companyId, 'latest');
    const r = await t.services.monitor.runOnce();
    expect(r.brokenChains).toBeGreaterThanOrEqual(1); // other test files in this database may have tampered chains too
    await t.services.monitor.runOnce(); // same break: no duplicate
    const alerts = await alertRows(C.companyId, 'audit.chain_broken');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('CRITICAL');
    const o = ok(await C.admin.get('/api/admin/security/overview'));
    expect(o.auditChain).toMatchObject({ result: 'BROKEN', brokenAtSeq: brokenSeq });
    expect(o.openAlerts.CRITICAL).toBe(1);
  });

  it('detects tampering BEFORE the checkpoint on the daily full pass', async () => {
    const D = await tenant(t, 'MON-D', ['W1']);
    await t.services.monitor.runOnce();
    await tamper(D.companyId, 'first');
    await t.services.monitor.runOnce(); // incremental: the old entry is not re-read
    expect(await alertRows(D.companyId, 'audit.chain_broken')).toHaveLength(0);
    await t.owner.query(`UPDATE audit_chain_checkpoints SET full_pass_started_at = now() - interval '25 hours' WHERE chain_key = $1`, [
      D.companyId,
    ]);
    await t.services.monitor.runOnce();
    const alerts = await alertRows(D.companyId, 'audit.chain_broken');
    expect(alerts).toHaveLength(1);
    expect(await t.services.audit.verifyChain(D.companyId)).toMatchObject({ ok: false, brokenAtSeq: '1' });
  });
});
