/**
 * @file Deadlock regression (ADR-0031): concurrent allocations of the same SKUs in opposite line
 * order, transfer allocations, and moves in opposite directions between the same two positions
 * must never make PostgreSQL detect a deadlock. Before v0.6.9 allocation locked candidate rows line
 * by line and a move locked source before target, so these patterns deadlocked (hidden by the
 * retry, visible as 1–3 s latency spikes in the load harness). The check reads the database's own
 * deadlock counter, so a retried deadlock still fails the test.
 * @module tests/integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { node, ok, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let A: Tenant;
let wh: string;
const skus: string[] = [];
let binA: string;
let binB: string;

const deadlocks = async (): Promise<number> => {
  // Statistics are flushed asynchronously; clear the snapshot and read the cumulative counter.
  const r = await t.owner.query<{ n: string }>(
    'SELECT pg_stat_clear_snapshot(), (SELECT deadlocks FROM pg_stat_database WHERE datname = current_database())::text AS n',
  );
  return Number(r.rows[0]!.n);
};
const settle = () => new Promise((r) => setTimeout(r, 1500));

beforeAll(async () => {
  t = await startApp();
  A = await tenant(t, 'LCK', ['W1']);
  wh = A.wh.W1!;
  const z = await node(A.admin, wh, 'ZONE', 'L-Z');
  binA = await node(A.admin, wh, 'LOCATION', 'L-A', z);
  binB = await node(A.admin, wh, 'LOCATION', 'L-B', z);
  for (let i = 0; i < 4; i++) skus.push(ok(await A.admin.post('/api/wms/skus', { code: `LCK-${i}`, description: `Peça ${i}` })).id);
  ok(
    await A.admin.post(`/api/wms/w/${wh}/stock/opening`, {
      lines: skus.flatMap((skuId) => [
        { skuId, to: { nodeId: binA }, qty: 500 },
        { skuId, to: { nodeId: binB }, qty: 500 },
      ]),
    }),
  );
});
afterAll(async () => {
  await t?.close();
});

describe('Lock ordering under concurrency (ADR-0031)', () => {
  it('opposite-order multi-line allocations, transfer allocations and opposite moves never deadlock; stock stays consistent', async () => {
    await settle();
    const before = await deadlocks();
    const forward = skus.map((skuId) => ({ skuId, qty: 1 }));
    const backward = [...forward].reverse();
    const positions = (
      await t.owner.query<{ id: string; sku_id: string; holder_node_id: string }>(
        'SELECT id, sku_id, holder_node_id FROM stock_positions WHERE warehouse_id = $1 ORDER BY id',
        [wh],
      )
    ).rows;
    const W2 = ok(await A.admin.post('/api/admin/warehouses', { code: 'LCK-W2', name: 'Destino' })).id;

    const round = async (i: number) => {
      const lines = i % 2 ? forward : backward;
      const o = ok(await A.admin.post(`/api/wms/w/${wh}/outbound`, { lines }));
      const tr = ok(
        await A.admin.post('/api/wms/transfers', { sourceWarehouseId: wh, destWarehouseId: W2, lines: i % 2 ? backward : forward }),
      );
      // Moves in opposite directions between the same two positions of one SKU.
      const sku = skus[i % skus.length]!;
      const [pA, pB] = [
        positions.find((p) => p.sku_id === sku && p.holder_node_id === binA)!,
        positions.find((p) => p.sku_id === sku && p.holder_node_id === binB)!,
      ];
      const results = await Promise.all([
        A.admin.post(`/api/wms/w/${wh}/outbound/${o.id}/allocate`),
        A.admin.post(`/api/wms/transfers/${tr.id}/allocate`),
        A.admin.post(`/api/wms/w/${wh}/stock/move`, { positionId: pA.id, qty: 1, to: { nodeId: binB } }),
        A.admin.post(`/api/wms/w/${wh}/stock/move`, { positionId: pB.id, qty: 1, to: { nodeId: binA } }),
      ]);
      for (const r of results) expect([200, 201]).toContain(r.status);
      if (i % 3 === 0) ok(await A.admin.post(`/api/wms/w/${wh}/outbound/${o.id}/cancel`));
    };
    for (let batch = 0; batch < 5; batch++) await Promise.all(Array.from({ length: 6 }, (_, k) => round(batch * 6 + k)));

    await settle();
    expect(await deadlocks()).toBe(before);
    const total = await t.owner.query<{ s: string }>('SELECT sum(qty_on_hand)::text AS s FROM stock_positions WHERE warehouse_id = $1', [
      wh,
    ]);
    expect(total.rows[0]!.s).toBe('4000.000');
    const rec = ok(await A.admin.get(`/api/wms/w/${wh}/stock/reconciliation`));
    expect(rec).toEqual({ ledgerMismatches: [], reservationMismatches: [] });
  });
});
