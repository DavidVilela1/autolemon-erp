/**
 * @file Integration test harness: boots the real API (NestJS + Fastify) against the disposable
 * PostgreSQL database and drives it through HTTP (Fastify inject, real routing/guards/filters).
 * @module tests
 *
 * Test-only shortcut (documented): TOTP replay protection makes it impossible to use the same
 * 30-second time step twice. `freshTotp()` resets `last_used_step` with the OWNER connection so
 * tests do not need to sleep 30 s between MFA uses. Replay protection itself is tested
 * separately without this helper.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { loadConfig } from '../../apps/api/src/config/env.js';
import { createApp, type CreatedApp } from '../../apps/api/src/app.js';
import { totpNow } from '../../apps/api/src/platform/auth/totp.js';
import { provisionTenant } from '../../apps/api/src/platform/tenant/provision.js';

/** Test environment configuration (generated secrets are fine for tests). */
export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    ...process.env,
    LOCAL_DEV_KEKS: process.env.TEST_KEKS ?? `test-kek-a:${randomBytes(32).toString('base64')}`,
    CSRF_SECRET: randomBytes(32).toString('base64'),
    WEB_ORIGIN: 'http://localhost:5173',
    COOKIE_SECURE: 'true',
    ...overrides,
  } as Record<string, string>);
}

/** Running test app. */
export interface TestApp extends CreatedApp {
  owner: pg.Pool;
  close(): Promise<void>;
}

/** Starts the application. */
export async function startApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const created = await createApp(testConfig(overrides));
  const owner = new pg.Pool({ connectionString: process.env.TEST_OWNER_URL, max: 2 });
  return {
    ...created,
    owner,
    async close() {
      await created.app.close();
      await created.services.database.close();
      await owner.end();
    },
  };
}

/** HTTP response shape returned by the client. */
export interface Res<T = any> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

/** Minimal browser-like client: cookie jar, CSRF header, Origin, idempotency keys. */
export class Client {
  cookie: string | undefined;
  csrf: string | undefined;
  totpSecret: string | undefined;
  userId: string | undefined;
  extraHeaders: Record<string, string> = {};

  constructor(private readonly t: TestApp) {}

  async request<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const mutating = !['GET', 'HEAD'].includes(method);
    const h: Record<string, string> = {
      ...(mutating ? { origin: 'http://localhost:5173', 'x-requested-with': 'autolemon' } : {}),
      ...(mutating && this.csrf ? { 'x-csrf-token': this.csrf } : {}),
      ...(mutating && url.includes('/api/wms/') ? { 'idempotency-key': `t-${randomBytes(12).toString('hex')}` } : {}),
      ...(this.cookie ? { cookie: this.cookie } : {}),
      ...this.extraHeaders,
      ...headers,
    };
    const isText = typeof body === 'string';
    if (body !== undefined && !h['content-type']) h['content-type'] = isText ? 'text/csv' : 'application/json';
    const res = await this.t.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: method as 'GET',
        url,
        headers: h,
        ...(body !== undefined ? { payload: isText ? (body as string) : JSON.stringify(body) } : {}),
      });
    const setCookie = res.headers['set-cookie'];
    for (const c of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const pair = String(c).split(';')[0]!;
      this.cookie = pair.endsWith('=') ? undefined : pair;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      parsed = undefined;
    }
    return { status: res.statusCode, body: parsed as T, headers: res.headers as Res['headers'], text: res.body };
  }
  get<T = any>(url: string, headers?: Record<string, string>) {
    return this.request<T>('GET', url, undefined, headers);
  }
  post<T = any>(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>('POST', url, body ?? {}, headers);
  }
  put<T = any>(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>('PUT', url, body ?? {}, headers);
  }

  /** Performs step-up MFA with a fresh code. */
  async stepUp(): Promise<void> {
    const r = await this.post('/api/auth/step-up', { code: await freshTotp(this.t, this.userId!, this.totpSecret!) });
    if (r.status !== 200) throw new Error(`step-up failed ${r.status} ${r.text}`);
  }
}

