/**
 * @file Passkeys (WebAuthn) and self-service account security against real PostgreSQL and the
 * real @simplewebauthn verification: registration with step-up, passkey login, replay,
 * phishing (wrong origin / RP id), tampering, cross-user credentials, the admin passkey policy,
 * password change, own-session management and recovery-code regeneration.
 * @module tests/security
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, enroll, freshTotp, login, ok, PASSWORD, staff, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';
import { SoftAuthenticator } from '../helpers/soft-authenticator.js';

let t: TestApp;
let A: Tenant;

/** Registers a passkey for a logged-in client (performs TOTP step-up first). */
async function registerPasskey(c: Client, auth: SoftAuthenticator, name = 'Portátil') {
  await c.stepUp();
  const opts = ok(await c.post('/api/auth/passkeys/register/options'));
  return ok(await c.post('/api/auth/passkeys/register', { response: auth.register(opts), name }));
}

/** Password step of login only; returns client in MFA_PENDING state. */
async function passwordOnly(email: string, password = PASSWORD) {
  const c = new Client(t);
  c.csrf = ok(await c.post('/api/auth/login', { email, password })).csrfToken;
  return c;
}

/** Full passkey login; returns the response of the verify call. */
async function passkeyLogin(c: Client, auth: SoftAuthenticator, overrides: Parameters<SoftAuthenticator['assert']>[1] = {}) {
  const opts = ok(await c.post('/api/auth/mfa/passkey/options'));
  return c.post('/api/auth/mfa/passkey/verify', { response: auth.assert(opts, overrides) });
}

beforeAll(async () => {
  t = await startApp();
  A = await tenant(t, 'PK', ['W1']);
});
afterAll(async () => {
  await t?.close();
});

describe('Passkeys (WebAuthn)', () => {
  const key = new SoftAuthenticator();

  it('registration requires a recent step-up', async () => {
    const r = await A.admin.post('/api/auth/passkeys/register/options');
    // tenant() login happened moments ago without step-up
    expect([403]).toContain(r.status);
    expect(r.body.error.code).toBe('STEP_UP_REQUIRED');
  });

  it('registers a passkey and lists it without key material', async () => {
    const r = await registerPasskey(A.admin, key);
    expect(r.name).toBe('Portátil');
    const list = ok(await A.admin.get('/api/auth/passkeys'));
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(/public_?key|credential_id/i);
    const audit = ok(await A.admin.get('/api/admin/audit?limit=10'));
    expect(audit.some((e: { action: string }) => e.action === 'auth.passkey.register')).toBe(true);
  });

  it('logs in with password + passkey (session rotated, usable)', async () => {
    const c = await passwordOnly(A.adminEmail);
    const r = await passkeyLogin(c, key);
    expect(r.status).toBe(200);
    c.csrf = r.body.csrfToken;
    expect(ok(await c.get('/api/auth/session')).user.role).toBe('ADMIN');
  });

  it('rejects replayed assertions (challenge is single-use)', async () => {
    const c = await passwordOnly(A.adminEmail);
    const opts = ok(await c.post('/api/auth/mfa/passkey/options'));
    const assertion = key.assert(opts);
    expect((await c.post('/api/auth/mfa/passkey/verify', { response: assertion })).status).toBe(200);
    const c2 = await passwordOnly(A.adminEmail);
    ok(await c2.post('/api/auth/mfa/passkey/options'));
    expect((await c2.post('/api/auth/mfa/passkey/verify', { response: assertion })).status).toBe(401);
  });

  it('rejects expired challenges and challenges issued for another purpose', async () => {
    const c = await passwordOnly(A.adminEmail);
    const opts = ok(await c.post('/api/auth/mfa/passkey/options'));
    await t.owner.query(
      `UPDATE sessions SET webauthn_challenge_expires_at = now() - interval '1 second' WHERE webauthn_challenge IS NOT NULL`,
    );
    const expired = await c.post('/api/auth/mfa/passkey/verify', { response: key.assert(opts) });
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe('PASSKEY_CHALLENGE_INVALID');
    // A step-up challenge cannot be used to complete a registration.
    const so = ok(await A.admin.post('/api/auth/step-up/passkey/options'));
    await A.admin.stepUp();
    const bad = await A.admin.post('/api/auth/passkeys/register', { response: new SoftAuthenticator().register(so), name: 'x' });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('PASSKEY_CHALLENGE_INVALID');
  });

  it('rejects phishing origin, wrong RP id and tampered signatures', async () => {
    for (const o of [{ origin: 'https://autolemon-login.example' }, { rpId: 'evil.example' }, { tamper: true }]) {
      const c = await passwordOnly(A.adminEmail);
      expect((await passkeyLogin(c, key, o)).status, JSON.stringify(o)).toBe(401);
    }
  });

  it("rejects another user's passkey and passkeys of unknown credentials", async () => {
    const other = await staff(t, A, A.wh.W1!, ['wms.view']);
    const otherKey = new SoftAuthenticator();
    await registerPasskey(other, otherKey);
    const c = await passwordOnly(A.adminEmail);
    expect((await passkeyLogin(c, otherKey)).status).toBe(401);
    const stranger = new SoftAuthenticator();
    const c2 = await passwordOnly(A.adminEmail);
    expect((await passkeyLogin(c2, stranger)).status).toBe(401);
  });

  it('passkey endpoints for the pending session need its CSRF token', async () => {
    const c = await passwordOnly(A.adminEmail);
    expect((await c.post('/api/auth/mfa/passkey/options', {}, { 'x-csrf-token': 'nope' })).status).toBe(403);
  });

  it('steps up with a passkey', async () => {
    const opts = ok(await A.admin.post('/api/auth/step-up/passkey/options'));
    expect((await A.admin.post('/api/auth/step-up/passkey', { response: key.assert(opts) })).status).toBe(200);
  });

  it("an administrator's MFA reset (lost device) also revokes the user's passkeys", async () => {
    const victim = await staff(t, A, A.wh.W1!, ['wms.view']);
    const lost = new SoftAuthenticator();
    await registerPasskey(victim, lost, 'Telemóvel perdido');
    await A.admin.stepUp();
    ok(await A.admin.post(`/api/admin/users/${victim.userId}/mfa-reset`));
    const pk = await t.owner.query('SELECT count(*)::int AS n FROM webauthn_credentials WHERE user_id = $1 AND revoked_at IS NULL', [
      victim.userId,
    ]);
    expect(pk.rows[0].n).toBe(0);
    expect((await victim.get('/api/auth/session')).status).toBe(401);
  });

  it('revokes a passkey (step-up) and the revoked key no longer logs in', async () => {
    const extra = new SoftAuthenticator();
    const reg = await registerPasskey(A.admin, extra, 'Chave USB');
    ok(await A.admin.post(`/api/auth/passkeys/${reg.id}/revoke`));
    const c = await passwordOnly(A.adminEmail);
    expect((await passkeyLogin(c, extra)).status).toBe(401);
  });
});

