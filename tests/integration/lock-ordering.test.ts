/**
 * @file Deadlock regression (ADR-0031): concurrent allocations of the same SKUs in opposite line
 * order, transfer allocations, and moves in opposite directions between the same two positions
 * must never make PostgreSQL detect a deadlock. Before v0.6.9 allocation locked candidate rows line
 * by line and a move locked source before target, so these patterns deadlocked (hidden by the
 * retry, visible as 1–3 s latency spikes in the load harness). The check reads the database's own
 * deadlock counter, so a retried deadlock still fails the test.
 * v0.6.13 adds the other relocations that have a reverse path on the same two rows: pick vs
 * unpick (bin ↔ packing node), replenishment vs an opposite move, and opposite status changes
 * at one bin. Each race runs both directions concurrently many times.
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

describe('Relocations with a reverse path never deadlock (v0.6.13)', () => {
  let w3: string;
  let bin1: string;
  let bin2: string;
  let pack: string;
  const sku = async (code: string) => ok(await A.admin.post('/api/wms/skus', { code, description: code })).id as string;
  const positionAt = async (skuId: string, nodeId: string, status = 'AVAILABLE') =>
    (
      await t.owner.query<{ id: string }>(
        'SELECT id FROM stock_positions WHERE warehouse_id = $1 AND sku_id = $2 AND holder_node_id = $3 AND stock_status = $4',
        [w3, skuId, nodeId, status],
      )
    ).rows[0]!.id;
  const race = async (n: number, pair: (i: number) => Promise<Array<{ status: number; body: unknown }>>) => {
    await settle();
    const before = await deadlocks();
    for (let batch = 0; batch < n; batch++) {
      const results = (await Promise.all(Array.from({ length: 4 }, (_, k) => pair(batch * 4 + k)))).flat();
      for (const r of results) expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
    }
    await settle();
    expect(await deadlocks()).toBe(before);
    expect(ok(await A.admin.get(`/api/wms/w/${w3}/stock/reconciliation?full=true`))).toEqual({
      ledgerMismatches: [],
      reservationMismatches: [],
      totalsMismatches: [],
    });
  };

  beforeAll(async () => {
    w3 = ok(await A.admin.post('/api/admin/warehouses', { code: 'LCK-W3', name: 'Corridas' })).id;
    const z = await node(A.admin, w3, 'ZONE', 'R-Z');
    bin1 = await node(A.admin, w3, 'LOCATION', 'R-1', z);
    bin2 = await node(A.admin, w3, 'LOCATION', 'R-2', z);
    pack = await node(A.admin, w3, 'DISPATCH', 'R-EXP');
  });

  it('pick (bin → packing) racing unpick (packing → bin) of the same SKU', async () => {
    const P = await sku('LCK-PICK');
    ok(await A.admin.post(`/api/wms/w/${w3}/stock/opening`, { lines: [{ skuId: P, to: { nodeId: bin1 }, qty: 500 }] }));
    type Order = { id: string; pickList: Array<{ reservationId: string }>; lines: Array<{ id: string }> };
    const allocated = async (): Promise<Order> => {
      const o = ok(await A.admin.post(`/api/wms/w/${w3}/outbound`, { lines: [{ skuId: P, qty: 1 }] }));
      ok(await A.admin.post(`/api/wms/w/${w3}/outbound/${o.id}/allocate`));
      return ok(await A.admin.get(`/api/wms/w/${w3}/outbound/${o.id}`));
    };
    const pickBody = (o: Order) => ({
      reservationId: o.pickList[0]!.reservationId,
      qty: 1,
      barcode: 'LCK-PICK',
      packingNodeId: pack,
    });
    // Orders already picked (their units wait at the packing node) and orders ready to pick.
    const picked: Order[] = [];
    for (let i = 0; i < 20; i++) {
      const o = await allocated();
      ok(await A.admin.post(`/api/wms/w/${w3}/outbound/${o.id}/pick`, pickBody(o)));
      picked.push(o);
    }
    const ready: Order[] = [];
    for (let i = 0; i < 20; i++) ready.push(await allocated());
    await race(5, (i) =>
      Promise.all([
        A.admin.post(`/api/wms/w/${w3}/outbound/${ready[i]!.id}/pick`, pickBody(ready[i]!)),
        A.admin.post(`/api/wms/w/${w3}/outbound/${picked[i]!.id}/unpick`, {
          lineId: picked[i]!.lines[0]!.id,
          qty: 1,
          fromNodeId: pack,
          to: { nodeId: bin1 },
        }),
      ]),
    );
  });

  it('replenishment (bulk → pick bin) racing a move in the opposite direction', async () => {
    const R = await sku('LCK-REPL');
    ok(
      await A.admin.post(`/api/wms/w/${w3}/stock/opening`, {
        lines: [
          { skuId: R, to: { nodeId: bin1 }, qty: 500 },
          { skuId: R, to: { nodeId: bin2 }, qty: 500 },
        ],
      }),
    );
    // The old code (lock source, then target) deadlocks with the move only when the pick-bin
    // position sorts BELOW the bulk position; pick the bins so that is always the case.
    const [p1, p2] = [await positionAt(R, bin1), await positionAt(R, bin2)];
    const [pickPos, bulkPos, pickBin, bulkBin] = p1 < p2 ? [p1, p2, bin1, bin2] : [p2, p1, bin2, bin1];
    const rule = ok(
      await A.admin.post(`/api/wms/w/${w3}/replenishment/rules`, { skuId: R, pickNodeId: pickBin, minQty: 1, targetQty: 100 }),
    );
    await race(5, () =>
      Promise.all([
        A.admin.post(`/api/wms/w/${w3}/replenishment/execute`, { ruleId: rule.id, fromPositionId: bulkPos, qty: 1 }),
        A.admin.post(`/api/wms/w/${w3}/stock/move`, { positionId: pickPos, qty: 1, to: { nodeId: bulkBin } }),
      ]),
    );
  });

  it('opposite status changes (AVAILABLE ↔ QUARANTINE) at the same bin', async () => {
    const Q = await sku('LCK-STAT');
    ok(await A.admin.post(`/api/wms/w/${w3}/stock/opening`, { lines: [{ skuId: Q, to: { nodeId: bin2 }, qty: 500 }] }));
    const av = await positionAt(Q, bin2);
    ok(await A.admin.post(`/api/wms/w/${w3}/stock/status`, { positionId: av, qty: 100, toStatus: 'QUARANTINE', reason: 'Inspeção' }));
    const q = await positionAt(Q, bin2, 'QUARANTINE');
    await A.admin.stepUp(); // releasing to AVAILABLE requires step-up
    await race(5, () =>
      Promise.all([
        A.admin.post(`/api/wms/w/${w3}/stock/status`, { positionId: av, qty: 1, toStatus: 'QUARANTINE', reason: 'Inspeção' }),
        A.admin.post(`/api/wms/w/${w3}/stock/status`, { positionId: q, qty: 1, toStatus: 'AVAILABLE', reason: 'Libertado' }),
      ]),
    );
  });
});
