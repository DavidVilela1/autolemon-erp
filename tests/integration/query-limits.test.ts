/**
 * @file Long-query behaviour (ADR-0031): a statement that exceeds the pool's time limit returns a
 * clear 503 QUERY_TIMEOUT instead of a generic 500, and reconciliation (which reads the whole
 * ledger and has its own longer budget) runs at most once per warehouse at a time.
 * Real HTTP API + PostgreSQL; the API runs with a 1 s statement limit so the test is fast.
 * @module tests/integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { node, ok, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let A: Tenant;
let wh: string;
let sku: string;

beforeAll(async () => {
  t = await startApp({ DB_STATEMENT_TIMEOUT_MS: '1000' });
  A = await tenant(t, 'QLM', ['W1']);
  wh = A.wh.W1!;
  const z = await node(A.admin, wh, 'ZONE', 'Q-Z');
  const bin = await node(A.admin, wh, 'LOCATION', 'Q-L1', z);
  sku = ok(await A.admin.post('/api/wms/skus', { code: 'QLM-1', description: 'Peça' })).id;
  ok(await A.admin.post(`/api/wms/w/${wh}/stock/opening`, { lines: [{ skuId: sku, to: { nodeId: bin }, qty: 5 }] }));
});
afterAll(async () => {
  await t?.close();
});

describe('Database time limits', () => {
  it('a statement over the limit returns 503 QUERY_TIMEOUT (not 500) and the API recovers', async () => {
    const blocker = await t.owner.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE stock_positions IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      const r = await A.admin.get(`/api/wms/w/${wh}/stock?skuId=${sku}`);
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('QUERY_TIMEOUT');
      expect(r.body.error.message).not.toMatch(/statement|timeout|postgres|canceling/i); // no internals
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(ok(await A.admin.get(`/api/wms/w/${wh}/stock?skuId=${sku}`))).toHaveLength(1);
  });

  it('reconciliation has its own budget beyond the pool limit, and only one runs per warehouse', async () => {
    // Own budget: a 2 s wait inside the reconciliation transaction would exceed the 1 s pool limit.
    const holder = await t.owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE stock_positions IN ACCESS EXCLUSIVE MODE');
      const pending = A.admin.get(`/api/wms/w/${wh}/stock/reconciliation`);
      await new Promise((r) => setTimeout(r, 2000));
      // While it runs (blocked), a second reconciliation of the same warehouse is refused.
      const second = await A.admin.get(`/api/wms/w/${wh}/stock/reconciliation`);
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('RECONCILIATION_RUNNING');
      await holder.query('ROLLBACK');
      const first = await pending;
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ ledgerMismatches: [], reservationMismatches: [] });
    } finally {
      holder.release();
    }
    // The lock is transaction-scoped: the next run proceeds normally.
    expect(ok(await A.admin.get(`/api/wms/w/${wh}/stock/reconciliation`))).toEqual({ ledgerMismatches: [], reservationMismatches: [] });
  });
});