describe('Admin passkey policy (ADMIN_PASSKEY_REQUIRED=true)', () => {
  let p: TestApp;
  let P: Tenant;
  const key = new SoftAuthenticator();
  beforeAll(async () => {
    p = await startApp({ ADMIN_PASSKEY_REQUIRED: 'true' });
    P = await tenant(p, 'POL', ['W1']);
  });
  afterAll(async () => {
    await p?.close();
  });

  it('an admin without a passkey can only reach account-security routes', async () => {
    const s = ok(await P.admin.get('/api/auth/session'));
    expect(s.security.mustRegisterPasskey).toBe(true);
    const blocked = await P.admin.get(`/api/wms/w/${P.wh.W1}/stock`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSKEY_REGISTRATION_REQUIRED');
    expect((await P.admin.get('/api/admin/users')).status).toBe(403);
  });

  it('after registering a passkey the admin is unblocked; TOTP is no longer accepted for login or step-up', async () => {
    await P.admin.stepUp(); // TOTP step-up allowed while no passkey exists (bootstrap)
    const opts = ok(await P.admin.post('/api/auth/passkeys/register/options'));
    ok(await P.admin.post('/api/auth/passkeys/register', { response: key.register(opts), name: 'Admin key' }));
    expect((await P.admin.get(`/api/wms/w/${P.wh.W1}/stock`)).status).toBe(200);

    const c = new Client(p);
    c.csrf = ok(await c.post('/api/auth/login', { email: P.adminEmail, password: PASSWORD })).csrfToken;
    const totp = await c.post('/api/auth/mfa/verify', { code: await freshTotp(p, P.admin.userId!, P.admin.totpSecret!) });
    expect(totp.status).toBe(403);
    expect(totp.body.error.code).toBe('PASSKEY_REQUIRED');
    const optsLogin = ok(await c.post('/api/auth/mfa/passkey/options'));
    expect((await c.post('/api/auth/mfa/passkey/verify', { response: key.assert(optsLogin) })).status).toBe(200);

    const step = await P.admin.post('/api/auth/step-up', { code: await freshTotp(p, P.admin.userId!, P.admin.totpSecret!) });
    expect(step.body.error.code).toBe('PASSKEY_REQUIRED');
  });

  it('the last passkey cannot be removed under the policy', async () => {
    const so = ok(await P.admin.post('/api/auth/step-up/passkey/options'));
    ok(await P.admin.post('/api/auth/step-up/passkey', { response: key.assert(so) }));
    const list = ok(await P.admin.get('/api/auth/passkeys'));
    const r = await P.admin.post(`/api/auth/passkeys/${list[0].id}/revoke`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('LAST_PASSKEY');
  });

  it('staff are not affected by the admin policy', async () => {
    const s = await staff(p, P, P.wh.W1!, ['wms.view']);
    expect((await s.get(`/api/wms/w/${P.wh.W1}/stock`)).status).toBe(200);
  });
});

describe('Self-service account security', () => {
  it('changes password: wrong current → 401, weak → 400, success revokes other sessions only', async () => {
    const email = `acct-${randomBytes(3).toString('hex')}@example.test`;
    const created = ok(
      await A.admin.post('/api/admin/users', {
        email,
        displayName: 'Conta',
        role: 'STAFF',
        warehouseId: A.wh.W1,
        permissions: ['wms.view'],
      }),
    );
    const { secret } = await enroll(t, created.invitationToken, PASSWORD);
    const c1 = await login(t, email, PASSWORD, secret, created.id);
    const c2 = await login(t, email, PASSWORD, secret, created.id);
    expect(
      (await c1.post('/api/auth/password/change', { currentPassword: 'wrong-password-123', newPassword: 'outra frase muito longa 42' }))
        .status,
    ).toBe(401);
    expect((await c1.post('/api/auth/password/change', { currentPassword: PASSWORD, newPassword: 'password1234' })).status).toBe(400);
    expect((await c1.post('/api/auth/password/change', { currentPassword: PASSWORD, newPassword: PASSWORD })).status).toBe(400);
    const r = ok(await c1.post('/api/auth/password/change', { currentPassword: PASSWORD, newPassword: 'outra frase muito longa 42' }));
    expect(r.otherSessionsRevoked).toBeGreaterThanOrEqual(1);
    expect((await c1.get('/api/auth/session')).status).toBe(200);
    expect((await c2.get('/api/auth/session')).status).toBe(401);
    expect((await new Client(t).post('/api/auth/login', { email, password: PASSWORD })).status).toBe(401);
    await login(t, email, 'outra frase muito longa 42', secret, created.id);
  });

  it("lists own sessions, revokes one, refuses other users' sessions, signs out others", async () => {
    const second = await login(t, A.adminEmail, PASSWORD, A.admin.totpSecret!, A.admin.userId!).catch(() => undefined);
    const list = ok(await A.admin.get('/api/auth/sessions'));
    expect(list.some((s: { current: boolean }) => s.current)).toBe(true);
    expect(JSON.stringify(list)).not.toMatch(/token|csrf/i);
    const otherUser = await staff(t, A, A.wh.W1!, ['wms.view']);
    const theirs = ok(await otherUser.get('/api/auth/sessions'))[0].id;
    expect((await A.admin.post(`/api/auth/sessions/${theirs}/revoke`)).status).toBe(404);
    const mine = ok(await otherUser.post(`/api/auth/sessions/${theirs}/revoke`));
    expect(mine.revoked).toBe(true);
    expect((await otherUser.get('/api/auth/session')).status).toBe(401);
    const res = ok(await A.admin.post('/api/auth/sessions/revoke-others'));
    expect(res.revoked).toBeGreaterThanOrEqual(0);
    expect((await A.admin.get('/api/auth/session')).status).toBe(200);
    if (second) expect((await second.get('/api/auth/session')).status).toBe(401);
  });

  it('regenerates recovery codes with step-up; old codes stop working', async () => {
    const email = `rc-${randomBytes(3).toString('hex')}@example.test`;
    const created = ok(
      await A.admin.post('/api/admin/users', { email, displayName: 'RC', role: 'STAFF', warehouseId: A.wh.W1, permissions: ['wms.view'] }),
    );
    const { secret, recoveryCodes: oldCodes } = await enroll(t, created.invitationToken, PASSWORD);
    const c = await login(t, email, PASSWORD, secret, created.id);
    expect((await c.post('/api/auth/recovery-codes/regenerate')).status).toBe(403);
    await c.stepUp();
    const fresh = ok(await c.post('/api/auth/recovery-codes/regenerate')).recoveryCodes as string[];
    expect(fresh).toHaveLength(10);
    const p1 = await passwordOnly(email);
    expect((await p1.post('/api/auth/mfa/verify', { recoveryCode: oldCodes[0] })).status).toBe(401);
    const p2 = await passwordOnly(email);
    expect((await p2.post('/api/auth/mfa/verify', { recoveryCode: fresh[0] })).status).toBe(200);
  });
});
