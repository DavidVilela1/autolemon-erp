/**
 * @file Route-inventory authorization test (review findings R-18/R-21). Iterates EVERY route of
 * docs/api/openapi.json — which `pnpm api:check` proves is generated from the live controller
 * metadata — and checks the cross-cutting controls for each one, so a new route cannot ship
 * without them:
 *   1. anonymous callers are refused on every non-public route (no 2xx, no 5xx);
 *   2. an authenticated session without the CSRF token is refused on every mutating route;
 *   3. a staff user scoped to warehouse W1 is refused on every warehouse route for W2, and on
 *      every administration route;
 *   4. the documented public routes are exactly the expected set.
 * @module tests/security
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, staff, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

interface Route {
  method: 'get' | 'post' | 'put';
  path: string;
  isPublic: boolean;
}

const spec = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../docs/api/openapi.json'), 'utf8')) as {
  paths: Record<string, Record<string, { security: unknown[] }>>;
};
const ROUTES: Route[] = Object.entries(spec.paths).flatMap(([path, ops]) =>
  Object.entries(ops).map(([method, op]) => ({ method: method as Route['method'], path, isPublic: op.security.length === 0 })),
);

let t: TestApp;
let A: Tenant;
let scoped: Client;

/** Fills path parameters: {wh} with the given warehouse, everything else with a random UUID. */
const fill = (path: string, wh: string) => path.replace('{wh}', wh).replace(/\{\w+\}/g, () => randomUUID());
const call = (c: Client, r: Route, url: string, headers?: Record<string, string>) =>
  r.method === 'get' ? c.get(url, headers) : c.request(r.method.toUpperCase(), url, {}, headers);

beforeAll(async () => {
  t = await startApp();
  A = await tenant(t, 'INV', ['W1', 'W2']);
  // Broad WMS permissions, but only for W1.
  scoped = await staff(t, A, A.wh.W1!, [
    'wms.view',
    'wms.receive',
    'wms.putaway',
    'wms.pick',
    'wms.pack',
    'wms.dispatch',
    'wms.transfer.dispatch',
    'wms.transfer.receive',
    'wms.returns',
    'wms.count',
    'wms.inbound.manage',
    'wms.outbound.manage',
    'wms.report',
    'wms.replenish',
    'wms.topology.manage',
  ]);
});
afterAll(async () => {
  await t?.close();
});

describe(`Route inventory (${ROUTES.length} operations)`, () => {
  it('has exactly the expected public routes', () => {
    expect(
      ROUTES.filter((r) => r.isPublic)
        .map((r) => `${r.method.toUpperCase()} ${r.path}`)
        .sort(),
    ).toEqual([
      'GET /api/health',
      'POST /api/auth/enrollment/confirm',
      'POST /api/auth/enrollment/start',
      'POST /api/auth/login',
      'POST /api/auth/logout',
      'POST /api/auth/mfa/passkey/options',
      'POST /api/auth/mfa/passkey/verify',
      'POST /api/auth/mfa/verify',
      'POST /api/auth/password/reset',
    ]);
  });

  it('refuses anonymous callers on every non-public route', async () => {
    const anon = new Client(t);
    const bad: string[] = [];
    for (const r of ROUTES.filter((x) => !x.isPublic)) {
      const res = await call(anon, r, fill(r.path, A.wh.W1!));
      if (![401, 403].includes(res.status)) bad.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  it('refuses every mutating route without the CSRF token, even with a valid session', async () => {
    const bad: string[] = [];
    for (const r of ROUTES.filter((x) => !x.isPublic && x.method !== 'get')) {
      const res = await call(A.admin, r, fill(r.path, A.wh.W1!), { 'x-csrf-token': 'invalid' });
      if (res.status !== 403) bad.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  it('refuses a W1-scoped user on every route of warehouse W2 and on every admin route', async () => {
    const bad: string[] = [];
    for (const r of ROUTES.filter((x) => x.path.includes('{wh}') || x.path.startsWith('/api/admin/'))) {
      const res = await call(scoped, r, fill(r.path, A.wh.W2!));
      if (![403, 404].includes(res.status)) bad.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  it('never answers 5xx to a malformed identifier on any authenticated route', async () => {
    const bad: string[] = [];
    for (const r of ROUTES.filter((x) => !x.isPublic && /\{(?!wh\})\w+\}/.test(x.path))) {
      const url = r.path.replace('{wh}', A.wh.W1!).replace(/\{\w+\}/g, "1' OR '1'='1");
      const res = await call(A.admin, r, url);
      if (res.status >= 500) bad.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(bad).toEqual([]);
  });
});
