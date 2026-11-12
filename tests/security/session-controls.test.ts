/**
 * @file Session controls added by the ASVS 5.0 L2 review (v0.6.6, ADR-0028): administrators end
 * one user's or every company session (V7.4.5, step-up, audited, tenant-isolated); users need a
 * fresh factor to end their OTHER sessions (V7.5.2); Fetch-Metadata isolation also refuses
 * cross-site reads (V3.5.3); logout sends Clear-Site-Data (V14.3.1); session lifetimes (V7.3);
 * recovery codes carry 120 bits while legacy 80-bit codes keep working once (V6.5.2).
 * @module tests/security
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, enroll, login, ok, PASSWORD, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  t = await startApp();
  A = await tenant(t, 'SES-A', ['W1']);
  B = await tenant(t, 'SES-B', ['W1']);
});
afterAll(async () => {
  await t?.close();
});

/** Creates a staff user and returns two independent logged-in sessions of it. */
async function staffTwice(tn: Tenant): Promise<{ id: string; s1: Client; s2: Client }> {
  const email = `ses-${randomBytes(4).toString('hex')}@example.test`;
  const r = await tn.admin.post('/api/admin/users', {
    email,
    displayName: 'Operador Sessões',
    role: 'STAFF',
    warehouseId: tn.wh.W1,
    permissions: ['wms.view'],
  });
  const { secret } = await enroll(t, r.body.invitationToken, PASSWORD);
  const s1 = await login(t, email, PASSWORD, secret, r.body.id);
  const s2 = await login(t, email, PASSWORD, secret, r.body.id);
  return { id: r.body.id, s1, s2 };
}

const alive = async (c: Client) => (await c.get('/api/auth/session')).status;

