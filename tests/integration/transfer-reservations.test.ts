/**
 * @file T-26 evidence: transfer reservations at the source warehouse and the near-expiry
 * report. Real HTTP API + PostgreSQL. Covers FEFO allocation for transfers, protection of
 * reserved stock against outbound orders and moves, consumption on dispatch, release on
 * cancel / full shipment, destination-side refusal while the source holds stock, visibility of
 * the pick list only to the source, concurrency, and conservation across warehouses.
 * @module tests/integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { node, ok, staff, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let A: Tenant;
let w1: string;
let w2: string;
let sku: string;
const N: Record<string, string> = {};
const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const wms = (wh: string, p: string) => `/api/wms/w/${wh}${p}`;
const summary = async (wh: string) =>
  (ok(await A.admin.get(wms(wh, '/stock/summary'))) as Array<{ skuId: string; onHand: string; reserved: string }>).find(
    (r) => r.skuId === sku,
  );

async function invariants() {
  for (const wh of [w1, w2]) {
    const rec = ok(await A.admin.get(wms(wh, '/stock/reconciliation')));
    expect(rec.ledgerMismatches).toEqual([]);
    expect(rec.reservationMismatches).toEqual([]);
  }
}

beforeAll(async () => {
  t = await startApp();
  A = await tenant(t, 'TRR', ['W1', 'W2']);
  w1 = A.wh.W1!;
  w2 = A.wh.W2!;
  for (const [k, wh] of [
    ['a', w1],
    ['b', w2],
  ] as const) {
    const z = await node(A.admin, wh, 'ZONE', `${k.toUpperCase()}-TZ`);
    N[`${k}1`] = await node(A.admin, wh, 'LOCATION', `${k.toUpperCase()}-T1`, z);
    N[`${k}2`] = await node(A.admin, wh, 'LOCATION', `${k.toUpperCase()}-T2`, z);
    N[`${k}stage`] = await node(A.admin, wh, 'STAGING', `${k.toUpperCase()}-TREC`);
  }
  sku = ok(await A.admin.post('/api/wms/skus', { code: 'FLT-TR', description: 'Filtro transferível', tracking: 'LOT' })).id;
  ok(
    await A.admin.post(wms(w1, '/stock/opening'), {
      lines: [
        { skuId: sku, to: { nodeId: N.a1 }, qty: 6, lot: 'T-LATE', expiresOn: day(200) },
        { skuId: sku, to: { nodeId: N.a2 }, qty: 4, lot: 'T-SOON', expiresOn: day(20) },
      ],
    }),
  );
});
afterAll(async () => {
  await t?.close();
});

describe('Transfer reservations at the source', () => {
  let tr: string;
  let line: string;

  it('reserves FEFO at the source and protects the reserved stock', async () => {
    tr = ok(await A.admin.post('/api/wms/transfers', { sourceWarehouseId: w1, destWarehouseId: w2, lines: [{ skuId: sku, qty: 7 }] })).id;
    const r = ok(await A.admin.post(`/api/wms/transfers/${tr}/allocate`));
    expect(r.lines[0]).toMatchObject({ reserved: '7', missing: '0' });
    const doc = ok(await A.admin.get(`/api/wms/transfers/${tr}`));
    line = doc.lines[0].id;
    expect(doc.lines[0].qtyReserved).toBe('7.000');
    expect(Object.fromEntries(doc.pickList.map((p: { lot: string; qtyOpen: string }) => [p.lot, p.qtyOpen]))).toEqual({
      'T-SOON': '4.000',
      'T-LATE': '3.000',
    });
    expect((await summary(w1))?.reserved).toBe('7.000');
    // Only 3 remain free: an outbound order for 5 gets 3, and a move of reserved units is refused.
    const o = ok(await A.admin.post(wms(w1, '/outbound'), { lines: [{ skuId: sku, qty: 5 }] }));
    expect(ok(await A.admin.post(wms(w1, `/outbound/${o.id}/allocate`))).lines[0]).toMatchObject({ allocated: '3', missing: '2' });
    ok(await A.admin.post(wms(w1, `/outbound/${o.id}/cancel`)));
    const soon = (ok(await A.admin.get(wms(w1, `/stock?skuId=${sku}`))) as Array<{ id: string; lot: string }>).find(
      (p) => p.lot === 'T-SOON',
    )!;
    expect((await A.admin.post(wms(w1, '/stock/move'), { positionId: soon.id, qty: 1, to: { nodeId: N.a1 } })).status).toBe(409);
    // Re-running allocation reserves nothing more.
    expect(ok(await A.admin.post(`/api/wms/transfers/${tr}/allocate`)).lines[0]).toMatchObject({ reserved: '0', missing: '0' });
    await invariants();
  });

  it('the destination sees the reserved quantity but not the pick list, and cannot close while stock is held', async () => {
    const dest = await staff(t, A, w2, ['wms.view', 'wms.transfer.receive']);
    const seen = ok(await dest.get(`/api/wms/transfers/${tr}`));
    expect(seen.lines[0].qtyReserved).toBe('7.000');
    expect(seen.pickList).toEqual([]);
    const close = await dest.post(`/api/wms/transfers/${tr}/close`);
    expect(close.body.error.code).toBe('TRANSFER_RESERVED');
    const srcOnly = await staff(t, A, w2, ['wms.view', 'wms.transfer.dispatch']);
    expect((await srcOnly.post(`/api/wms/transfers/${tr}/allocate`)).status).toBe(404); // not the source warehouse
  });

  it('dispatch consumes the reservations of the picked positions; full shipment releases the rest', async () => {
    const doc = ok(await A.admin.get(`/api/wms/transfers/${tr}`));
    const soon = doc.pickList.find((p: { lot: string }) => p.lot === 'T-SOON');
    ok(await A.admin.post(`/api/wms/transfers/${tr}/dispatch`, { lines: [{ lineId: line, positionId: soon.positionId, qty: 4 }] }));
    let after = ok(await A.admin.get(`/api/wms/transfers/${tr}`));
    expect(after.lines[0]).toMatchObject({ qtyShipped: '4.000', qtyReserved: '3.000' });
    // Ship the remaining 3 from the late lot: the line is complete, nothing stays reserved.
    const late = after.pickList[0];
    ok(await A.admin.post(`/api/wms/transfers/${tr}/dispatch`, { lines: [{ lineId: line, positionId: late.positionId, qty: 3 }] }));
    after = ok(await A.admin.get(`/api/wms/transfers/${tr}`));
    expect(after.lines[0]).toMatchObject({ qtyShipped: '7.000', qtyReserved: '0.000' });
    expect(after.pickList).toEqual([]);
    expect((await summary(w1))?.reserved).toBe('0.000');
    ok(await A.admin.post(`/api/wms/transfers/${tr}/receive`, { stagingNodeId: N.bstage, lines: [{ lineId: line, qty: 7 }] }));
    // Conservation: 10 opened in W1 = 3 left in W1 + 7 received in W2.
    expect((await summary(w1))?.onHand).toBe('3.000');
    expect((await summary(w2))?.onHand).toBe('7.000');
    await invariants();
  });

  it('cancelling a planned transfer releases its reservations', async () => {
    const id = ok(
      await A.admin.post('/api/wms/transfers', { sourceWarehouseId: w1, destWarehouseId: w2, lines: [{ skuId: sku, qty: 2 }] }),
    ).id;
    ok(await A.admin.post(`/api/wms/transfers/${id}/allocate`));
    expect((await summary(w1))?.reserved).toBe('2.000');
    ok(await A.admin.post(`/api/wms/transfers/${id}/cancel`));
    expect((await summary(w1))?.reserved).toBe('0.000');
    expect(ok(await A.admin.get(`/api/wms/transfers/${id}`)).lines[0].qtyReserved).toBe('0.000');
    await invariants();
  });

  it('two transfers competing for the last units never over-reserve', async () => {
    const mk = async () =>
      ok(await A.admin.post('/api/wms/transfers', { sourceWarehouseId: w1, destWarehouseId: w2, lines: [{ skuId: sku, qty: 3 }] }))
        .id as string;
    const [x, y] = [await mk(), await mk()];
    const [rx, ry] = await Promise.all([
      A.admin.post(`/api/wms/transfers/${x}/allocate`),
      A.admin.post(`/api/wms/transfers/${y}/allocate`),
    ]);
    const reserved = [ok(rx).lines[0].reserved, ok(ry).lines[0].reserved].map(Number);
    expect(reserved[0]! + reserved[1]!).toBe(3); // only 3 on hand in W1
    expect((await summary(w1))?.reserved).toBe('3.000');
    await invariants();
  });
});

describe('Near-expiry report', () => {
  it('lists lots expiring within the window (expired flagged), earliest first; needs wms.report', async () => {
    ok(
      await A.admin.post(wms(w1, '/stock/opening'), {
        lines: [
          { skuId: sku, to: { nodeId: N.a2 }, qty: 1, lot: 'T-OLD', expiresOn: day(-3) },
          { skuId: sku, to: { nodeId: N.a2 }, qty: 1, lot: 'T-FAR', expiresOn: day(400) },
        ],
      }),
    );
    const rows = ok(await A.admin.get(wms(w1, '/reports/expiry?days=30'))) as Array<{ lot: string; expired: boolean; daysLeft: number }>;
    expect(rows.map((r) => r.lot)).toEqual(['T-OLD']); // T-SOON was shipped; T-LATE (200 d) and T-FAR are outside 30 days
    expect(rows[0]).toMatchObject({ expired: true, daysLeft: -3 });
    expect((ok(await A.admin.get(wms(w1, '/reports/expiry?days=365'))) as Array<{ lot: string }>).map((r) => r.lot)).toEqual([
      'T-OLD',
      'T-LATE',
    ]);
    expect((await A.admin.get(wms(w1, '/reports/expiry?days=999'))).status).toBe(400);
    const viewer = await staff(t, A, w1, ['wms.view']);
    expect((await viewer.get(wms(w1, '/reports/expiry'))).status).toBe(403);
  });
});
