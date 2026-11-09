/**
 * @file Scenario 11: attack tests — injection vectors, stored malicious text, CSRF, MFA bypass,
 * session replay, cookie tampering, invalid ids, mass assignment, malicious CSV imports,
 * duplicate commands and simultaneous competing reservations.
 * @module tests/security
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpNow } from '../../apps/api/src/platform/auth/totp.js';
import { Client, enroll, freshTotp, node, ok, PASSWORD, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let A: Tenant;
let wh: string;
let shelf: string;
let disp: string;
let sku: string;

beforeAll(async () => {
  t = await startApp();
  A = await tenant(t, 'ATK', ['W1']);
  wh = A.wh.W1!;
  const z = await node(A.admin, wh, 'ZONE', 'Z');
  const a = await node(A.admin, wh, 'AISLE', 'A', z);
  const r = await node(A.admin, wh, 'RACK', 'R', a);
  shelf = await node(A.admin, wh, 'SHELF', 'S', r);
  disp = await node(A.admin, wh, 'DISPATCH', 'EXP');
  sku = ok(await A.admin.post('/api/wms/skus', { code: 'ATK-1', description: 'Peça' })).id;
  await A.admin.stepUp();
  ok(await A.admin.post(`/api/wms/w/${wh}/stock/opening`, { lines: [{ skuId: sku, to: { nodeId: shelf }, qty: 16 }] }));
});
afterAll(async () => {
  await t?.close();
});

describe('Injection and stored malicious content', () => {
  const vectors = [
    `'; DROP TABLE skus; --`,
    `' OR '1'='1`,
    `<script>alert(document.cookie)</script>`,
    `<img src=x onerror=alert(1)>`,
    `{{constructor.constructor('alert(1)')()}}`,
    `../../etc/passwd`,
    `‮gnp.exe`,
  ];
  it('stores hostile strings verbatim as data and never executes them', async () => {
    for (const [i, v] of vectors.entries()) {
      const r = await A.admin.post('/api/wms/skus', { code: `HOST-${i}`, description: v });
      expect(r.status, v).toBe(201);
    }
    const list = ok(await A.admin.get('/api/wms/skus?q=HOST'));
    expect(list.map((s: { description: string }) => s.description).sort()).toEqual([...vectors].map((v) => v.normalize('NFC')).sort());
    // Table still exists and other rows unaffected.
    expect(ok(await A.admin.get('/api/wms/skus')).length).toBeGreaterThan(vectors.length);
  });

  it('SQL metacharacters in search are treated as literals (no tautology leak)', async () => {
    const r = ok(await A.admin.get(`/api/wms/skus?q=${encodeURIComponent("' OR 1=1 --")}`));
    expect(r).toHaveLength(0);
    const like = ok(await A.admin.get(`/api/wms/skus?q=${encodeURIComponent('%')}`));
    expect(like).toHaveLength(0); // % is escaped, not a wildcard
  });

  it('API responses are JSON with a restrictive CSP and nosniff', async () => {
    const r = await A.admin.get('/api/wms/skus?q=HOST');
    expect(String(r.headers['content-type'])).toContain('application/json');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('rejects control characters, invalid codes and prototype pollution payloads', async () => {
    expect((await A.admin.post('/api/wms/skus', { code: 'OK-1', description: 'a\u0000b' })).status).toBe(400);
    expect((await A.admin.post('/api/wms/skus', { code: '=CMD()', description: 'x' })).status).toBe(400);
    const proto = await A.admin.request('POST', '/api/wms/skus', '{"code":"P-1","description":"x","__proto__":{"admin":true}}', {
      'content-type': 'application/json',
    });
    expect(proto.status).toBe(400);
  });
});

describe('Mass assignment and invalid identifiers', () => {
  it('rejects unknown writable fields (strict schemas)', async () => {
    for (const extra of [{ companyId: A.companyId }, { status: 'BLOCKED' }, { id: '00000000-0000-0000-0000-000000000001' }]) {
      const r = await A.admin.post('/api/wms/skus', { code: 'MA-1', description: 'x', ...extra });
      expect(r.status).toBe(400);
    }
    const u = await A.admin.post('/api/admin/users', {
      email: 'ma@x.test',
      displayName: 'x',
      role: 'STAFF',
      warehouseId: wh,
      permissions: [],
      status: 'ACTIVE',
    });
    expect(u.status).toBe(400);
  });

  it('invalid object ids → 400; unknown ids → 404; oversized/negative quantities → 400', async () => {
    expect((await A.admin.get('/api/wms/w/not-a-uuid/stock')).status).toBe(400);
    expect((await A.admin.get(`/api/wms/w/${wh}/outbound/1%27%20OR%201=1`)).status).toBe(400);
    expect((await A.admin.get(`/api/wms/w/${wh}/outbound/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    for (const qty of [-1, 0, '1e9999', 1.0001, 'NaN', 10_000_000_000]) {
      const r = await A.admin.post(`/api/wms/w/${wh}/outbound`, { lines: [{ skuId: sku, qty }] });
      expect(r.status, String(qty)).toBe(400);
    }
  });
});

describe('CSRF, origin and session attacks', () => {
  it('rejects writes without CSRF token, with wrong origin, cross-site fetch or missing custom header', async () => {
    const body = { code: 'CSRF-1', description: 'x' };
    expect((await A.admin.post('/api/wms/skus', body, { 'x-csrf-token': '' })).status).toBe(403);
    expect((await A.admin.post('/api/wms/skus', body, { 'x-csrf-token': 'forged-token-value' })).status).toBe(403);
    expect((await A.admin.post('/api/wms/skus', body, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await A.admin.post('/api/wms/skus', body, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await A.admin.post('/api/wms/skus', body, { 'x-requested-with': '' })).status).toBe(403);
    expect((await A.admin.post('/api/wms/skus', body)).status).toBe(201);
  });

  it('MFA cannot be bypassed: a password-only session has no access', async () => {
    const c = new Client(t);
    const r = ok(await c.post('/api/auth/login', { email: A.adminEmail, password: PASSWORD }));
    c.csrf = r.csrfToken;
    expect((await c.get('/api/auth/session')).status).toBe(401);
    expect((await c.get(`/api/wms/w/${wh}/stock`)).status).toBe(401);
    expect((await c.post('/api/wms/skus', { code: 'MFA-1', description: 'x' })).status).toBe(401);
    expect((await c.post('/api/auth/step-up', { code: '000000' })).status).toBe(401);
  });

  it('pending MFA session is revoked after 5 wrong codes', async () => {
    const c = new Client(t);
    c.csrf = ok(await c.post('/api/auth/login', { email: A.adminEmail, password: PASSWORD })).csrfToken;
    for (let i = 0; i < 5; i++) expect((await c.post('/api/auth/mfa/verify', { code: '000000' })).status).toBe(401);
    const right = await c.post('/api/auth/mfa/verify', { code: await freshTotp(t, A.admin.userId!, A.admin.totpSecret!) });
    expect(right.status).toBe(401);
  });

  it('TOTP codes cannot be replayed', async () => {
    const code = await freshTotp(t, A.admin.userId!, A.admin.totpSecret!);
    const c1 = new Client(t);
    c1.csrf = ok(await c1.post('/api/auth/login', { email: A.adminEmail, password: PASSWORD })).csrfToken;
    expect((await c1.post('/api/auth/mfa/verify', { code })).status).toBe(200);
    const c2 = new Client(t);
    c2.csrf = ok(await c2.post('/api/auth/login', { email: A.adminEmail, password: PASSWORD })).csrfToken;
    expect((await c2.post('/api/auth/mfa/verify', { code })).status).toBe(401);
  });

  it('session cookie is HttpOnly/Secure/SameSite=Strict, rotates on MFA, and dies on logout (no replay)', async () => {
    const c = new Client(t);
    const r1 = await c.post('/api/auth/login', { email: A.adminEmail, password: PASSWORD });
    const sc = String(r1.headers['set-cookie']);
    expect(sc).toMatch(/__Host-al_sid=/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    const pendingCookie = c.cookie;
    c.csrf = r1.body.csrfToken;
    ok(await c.post('/api/auth/mfa/verify', { code: await freshTotp(t, A.admin.userId!, A.admin.totpSecret!) }));
    expect(c.cookie).not.toBe(pendingCookie); // rotated
    const active = c.cookie;
    ok(await c.post('/api/auth/logout'));
    const replay = new Client(t);
    replay.cookie = active;
    expect((await replay.get('/api/auth/session')).status).toBe(401);
    const pend = new Client(t);
    pend.cookie = pendingCookie;
    expect((await pend.get('/api/auth/session')).status).toBe(401);
  });

  it('tampered or forged cookies are rejected', async () => {
    const forged = new Client(t);
    forged.cookie = `${A.admin.cookie!.slice(0, -2)}xx`;
    expect((await forged.get('/api/auth/session')).status).toBe(401);
    forged.cookie = '__Host-al_sid=../../etc/passwd';
    expect((await forged.get('/api/auth/session')).status).toBe(401);
    forged.cookie = `__Host-al_sid=${'A'.repeat(5000)}`;
    expect([400, 401, 431]).toContain((await forged.get('/api/auth/session')).status);
  });

  it('login: same response for unknown user and wrong password; throttled after repeated failures', async () => {
    const c = new Client(t);
    const unknown = await c.post('/api/auth/login', { email: 'nobody@nowhere.test', password: 'whatever-password-1' });
    const wrong = await c.post('/api/auth/login', { email: A.adminEmail, password: 'wrong-password-123' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error).toEqual(wrong.body.error);
    for (let i = 0; i < 5; i++) await c.post('/api/auth/login', { email: 'victim@x.test', password: `bad-guess-${i}-xxxx` });
    const locked = await c.post('/api/auth/login', { email: 'victim@x.test', password: 'bad-guess-final-xx' });
    expect(locked.status).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
  });

  it('recovery codes work exactly once and are audited as an alert', async () => {
    const r = ok(
      await A.admin.post('/api/admin/users', {
        email: 'rec@x.test',
        displayName: 'Rec',
        role: 'STAFF',
        warehouseId: wh,
        permissions: ['wms.view'],
      }),
    );
    const { recoveryCodes } = await enroll(t, r.invitationToken, PASSWORD);
    const c = new Client(t);
    c.csrf = ok(await c.post('/api/auth/login', { email: 'rec@x.test', password: PASSWORD })).csrfToken;
    expect((await c.post('/api/auth/mfa/verify', { recoveryCode: recoveryCodes[0] })).status).toBe(200);
    const c2 = new Client(t);
    c2.csrf = ok(await c2.post('/api/auth/login', { email: 'rec@x.test', password: PASSWORD })).csrfToken;
    expect((await c2.post('/api/auth/mfa/verify', { recoveryCode: recoveryCodes[0] })).status).toBe(401);
    const audit = ok(await A.admin.get('/api/admin/audit?limit=30'));
    expect(audit.some((e: { action: string }) => e.action === 'auth.login.recovery_code_used')).toBe(true);
  });

  it('invitation tokens are single-use; weak/common passwords are refused', async () => {
    const r = ok(
      await A.admin.post('/api/admin/users', { email: 'inv@x.test', displayName: 'Inv', role: 'STAFF', warehouseId: wh, permissions: [] }),
    );
    const anon = new Client(t);
    expect((await anon.post('/api/auth/enrollment/start', { token: r.invitationToken, password: 'password1234' })).status).toBe(400);
    expect((await anon.post('/api/auth/enrollment/start', { token: r.invitationToken, password: 'short' })).status).toBe(400);
    const s = ok(await anon.post('/api/auth/enrollment/start', { token: r.invitationToken, password: PASSWORD }));
    ok(await anon.post('/api/auth/enrollment/confirm', { token: r.invitationToken, code: totpNow(s.secret) }));
    expect((await anon.post('/api/auth/enrollment/start', { token: r.invitationToken, password: PASSWORD })).status).toBe(404);
  });

  it('deactivation and permission changes revoke sessions immediately', async () => {
    const r = ok(
      await A.admin.post('/api/admin/users', {
        email: 'deact@x.test',
        displayName: 'D',
        role: 'STAFF',
        warehouseId: wh,
        permissions: ['wms.view'],
      }),
    );
    const { secret } = await enroll(t, r.invitationToken, PASSWORD);
    const c = new Client(t);
    c.csrf = ok(await c.post('/api/auth/login', { email: 'deact@x.test', password: PASSWORD })).csrfToken;
    c.csrf = ok(await c.post('/api/auth/mfa/verify', { code: await freshTotp(t, r.id, secret) })).csrfToken;
    expect((await c.get(`/api/wms/w/${wh}/stock`)).status).toBe(200);
    ok(await A.admin.put(`/api/admin/users/${r.id}/permissions`, { permissions: ['wms.view', 'wms.receive'] }));
    expect((await c.get(`/api/wms/w/${wh}/stock`)).status).toBe(401);
  });
});

describe('Malicious CSV / file imports', () => {
  it('rejects formula injection, binary content, bad headers, oversized and malformed files (all-or-nothing)', async () => {
    const cases: Array<[string, string]> = [
      ['formula', 'code,description\nCSV-1,=HYPERLINK("http://evil","x")\n'],
      ['formula-at', 'code,description\nCSV-2,@SUM(1+1)\n'],
      ['binary', 'code,description\nCSV-3,a\u0000b\n'],
      ['header', 'code,description,price\nCSV-4,x,1\n'],
      ['quotes', 'code,description\n"CSV-5,unterminated\n'],
      ['cols', `code,description\n${Array.from({ length: 20 }, () => 'x').join(',')}\n`],
      ['big', `code,description\n${'CSV-6,' + 'a'.repeat(1_100_000)}\n`],
    ];
    for (const [label, body] of cases) {
      const r = await A.admin.post('/api/wms/skus/import', body);
      expect([400, 413], label).toContain(r.status);
    }
    // A mixed file with one bad row imports nothing.
    const mixed = await A.admin.post('/api/wms/skus/import', 'code,description\nCSV-OK-1,Bom\nCSV-BAD,+cmd\n');
    expect(mixed.status).toBe(400);
    expect(ok(await A.admin.get('/api/wms/skus?q=CSV-OK')).length).toBe(0);
    const good = ok(
      await A.admin.post(
        '/api/wms/skus/import',
        String.fromCharCode(0xfeff) + 'code;description;barcode\nCSV-OK-1;"Filtro; ""premium""";5609999999990\n',
      ),
    );
    expect(good.imported).toBe(1);
    expect(ok(await A.admin.get('/api/wms/skus?q=CSV-OK'))[0].description).toBe('Filtro; "premium"');
  });

  it('exported CSV neutralises formula-leading cells', async () => {
    ok(await A.admin.post('/api/wms/skus', { code: 'EXP-1', description: '-2+3+cmd|calc' }));
    const id = ok(await A.admin.get('/api/wms/skus?q=EXP-1'))[0].id;
    ok(await A.admin.post(`/api/wms/w/${wh}/stock/opening`, { lines: [{ skuId: id, to: { nodeId: shelf }, qty: 1 }] }));
    await A.admin.stepUp();
    const csv = (await A.admin.get(`/api/wms/w/${wh}/reports/stock.csv`)).text;
    expect(csv).toContain(`"'-2+3+cmd|calc"`);
  });
});

describe('Idempotency and concurrency', () => {
  it('duplicate command with the same Idempotency-Key moves stock once; different payload → 409', async () => {
    const key = 'dup-key-0001';
    const body = { lines: [{ skuId: sku, to: { nodeId: shelf }, qty: 1 }] };
    const r1 = await A.admin.post(`/api/wms/w/${wh}/stock/opening`, body, { 'idempotency-key': key });
    const r2 = await A.admin.post(`/api/wms/w/${wh}/stock/opening`, body, { 'idempotency-key': key });
    expect(r1.status).toBe(201);
    expect(r2.body.replayed).toBe(true);
    expect(r2.body.txnId).toBe(r1.body.txnId);
    const r3 = await A.admin.post(
      `/api/wms/w/${wh}/stock/opening`,
      { lines: [{ skuId: sku, to: { nodeId: shelf }, qty: 2 }] },
      { 'idempotency-key': key },
    );
    expect(r3.status).toBe(409);
    expect(r3.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // Missing key is rejected for WMS commands.
    expect((await A.admin.post(`/api/wms/w/${wh}/stock/opening`, body, { 'idempotency-key': '' })).status).toBe(400);
    // Reset to 16 for the concurrency test.
    const pos = ok(await A.admin.get(`/api/wms/w/${wh}/stock?skuId=${sku}`))[0];
    ok(
      await A.admin.post(`/api/wms/w/${wh}/stock/adjust`, { positionId: pos.id, qtyDelta: '-1', reasonCode: 'DATA_ERROR', note: 'teste' }),
    );
  });

  it('simultaneous competing reservations never over-allocate (16 available, 2 × 10 requested)', async () => {
    const o1 = ok(await A.admin.post(`/api/wms/w/${wh}/outbound`, { lines: [{ skuId: sku, qty: 10 }] })).id;
    const o2 = ok(await A.admin.post(`/api/wms/w/${wh}/outbound`, { lines: [{ skuId: sku, qty: 10 }] })).id;
    const [a, b] = await Promise.all([
      A.admin.post(`/api/wms/w/${wh}/outbound/${o1}/allocate`),
      A.admin.post(`/api/wms/w/${wh}/outbound/${o2}/allocate`),
    ]);
    const total = Number(ok(a).lines[0].allocated) + Number(ok(b).lines[0].allocated);
    expect(total).toBe(16);
    const sum = ok(await A.admin.get(`/api/wms/w/${wh}/stock/summary`)).find((r: { skuCode: string }) => r.skuCode === 'ATK-1');
    expect(sum.reserved).toBe('16.000');
    expect(sum.availableToAllocate).toBe('0.000');
    const rec = ok(await A.admin.get(`/api/wms/w/${wh}/stock/reconciliation`));
    expect(rec.reservationMismatches).toEqual([]);
    // Over-picking a reservation and negative stock are impossible.
    const o = ok(await A.admin.get(`/api/wms/w/${wh}/outbound/${o1}`));
    const over = await A.admin.post(`/api/wms/w/${wh}/outbound/${o1}/pick`, {
      reservationId: o.pickList[0].reservationId,
      qty: 999,
      barcode: 'ATK-1',
      packingNodeId: disp,
    });
    expect(over.status).toBe(409);
    const pos = ok(await A.admin.get(`/api/wms/w/${wh}/stock?skuId=${sku}`))[0];
    await A.admin.stepUp();
    const neg = await A.admin.post(`/api/wms/w/${wh}/stock/adjust`, { positionId: pos.id, qtyDelta: '-1', reasonCode: 'LOSS', note: 'x' });
    expect(neg.status).toBe(409); // all 16 reserved: cannot reduce
    ok(await A.admin.post(`/api/wms/w/${wh}/outbound/${o2}/cancel`));
    expect(
      ok(await A.admin.get(`/api/wms/w/${wh}/stock/summary`)).find((r: { skuCode: string }) => r.skuCode === 'ATK-1').availableToAllocate,
    ).not.toBe('0.000');
  });

  it('concurrent duplicate submissions of the same command are applied once', async () => {
    const body = { lines: [{ skuId: sku, to: { nodeId: shelf }, qty: 3 }] };
    const before = ok(await A.admin.get(`/api/wms/w/${wh}/stock/summary`)).find((r: { skuCode: string }) => r.skuCode === 'ATK-1').onHand;
    const rs = await Promise.all(
      [1, 2, 3].map(() => A.admin.post(`/api/wms/w/${wh}/stock/opening`, body, { 'idempotency-key': 'race-key-0001' })),
    );
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const after = ok(await A.admin.get(`/api/wms/w/${wh}/stock/summary`)).find((r: { skuCode: string }) => r.skuCode === 'ATK-1').onHand;
    expect(Number(after) - Number(before)).toBe(3);
  });
});