/** Resets replay window (TEST ONLY) and returns the current TOTP code. */
export async function freshTotp(t: TestApp, userId: string, secret: string): Promise<string> {
  await t.owner.query('UPDATE mfa_totp SET last_used_step = 0 WHERE user_id = $1', [userId]);
  return totpNow(secret);
}

/** Completes invitation enrolment through the public API; returns TOTP secret. */
export async function enroll(t: TestApp, token: string, password: string): Promise<{ secret: string; recoveryCodes: string[] }> {
  const anon = new Client(t);
  const start = await anon.post('/api/auth/enrollment/start', { token, password });
  if (start.status !== 200) throw new Error(`enrollment/start ${start.status} ${start.text}`);
  const confirm = await anon.post('/api/auth/enrollment/confirm', { token, code: totpNow(start.body.secret) });
  if (confirm.status !== 200) throw new Error(`enrollment/confirm ${confirm.status} ${confirm.text}`);
  return { secret: start.body.secret, recoveryCodes: confirm.body.recoveryCodes };
}

/** Logs in (password + TOTP) and returns an authenticated client. */
export async function login(t: TestApp, email: string, password: string, secret: string, userId: string): Promise<Client> {
  const c = new Client(t);
  const r1 = await c.post('/api/auth/login', { email, password });
  if (r1.status !== 200) throw new Error(`login ${r1.status} ${r1.text}`);
  c.csrf = r1.body.csrfToken;
  const r2 = await c.post('/api/auth/mfa/verify', { code: await freshTotp(t, userId, secret) });
  if (r2.status !== 200) throw new Error(`mfa ${r2.status} ${r2.text}`);
  c.csrf = r2.body.csrfToken;
  c.totpSecret = secret;
  c.userId = userId;
  return c;
}

/** A provisioned tenant with an enrolled, logged-in admin. */
export interface Tenant {
  companyId: string;
  wh: Record<string, string>;
  admin: Client;
  adminEmail: string;
}

export const PASSWORD = 'Correct-Horse-Battery-77!';

/** Provisions a tenant through the operator path and logs its admin in. */
export async function tenant(t: TestApp, code: string, warehouses: string[]): Promise<Tenant> {
  const email = `admin-${code.toLowerCase()}-${randomBytes(3).toString('hex')}@example.test`;
  const p = await provisionTenant(t.services.database, t.services.auth, {
    code: `${code}-${randomBytes(3).toString('hex').toUpperCase()}`,
    name: `Empresa ${code}`,
    adminEmail: email,
    adminName: `Admin ${code}`,
    warehouses: warehouses.map((w) => ({ code: w, name: `Armazém ${w}` })),
  });
  const { secret } = await enroll(t, p.invitationToken, PASSWORD);
  const admin = await login(t, email, PASSWORD, secret, p.adminId);
  return { companyId: p.companyId, wh: p.warehouses, admin, adminEmail: email };
}

/** Creates, enrols and logs in a staff user bound to one warehouse. */
export async function staff(t: TestApp, tn: Tenant, warehouseId: string, permissions: string[]): Promise<Client> {
  const email = `staff-${randomBytes(4).toString('hex')}@example.test`;
  const r = await tn.admin.post('/api/admin/users', { email, displayName: 'Operador Teste', role: 'STAFF', warehouseId, permissions });
  if (r.status !== 201) throw new Error(`create staff ${r.status} ${r.text}`);
  const { secret } = await enroll(t, r.body.invitationToken, PASSWORD);
  return login(t, email, PASSWORD, secret, r.body.id);
}

/** Asserts a 2xx response and returns its body. */
export function ok<T = any>(r: Res<T>, label = ''): T {
  if (r.status < 200 || r.status >= 300) throw new Error(`${label} expected 2xx, got ${r.status}: ${r.text}`);
  return r.body;
}

/** Creates a node via API and returns its id. */
export async function node(c: Client, wh: string, kind: string, code: string, parentId?: string): Promise<string> {
  return ok(await c.post(`/api/wms/w/${wh}/nodes`, { kind, code, name: code, ...(parentId ? { parentId } : {}) }), `node ${code}`).id;
}
