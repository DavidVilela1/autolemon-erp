/**
 * @file Scenario 10: tenant and warehouse isolation, unauthorized exports and decryption,
 * RLS defence in depth and append-only history — real PostgreSQL, no mocks.
 * @module tests/security
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, node, ok, staff, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let A: Tenant;
let B: Tenant;
let pStaff: Client;
let lStaff: Client;
let skuA: string;
const N: Record<string, string> = {};
let outA: string;

beforeAll(async () => {
  t = await startApp();
  A = await tenant(t, 'ISO-A', ['PORTO', 'LISBOA']);
  B = await tenant(t, 'ISO-B', ['FARO']);
  pStaff = await staff(t, A, A.wh.PORTO!, [
    'wms.view',
    'wms.receive',
    'wms.putaway',
    'wms.report',
    'wms.outbound.manage',
    'wms.inbound.manage',
  ]);
  lStaff = await staff(t, A, A.wh.LISBOA!, ['wms.view', 'wms.receive', 'wms.putaway']);
  for (const [k, wh] of [
    ['P', A.wh.PORTO!],
    ['L', A.wh.LISBOA!],
  ] as const) {
    const z = await node(A.admin, wh, 'ZONE', `${k}Z`);
    const a = await node(A.admin, wh, 'AISLE', `${k}A`, z);
    const r = await node(A.admin, wh, 'RACK', `${k}R`, a);
    N[`${k}shelf`] = await node(A.admin, wh, 'SHELF', `${k}S`, r);
    N[`${k}stage`] = await node(A.admin, wh, 'STAGING', `${k}REC`);
  }
  skuA = ok(await A.admin.post('/api/wms/skus', { code: 'ISO-1', description: 'Peça isolamento' })).id;
  await A.admin.stepUp();
  ok(await A.admin.post(`/api/wms/w/${A.wh.PORTO}/stock/opening`, { lines: [{ skuId: skuA, to: { nodeId: N.Pshelf }, qty: 10 }] }));
  outA = ok(
    await pStaff.post(`/api/wms/w/${A.wh.PORTO}/outbound`, {
      recipientContact: 'Cliente Sintético, 4000-000 Porto',
      lines: [{ skuId: skuA, qty: 1 }],
    }),
  ).id;
});
afterAll(async () => {
  await t?.close();
});

describe('Warehouse isolation (staff bound to one warehouse)', () => {
  it('Porto staff cannot read Lisboa stock, nodes, inbound or reports (404, audited)', async () => {
    for (const path of ['stock', 'nodes', 'inbound', 'stock/summary', 'putaway', 'containers']) {
      const r = await pStaff.get(`/api/wms/w/${A.wh.LISBOA}/${path}`);
      expect(r.status, path).toBe(404);
    }
    const audit = ok(await A.admin.get('/api/admin/audit?limit=50'));
    expect(
      audit.some(
        (e: { action: string; outcome: string; details: { reason: string } }) =>
          e.action === 'authz.denied' && e.details.reason === 'warehouse_scope',
      ),
    ).toBe(true);
  });

  it('Porto staff cannot write into Lisboa or use a Lisboa node from a Porto document', async () => {
    const w = await pStaff.post(`/api/wms/w/${A.wh.LISBOA}/inbound`, { kind: 'UNPLANNED', lines: [] });
    expect(w.status).toBe(404);
    const inb = ok(await pStaff.post(`/api/wms/w/${A.wh.PORTO}/inbound`, { kind: 'UNPLANNED' }));
    // Lisboa staging node id used inside a Porto receipt → not found (RLS + warehouse filter).
    const r = await pStaff.post(`/api/wms/w/${A.wh.PORTO}/inbound/${inb.id}/receive`, {
      stagingNodeId: N.Lstage,
      lines: [{ skuId: skuA, qty: 1 }],
    });
    expect(r.status).toBe(404);
  });

  it('staff cannot switch warehouse or see other warehouses in the session', async () => {
    expect((await pStaff.post('/api/session/warehouse', { warehouseId: A.wh.LISBOA })).status).toBe(404);
    const s = ok(await pStaff.get('/api/auth/session'));
    expect(s.warehouses).toHaveLength(1);
    expect(ok(await A.admin.post('/api/session/warehouse', { warehouseId: A.wh.LISBOA })).warehouseId).toBe(A.wh.LISBOA);
  });

  it('Lisboa staff only sees transfers touching Lisboa', async () => {
    expect(ok(await lStaff.get('/api/wms/transfers'))).toHaveLength(0);
  });
});

describe('Tenant isolation (Company B vs Company A)', () => {
  it('Company B admin cannot access Company A warehouses, SKUs, documents or users', async () => {
    expect((await B.admin.get(`/api/wms/w/${A.wh.PORTO}/stock`)).status).toBe(404);
    expect((await B.admin.get(`/api/wms/w/${A.wh.PORTO}/outbound/${outA}`)).status).toBe(404);
    expect((await B.admin.get(`/api/wms/w/${B.wh.FARO}/outbound/${outA}`)).status).toBe(404);
    const skus = ok(await B.admin.get('/api/wms/skus'));
    expect(skus.find((s: { id: string }) => s.id === skuA)).toBeUndefined();
    const users = ok(await A.admin.get('/api/admin/users'));
    const someAUser = users[0].id;
    expect((await B.admin.put(`/api/admin/users/${someAUser}/permissions`, { permissions: ['wms.view'] })).status).toBe(404);
    expect((await B.admin.post(`/api/admin/users/${someAUser}/deactivate`)).status).toBe(404);
  });

  it('Company B cannot reference Company A SKUs or warehouses in its own commands', async () => {
    const r = await B.admin.post(`/api/wms/w/${B.wh.FARO}/outbound`, { lines: [{ skuId: skuA, qty: 1 }] });
    expect(r.status).toBe(404);
    const tr = await B.admin.post('/api/wms/transfers', {
      sourceWarehouseId: B.wh.FARO,
      destWarehouseId: A.wh.PORTO,
      lines: [{ skuId: skuA, qty: 1 }],
    });
    expect(tr.status).toBe(404);
    const u = await B.admin.post('/api/admin/users', {
      email: 'x@b.test',
      displayName: 'X',
      role: 'STAFF',
      warehouseId: A.wh.PORTO,
      permissions: [],
    });
    expect(u.status).toBe(404);
  });
});

describe('Unauthorized exports and decryption fail', () => {
  it('CSV export requires wms.export and step-up; succeeds for admin after step-up and is audited', async () => {
    expect((await pStaff.get(`/api/wms/w/${A.wh.PORTO}/reports/stock.csv`)).status).toBe(403);
    const fresh = await tenant(t, 'EXP', ['W1']);
    const noStep = await fresh.admin.get(`/api/wms/w/${fresh.wh.W1}/reports/stock.csv`);
    expect(noStep.status).toBe(403);
    expect(noStep.body.error.code).toBe('STEP_UP_REQUIRED');
    await A.admin.stepUp();
    const csv = await A.admin.get(`/api/wms/w/${A.wh.PORTO}/reports/stock.csv`);
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    expect(csv.text).toContain('"ISO-1"');
    expect(csv.text).not.toContain('Cliente Sintético'); // no PII in exports
    const audit = ok(await A.admin.get('/api/admin/audit?limit=20'));
    expect(audit.some((e: { action: string }) => e.action === 'wms.export.stock_csv')).toBe(true);
  });

  it('encrypted recipient contact is masked for users without wms.dispatch', async () => {
    const r = ok(await pStaff.get(`/api/wms/w/${A.wh.PORTO}/outbound/${outA}`));
    expect(r.recipientContact).toMatch(/sem permissão/);
    const a = ok(await A.admin.get(`/api/wms/w/${A.wh.PORTO}/outbound/${outA}`));
    expect(a.recipientContact).toBe('Cliente Sintético, 4000-000 Porto');
    const raw = await t.owner.query('SELECT recipient_contact_enc FROM outbound_orders WHERE id = $1', [outA]);
    expect(raw.rows[0].recipient_contact_enc).toMatch(/^alenc1\./);
    expect(raw.rows[0].recipient_contact_enc).not.toContain('Cliente');
  });

  it('PII decryption endpoint denies staff, requires step-up for admin and denies cross-tenant', async () => {
    const created = ok(
      await A.admin.post('/api/admin/users', {
        email: `pii-${randomUUID().slice(0, 6)}@a.test`,
        displayName: 'Com Telefone',
        role: 'STAFF',
        warehouseId: A.wh.PORTO,
        permissions: ['wms.view'],
        phone: '+351 912 345 678',
      }),
    );
    expect((await pStaff.get(`/api/admin/users/${created.id}/pii`)).status).toBe(403);
    expect((await B.admin.get(`/api/admin/users/${created.id}/pii`)).status).toBe(403); // no step-up yet
    await B.admin.stepUp();
    expect((await B.admin.get(`/api/admin/users/${created.id}/pii`)).status).toBe(404);
    await A.admin.stepUp();
    expect(ok(await A.admin.get(`/api/admin/users/${created.id}/pii`)).phone).toBe('+351 912 345 678');
  });

  it('staff cannot be granted admin-only permissions (pii.read, admin.*)', async () => {
    const r = await A.admin.post('/api/admin/users', {
      email: `bad-${randomUUID().slice(0, 6)}@a.test`,
      displayName: 'X',
      role: 'STAFF',
      warehouseId: A.wh.PORTO,
      permissions: ['pii.read'],
    });
    expect(r.status).toBe(409);
  });
});

describe('Database defence in depth', () => {
  it('RLS: runtime role sees nothing without tenant context and nothing of A under B context', async () => {
    const app = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
    await app.connect();
    try {
      expect((await app.query('SELECT count(*)::int AS n FROM stock_positions')).rows[0].n).toBe(0);
      expect((await app.query('SELECT count(*)::int AS n FROM skus')).rows[0].n).toBe(0);
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.company_id', $1, true), set_config('app.wh_scope', '*', true)`, [B.companyId]);
      expect((await app.query('SELECT count(*)::int AS n FROM stock_positions WHERE company_id = $1', [A.companyId])).rows[0].n).toBe(0);
      expect((await app.query('SELECT count(*)::int AS n FROM outbound_orders WHERE id = $1', [outA])).rows[0].n).toBe(0);
      await app.query('COMMIT');
      // Staff-like warehouse scope: Porto context cannot see Lisboa rows.
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.company_id', $1, true), set_config('app.wh_scope', $2, true)`, [A.companyId, A.wh.PORTO]);
      expect((await app.query('SELECT count(*)::int AS n FROM storage_nodes WHERE warehouse_id = $1', [A.wh.LISBOA])).rows[0].n).toBe(0);
      // WITH CHECK: cannot insert a row for another warehouse.
      await expect(
        app.query(
          `INSERT INTO storage_nodes (company_id, warehouse_id, kind, code, name, holds_stock, depth, path) VALUES ($1, $2, 'STAGING', 'HACK', 'x', true, 0, 'HACK')`,
          [A.companyId, A.wh.LISBOA],
        ),
      ).rejects.toThrow(/row-level security/);
      await app.query('ROLLBACK');
      // Context is transaction-local: after the transaction nothing is visible again.
      expect((await app.query('SELECT count(*)::int AS n FROM stock_positions')).rows[0].n).toBe(0);
    } finally {
      await app.end();
    }
  });

  it('composite tenant FKs reject cross-tenant references even for the owner role', async () => {
    await expect(
      t.owner.query(
        `INSERT INTO storage_nodes (company_id, warehouse_id, kind, code, name, holds_stock, depth, path) VALUES ($1, $2, 'STAGING', 'X1', 'x', true, 0, 'X1')`,
        [B.companyId, A.wh.PORTO],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('ledger, transactions and audit log are append-only (runtime role and triggers)', async () => {
    const app = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
    await app.connect();
    try {
      await expect(app.query('UPDATE inventory_ledger SET qty_delta = 999')).rejects.toThrow(/permission denied/);
      await expect(app.query('DELETE FROM security_audit_log')).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
    await expect(t.owner.query('UPDATE inventory_ledger SET qty_delta = 999')).rejects.toThrow(/append-only/);
    await expect(t.owner.query('DELETE FROM inventory_transactions')).rejects.toThrow(/append-only/);
  });

  it('audit hash chain detects tampering (simulated privileged DB edit)', async () => {
    expect(ok(await A.admin.get('/api/admin/audit/verify')).ok).toBe(true);
    // A superuser can bypass triggers — exactly why production needs off-site write-once copies.
    await t.owner.query('ALTER TABLE security_audit_log DISABLE TRIGGER security_audit_append_only');
    await t.owner.query(
      `UPDATE security_audit_log SET outcome = 'SUCCESS', details = '{"forged":true}' WHERE company_id = $1 AND seq = 2`,
      [A.companyId],
    );
    await t.owner.query('ALTER TABLE security_audit_log ENABLE TRIGGER security_audit_append_only');
    const v = ok(await A.admin.get('/api/admin/audit/verify'));
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe('2');
  });
});
