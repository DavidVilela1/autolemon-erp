/**
 * @file Trigger-maintained ledger totals (ADR-0032): the per-position totals that routine
 * reconciliation compares against stay exact through real operations, the routine and deep
 * checks detect a tampered balance or total, and only the database (trigger) can write them.
 * Real HTTP API + PostgreSQL.
 * @module tests/security
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { node, ok, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let A: Tenant;
let B: Tenant;
let wh: string;
let binA: string;
let binB: string;
let sku: string;

const rec = (full = false) => A.admin.get(`/api/wms/w/${wh}/stock/reconciliation${full ? '?full=true' : ''}`);
const positionOf = async (holder: string) =>
  (
    await t.owner.query<{ id: string }>(`SELECT id FROM stock_positions WHERE warehouse_id = $1 AND sku_id = $2 AND holder_node_id = $3`, [
      wh,
      sku,
      holder,
    ])
  ).rows[0]!.id;

beforeAll(async () => {
  t = await startApp();
  A = await tenant(t, 'LTA', ['W1']);
  B = await tenant(t, 'LTB', ['W1']);
  wh = A.wh.W1!;
  const z = await node(A.admin, wh, 'ZONE', 'LT-Z');
  binA = await node(A.admin, wh, 'LOCATION', 'LT-A', z);
  binB = await node(A.admin, wh, 'LOCATION', 'LT-B', z);
  sku = ok(await A.admin.post('/api/wms/skus', { code: 'LT-1', description: 'Peça' })).id;
  ok(await A.admin.post(`/api/wms/w/${wh}/stock/opening`, { lines: [{ skuId: sku, to: { nodeId: binA }, qty: 10 }] }));
  const pA = await positionOf(binA);
  ok(await A.admin.post(`/api/wms/w/${wh}/stock/move`, { positionId: pA, qty: 4, to: { nodeId: binB } }));
  ok(await A.admin.post(`/api/wms/w/${wh}/stock/move`, { positionId: pA, qty: 1, to: { nodeId: binB } }));
});
afterAll(async () => {
  await t?.close();
});

describe('Ledger totals (ADR-0032)', () => {
  it('totals equal the ledger sum and the balance of every position after real operations', async () => {
    const r = await t.owner.query<{ id: string; on_hand: string; total: string; ledger: string }>(
      `SELECT p.id, p.qty_on_hand::text AS on_hand, t.total::text AS total,
              (SELECT sum(qty_delta) FROM inventory_ledger l WHERE l.position_id = p.id)::text AS ledger
       FROM stock_positions p JOIN position_ledger_totals t ON t.position_id = p.id WHERE p.warehouse_id = $1 ORDER BY p.qty_on_hand`,
      [wh],
    );
    expect(r.rows.map((x) => [x.on_hand, x.total, x.ledger])).toEqual([
      ['5.000', '5.000', '5.000'],
      ['5.000', '5.000', '5.000'],
    ]);
    expect(ok(await rec())).toEqual({ ledgerMismatches: [], reservationMismatches: [] });
    expect(ok(await rec(true))).toEqual({ ledgerMismatches: [], reservationMismatches: [], totalsMismatches: [] });
  });

  it('routine and deep checks detect a balance changed outside the ledger (privileged DB edit)', async () => {
    const pB = await positionOf(binB);
    await t.owner.query(`UPDATE stock_positions SET qty_on_hand = qty_on_hand + 1 WHERE id = $1`, [pB]);
    try {
      expect(ok(await rec()).ledgerMismatches).toEqual([{ position_id: pB, on_hand: '6.000', ledger: '5.000' }]);
      expect(ok(await rec(true)).ledgerMismatches).toEqual([{ position_id: pB, on_hand: '6.000', ledger: '5.000' }]);
    } finally {
      await t.owner.query(`UPDATE stock_positions SET qty_on_hand = qty_on_hand - 1 WHERE id = $1`, [pB]);
    }
    expect(ok(await rec()).ledgerMismatches).toEqual([]);
  });

  it('a tampered total is reported by the routine check and pinned down by the deep check', async () => {
    const pA = await positionOf(binA);
    await t.owner.query(`UPDATE position_ledger_totals SET total = total + 2 WHERE position_id = $1`, [pA]);
    try {
      // Routine: balance no longer matches its total.
      expect(ok(await rec()).ledgerMismatches).toEqual([{ position_id: pA, on_hand: '5.000', ledger: '7.000' }]);
      // Deep: the balance agrees with the real ledger; the total is what is wrong.
      const deep = ok(await rec(true));
      expect(deep.ledgerMismatches).toEqual([]);
      expect(deep.totalsMismatches).toEqual([{ position_id: pA, total: '7.000', ledger: '5.000' }]);
    } finally {
      await t.owner.query(`UPDATE position_ledger_totals SET total = total - 2 WHERE position_id = $1`, [pA]);
    }
  });

  it('only the trigger writes totals: the runtime role cannot insert, update, delete or call the function', async () => {
    const app = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.company_id', $1, true), set_config('app.wh_scope', '*', true)`, [A.companyId]);
      const pA = await positionOf(binA);
      await expect(app.query(`UPDATE position_ledger_totals SET total = 0 WHERE position_id = $1`, [pA])).rejects.toThrow(
        /permission denied/,
      );
      await app.query('ROLLBACK');
      await expect(app.query(`DELETE FROM position_ledger_totals`)).rejects.toThrow(/permission denied/);
      await expect(
        app.query(`INSERT INTO position_ledger_totals (position_id, company_id, warehouse_id, total) VALUES ($1, $2, $3, 1)`, [
          pA,
          A.companyId,
          wh,
        ]),
      ).rejects.toThrow(/permission denied/);
      const fn = await app.query(`SELECT has_function_privilege('inventory_ledger_totals()', 'EXECUTE') AS ok`);
      expect(fn.rows[0].ok).toBe(false);
    } finally {
      await app.end();
    }
  });

  it('RLS: totals are invisible without tenant context and to another company', async () => {
    const app = new pg.Client({ connectionString: process.env.APP_DATABASE_URL });
    await app.connect();
    try {
      expect((await app.query('SELECT count(*)::int AS n FROM position_ledger_totals')).rows[0].n).toBe(0);
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.company_id', $1, true), set_config('app.wh_scope', '*', true)`, [B.companyId]);
      expect((await app.query('SELECT count(*)::int AS n FROM position_ledger_totals WHERE warehouse_id = $1', [wh])).rows[0].n).toBe(0);
      await app.query('ROLLBACK');
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.company_id', $1, true), set_config('app.wh_scope', '*', true)`, [A.companyId]);
      expect((await app.query('SELECT count(*)::int AS n FROM position_ledger_totals WHERE warehouse_id = $1', [wh])).rows[0].n).toBe(2);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });
});