describe('User ends own sessions (V7.5.2)', () => {
  it('ending ANOTHER own session or all others needs step-up; ending the current one does not', async () => {
    const u = await staffTwice(A);
    const other = ok(await u.s1.get('/api/auth/sessions')).find((s: { current: boolean }) => !s.current).id;
    const r = await u.s1.post(`/api/auth/sessions/${other}/revoke`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('STEP_UP_REQUIRED');
    expect((await u.s1.post('/api/auth/sessions/revoke-others')).status).toBe(403);
    expect(await alive(u.s2)).toBe(200); // a stolen session cannot kick the real user out

    await u.s1.stepUp();
    expect(ok(await u.s1.post(`/api/auth/sessions/${other}/revoke`)).revoked).toBe(true);
    expect(await alive(u.s2)).toBe(401);

    const current = ok(await u.s1.get('/api/auth/sessions')).find((s: { current: boolean }) => s.current).id;
    const fresh = await staffTwice(A);
    const freshCurrent = ok(await fresh.s1.get('/api/auth/sessions')).find((s: { current: boolean }) => s.current).id;
    expect(ok(await fresh.s1.post(`/api/auth/sessions/${freshCurrent}/revoke`)).revoked).toBe(true); // logout-equivalent
    expect(await alive(fresh.s1)).toBe(401);
    expect(current).toBeDefined();
  });
});

describe('Administrator ends sessions (V7.4.5)', () => {
  it("ends every session of one user: admin.security + step-up, tenant-isolated, audited, never the caller's own", async () => {
    const u = await staffTwice(A);
    const url = `/api/admin/users/${u.id}/sessions/revoke`;
    expect((await u.s1.post(url)).status).toBe(403); // staff: admin-only route
    const noStep = await A.admin.post(url);
    expect(noStep.status).toBe(403);
    expect(noStep.body.error.code).toBe('STEP_UP_REQUIRED');
    await B.admin.stepUp();
    expect((await B.admin.post(url)).status).toBe(404); // other company
    expect(await alive(u.s1)).toBe(200);

    await A.admin.stepUp();
    expect(ok(await A.admin.post(url))).toEqual({ userId: u.id, revoked: 2 });
    expect(await alive(u.s1)).toBe(401);
    expect(await alive(u.s2)).toBe(401);
    expect(await alive(A.admin)).toBe(200);
    const self = ok(await A.admin.post(`/api/admin/users/${A.admin.userId}/sessions/revoke`));
    expect(await alive(A.admin)).toBe(200); // own current session is kept
    expect(self.userId).toBe(A.admin.userId);

    const audit = await t.owner.query(
      `SELECT details FROM security_audit_log WHERE action = 'admin.user.sessions_revoked' AND resource_id = $1`,
      [u.id],
    );
    expect(audit.rows[0].details).toEqual({ revokedCount: 2 }); // 'session*' keys are redacted by the audit writer
    expect((await A.admin.post('/api/admin/users/not-a-uuid/sessions/revoke')).status).toBe(400);
  });

  it('ends every session of the company except the caller; other companies are untouched', async () => {
    const a1 = await staffTwice(A);
    const secondAdmin = await login(t, A.adminEmail, PASSWORD, A.admin.totpSecret!, A.admin.userId!);
    const b1 = await staffTwice(B);
    const noStep = await (
      await login(t, A.adminEmail, PASSWORD, A.admin.totpSecret!, A.admin.userId!)
    ).post('/api/admin/sessions/revoke-all');
    expect(noStep.status).toBe(403);
    expect((await a1.s1.post('/api/admin/sessions/revoke-all')).status).toBe(403);

    await A.admin.stepUp();
    const r = ok(await A.admin.post('/api/admin/sessions/revoke-all'));
    expect(r.revoked).toBeGreaterThanOrEqual(3);
    expect(await alive(A.admin)).toBe(200);
    for (const c of [a1.s1, a1.s2, secondAdmin]) expect(await alive(c)).toBe(401);
    for (const c of [b1.s1, b1.s2, B.admin]) expect(await alive(c)).toBe(200);
    const audit = await t.owner.query(
      `SELECT details FROM security_audit_log WHERE action = 'admin.sessions.revoke_all' AND company_id = $1`,
      [A.companyId],
    );
    expect(audit.rows[0].details.revokedCount).toBe(r.revoked);
  });
});

describe('Session lifetimes (V7.3.1 / V7.3.2)', () => {
  it('sets idle (30 min) and absolute (12 h) limits at creation and refuses a session past either one', async () => {
    const u = await staffTwice(B);
    const [s] = (
      await t.owner.query(
        `SELECT id, extract(epoch FROM idle_expires_at - last_seen_at)::int AS idle, extract(epoch FROM absolute_expires_at - created_at)::int AS abs
           FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at LIMIT 1`,
        [u.id],
      )
    ).rows;
    expect(s.idle).toBeLessThanOrEqual(30 * 60 + 5);
    expect(s.abs).toBeLessThanOrEqual(12 * 3600 + 5);
    expect(s.abs).toBeGreaterThan(11 * 3600);

    const ids = (await t.owner.query('SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at', [u.id])).rows;
    await t.owner.query(`UPDATE sessions SET idle_expires_at = now() - interval '1 second' WHERE id = $1`, [ids[0].id]);
    await t.owner.query(`UPDATE sessions SET absolute_expires_at = now() - interval '1 second' WHERE id = $1`, [ids[1].id]);
    expect(await alive(u.s1)).toBe(401);
    expect(await alive(u.s2)).toBe(401);
  });
});

describe('Fetch Metadata and logout hygiene', () => {
  it('refuses cross-site requests even for reads (exports included); same-origin and non-browser clients pass', async () => {
    const cross = await B.admin.get('/api/auth/session', { 'sec-fetch-site': 'cross-site' });
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('FORBIDDEN');
    expect((await B.admin.get(`/api/wms/w/${B.wh.W1}/reports/stock.csv`, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/health', headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
    expect(await alive(B.admin)).toBe(200);
    expect((await B.admin.get('/api/auth/session', { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    // ASVS 5.0 V13.4.4: TRACE is not routed.
    expect([404, 405]).toContain((await t.app.inject({ method: 'TRACE', url: '/api/health' })).statusCode);
  });

  it('logout revokes the session and sends Clear-Site-Data', async () => {
    const c = await login(t, B.adminEmail, PASSWORD, B.admin.totpSecret!, B.admin.userId!);
    const r = await c.post('/api/auth/logout');
    expect(r.status).toBe(200);
    expect(r.headers['clear-site-data']).toBe('"cache", "storage"');
    expect(await alive(c)).toBe(401);
  });
});

describe('Recovery codes (V6.5.2)', () => {
  it('new codes carry 120 bits (6 groups); a legacy 80-bit code issued before v0.6.6 still works exactly once', async () => {
    const email = `rc-${randomBytes(4).toString('hex')}@example.test`;
    const r = ok(
      await B.admin.post('/api/admin/users', { email, displayName: 'Rec', role: 'STAFF', warehouseId: B.wh.W1, permissions: ['wms.view'] }),
    );
    const { recoveryCodes } = await enroll(t, r.invitationToken, PASSWORD);
    for (const c of recoveryCodes) expect(c).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}$/);

    const legacy = 'ABCD-EFGH-IJKL-MNOP';
    await t.owner.query('INSERT INTO mfa_recovery_codes (user_id, company_id, code_hash) VALUES ($1, $2, $3)', [
      r.id,
      B.companyId,
      createHash('sha256').update(legacy).digest(),
    ]);
    const c1 = new Client(t);
    c1.csrf = ok(await c1.post('/api/auth/login', { email, password: PASSWORD })).csrfToken;
    expect((await c1.post('/api/auth/mfa/verify', { recoveryCode: legacy.toLowerCase() })).status).toBe(200);
    const c2 = new Client(t);
    c2.csrf = ok(await c2.post('/api/auth/login', { email, password: PASSWORD })).csrfToken;
    expect((await c2.post('/api/auth/mfa/verify', { recoveryCode: legacy })).status).toBe(401);
    expect((await c2.post('/api/auth/mfa/verify', { recoveryCode: 'ABCD-EFGH-IJKL' })).status).toBe(400);
  });
});
