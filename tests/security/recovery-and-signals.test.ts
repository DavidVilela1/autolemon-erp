/**
 * @file Account recovery with a recorded identity check (ASVS 5.0 V6.4.4) and control-bypass
 * signals in the audit trail (V16.3.3) — ADR-0029. Covers the full administrator-issued password
 * reset (token single use, MFA still required, sessions revoked), self-recovery refusal, and that
 * rejected input / throttling is audited once per source and window without request contents.
 * @module tests/security
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, login, ok, PASSWORD, staff, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let A: Tenant;
let B: Tenant;
const verification = { method: 'KNOWN_PHONE_CALLBACK', reference: 'chamada de volta 13/11, confirmado pelo chefe de turno' };

beforeAll(async () => {
  t = await startApp();
  A = await tenant(t, 'REC-A', ['W1']);
  B = await tenant(t, 'REC-B', ['W1']);
});
afterAll(async () => {
  await t?.close();
});

const auditRows = async (action: string, where = '', params: unknown[] = []) =>
  (
    await t.owner.query(
      `SELECT company_id, actor_user_id, resource_id, details FROM security_audit_log WHERE action = $1 ${where} ORDER BY seq`,
      [action, ...params],
    )
  ).rows;

describe('Account recovery needs a recorded identity check (V6.4.4)', () => {
  it('MFA and password resets refuse a missing/invalid verification, refuse self-recovery and audit the method', async () => {
    const victim = await staff(t, A, A.wh.W1!, ['wms.view']);
    await A.admin.stepUp();
    for (const kind of ['mfa-reset', 'password-reset']) {
      const url = `/api/admin/users/${victim.userId}/${kind}`;
      expect((await A.admin.post(url, {})).status).toBe(400);
      expect((await A.admin.post(url, { method: 'EMAIL', reference: 'enviei um email' })).status).toBe(400);
      expect((await A.admin.post(url, { method: 'IN_PERSON', reference: 'ok' })).status).toBe(400); // too short
      expect((await A.admin.post(url, { ...verification, extra: 1 })).status).toBe(400);
      const self = await A.admin.post(`/api/admin/users/${A.admin.userId}/${kind}`, verification);
      expect(self.status).toBe(409);
      expect(self.body.error.code).toBe('SELF_RECOVERY_FORBIDDEN');
      await B.admin.stepUp();
      expect((await B.admin.post(url, verification)).status).toBe(404);
    }
    ok(await A.admin.post(`/api/admin/users/${victim.userId}/mfa-reset`, verification));
    const [mfa] = await auditRows('admin.user.mfa_reset', 'AND resource_id = $2', [victim.userId]);
    expect(mfa.details).toMatchObject({ identityVerification: 'KNOWN_PHONE_CALLBACK', verificationReference: verification.reference });
  });

  it('administrator-issued password reset: single-use token, policy applies, sessions revoked, MFA still required (V6.4.3)', async () => {
    const email = `rec-${Date.now()}@example.test`;
    const created = ok(
      await A.admin.post('/api/admin/users', {
        email,
        displayName: 'Recuperação',
        role: 'STAFF',
        warehouseId: A.wh.W1,
        permissions: ['wms.view'],
      }),
    );
    const { enroll } = await import('../helpers/harness.js');
    const { secret } = await enroll(t, created.invitationToken, PASSWORD);
    const session = await login(t, email, PASSWORD, secret, created.id);

    await A.admin.stepUp();
    const { passwordResetToken } = ok(await A.admin.post(`/api/admin/users/${created.id}/password-reset`, verification));
    const anon = new Client(t);
    // A top common password that fits the length policy (built at runtime so secret scanners do not flag a literal).
    const common = ['qwerty', '123456'].join('');
    expect((await anon.post('/api/auth/password/reset', { token: passwordResetToken, password: common })).status).toBe(400);
    const newPassword = 'caixas azuis na prateleira de cima 9';
    expect(ok(await anon.post('/api/auth/password/reset', { token: passwordResetToken, password: newPassword }))).toEqual({ reset: true });
    expect((await anon.post('/api/auth/password/reset', { token: passwordResetToken, password: `${newPassword}!` })).status).toBe(404); // single use
    expect((await session.get('/api/auth/session')).status).toBe(401); // all sessions revoked

    const c = new Client(t);
    const step1 = await c.post('/api/auth/login', { email, password: PASSWORD });
    expect(step1.status).toBe(401); // old password no longer works
    const step2 = ok(await c.post('/api/auth/login', { email, password: newPassword }));
    expect(step2.mfaRequired).toBe(true);
    expect((await c.get('/api/auth/session')).status).toBe(401); // still needs the second factor
  });
});

describe('Control-bypass signals in the audit trail (V16.3.3)', () => {
  it('records rejected input once per source and window, with a summary, and never the request contents', async () => {
    await t.services.signals.flush(true); // close windows opened by earlier tests in this file
    const before = (await auditRows('security.input_rejected', 'AND company_id = $2', [A.companyId])).length;
    const url = '/api/wms/skus';
    for (let i = 0; i < 6; i++) {
      expect((await A.admin.post(url, { code: 'X', description: 'SECRET-PAYLOAD-123', unexpected: true })).status).toBe(400);
    }
    let rows = (await auditRows('security.input_rejected', 'AND company_id = $2', [A.companyId])).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: A.admin.userId,
      resource_id: 'POST /api/wms/skus',
      details: { errorCode: 'VALIDATION_FAILED' },
    });

    await t.services.signals.flush(true);
    rows = (await auditRows('security.input_rejected', 'AND company_id = $2', [A.companyId])).slice(before);
    expect(rows).toHaveLength(2);
    expect(rows[1].details).toMatchObject({ summary: true, suppressedEvents: 5 });
    const all = JSON.stringify(await auditRows('security.input_rejected'));
    expect(all).not.toContain('SECRET-PAYLOAD-123');
  });

  it('covers malformed JSON, unsupported media types and unauthenticated input (pre-authentication chain)', async () => {
    await t.services.signals.flush(true);
    const before = (await auditRows('security.input_rejected', 'AND company_id IS NULL')).length;
    const anon = new Client(t);
    expect((await anon.request('POST', '/api/auth/login', '{"email": ', { 'content-type': 'application/json' })).status).toBe(400);
    const xml = await B.admin.request('POST', '/api/wms/skus', '<sku/>', { 'content-type': 'application/xml' });
    expect(xml.status).toBe(415);
    // The JSON/content-type parsers reject before the session is resolved, so both signals are
    // keyed by client IP on the pre-authentication chain (no actor) — one source, one window:
    // the first is written, the second is counted in the summary.
    let pre = (await auditRows('security.input_rejected', 'AND company_id IS NULL')).slice(before);
    expect(pre).toHaveLength(1);
    expect(pre[0]).toMatchObject({ resource_id: 'POST /api/auth/login', actor_user_id: null });
    await t.services.signals.flush(true);
    pre = (await auditRows('security.input_rejected', 'AND company_id IS NULL')).slice(before);
    expect(pre[1]?.details).toMatchObject({ summary: true, suppressedEvents: 1 });
  });

  it('records authentication throttling as security.rate_limited', async () => {
    const anon = new Client(t);
    let limited = false;
    for (let i = 0; i < 15 && !limited; i++) {
      const r = await anon.post('/api/auth/login', { email: A.adminEmail, password: 'wrong-password-123456' });
      limited = r.status === 429;
    }
    expect(limited).toBe(true);
    const rows = await auditRows('security.rate_limited');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.at(-1)!.details).toMatchObject({ errorCode: 'RATE_LIMITED' });
  });

  it('the monitor raises security.probing when many sources are rejected', async () => {
    for (let i = 0; i < 10; i++) {
      await t.services.audit.record({
        companyId: B.companyId,
        action: 'security.input_rejected',
        outcome: 'DENIED',
        clientIp: `198.51.100.${i}`,
      });
    }
    await t.services.monitor.runOnce();
    const alerts = await t.owner.query(`SELECT severity FROM security_alerts WHERE company_id = $1 AND rule = 'security.probing'`, [
      B.companyId,
    ]);
    expect(alerts.rows).toEqual([{ severity: 'MEDIUM' }]);
  });
});

describe('Response hardening evidence (V3.4.6, V16.5.1)', () => {
  it('forbids framing and returns generic errors with a request id and no internals', async () => {
    const h = await A.admin.get('/api/auth/session');
    expect(h.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h.headers['x-frame-options']).toBe('DENY');
    const nf = await A.admin.get(`/api/wms/w/${A.wh.W1}/nodes/00000000-0000-4000-8000-000000000000`);
    expect(nf.status).toBe(404);
    expect(nf.body).toMatchObject({ error: { code: 'NOT_FOUND' }, requestId: expect.any(String) });
    expect(nf.text).not.toMatch(/\bat \S+\.(ts|js):\d+|SELECT |postgres|stack/i);
  });
});
