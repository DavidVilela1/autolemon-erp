/**
 * @file T-20 evidence: lot master with expiry and FEFO allocation, explicit lot requests, and
 * serial-number uniqueness (application checks + database trigger, incl. concurrency and
 * in-transit serials). Real HTTP API + PostgreSQL, no mocks.
 * @module tests/integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { node, ok, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let A: Tenant;
let w1: string;
let w2: string;
let lotSku: string;
let serialSku: string;
const N: Record<string, string> = {};
const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const wms = (wh: string, p: string) => `/api/wms/w/${wh}${p}`;

async function invariants() {
  for (const wh of [w1, w2]) {
    const rec = ok(await A.admin.get(wms(wh, '/stock/reconciliation')));
    expect(rec.ledgerMismatches).toEqual([]);
    expect(rec.reservationMismatches).toEqual([]);
  }
}

beforeAll(async () => {
  t = await startApp();
  A = await tenant(t, 'LOT', ['W1', 'W2']);
  w1 = A.wh.W1!;
  w2 = A.wh.W2!;
  for (const [k, wh] of [
    ['a', w1],
    ['b', w2],
  ] as const) {
    const z = await node(A.admin, wh, 'ZONE', `${k.toUpperCase()}-LZ`);
    N[`${k}1`] = await node(A.admin, wh, 'LOCATION', `${k.toUpperCase()}-L1`, z);
    N[`${k}2`] = await node(A.admin, wh, 'LOCATION', `${k.toUpperCase()}-L2`, z);
    N[`${k}stage`] = await node(A.admin, wh, 'STAGING', `${k.toUpperCase()}-REC`);
  }
  lotSku = ok(await A.admin.post('/api/wms/skus', { code: 'OIL-LOT', description: 'Óleo com lote', tracking: 'LOT' })).id;
  serialSku = ok(
    await A.admin.post('/api/wms/skus', { code: 'ECU-SN', description: 'Centralina com n.º de série', tracking: 'SERIAL' }),
  ).id;
});
afterAll(async () => {
  await t?.close();
});

describe('Lots with expiry and FEFO allocation', () => {
  it('requires a lot for tracked SKUs and a lot for any expiry date', async () => {
    const noLot = await A.admin.post(wms(w1, '/stock/opening'), { lines: [{ skuId: lotSku, to: { nodeId: N.a1 }, qty: 1 }] });
    expect(noLot.status).toBe(400);
    const plain = ok(await A.admin.post('/api/wms/skus', { code: 'PLAIN-1', description: 'Sem lote' })).id;
    const expNoLot = await A.admin.post(wms(w1, '/stock/opening'), {
      lines: [{ skuId: plain, to: { nodeId: N.a1 }, qty: 1, expiresOn: day(5) }],
    });
    expect(expNoLot.status).toBe(400);
  });

  it('allocates earliest-expiry first, never expired lots, undated lots last', async () => {
    ok(
      await A.admin.post(wms(w1, '/stock/opening'), {
        lines: [
          { skuId: lotSku, to: { nodeId: N.a1 }, qty: 5, lot: 'L-A', expiresOn: day(60) },
          { skuId: lotSku, to: { nodeId: N.a2 }, qty: 5, lot: 'L-B', expiresOn: day(10) },
          { skuId: lotSku, to: { nodeId: N.a1 }, qty: 5, lot: 'L-C', expiresOn: day(-1) },
          { skuId: lotSku, to: { nodeId: N.a2 }, qty: 5, lot: 'L-D' },
        ],
      }),
    );
    const listed = ok(await A.admin.get(wms(w1, `/stock?skuId=${lotSku}`))) as Array<{
      lot: string;
      expiresOn: string | null;
      expired: boolean | null;
    }>;
    expect(listed.find((p) => p.lot === 'L-C')).toMatchObject({ expiresOn: day(-1), expired: true });

    const o = ok(await A.admin.post(wms(w1, '/outbound'), { lines: [{ skuId: lotSku, qty: 12 }] }));
    const alloc = ok(await A.admin.post(wms(w1, `/outbound/${o.id}/allocate`)));
    expect(alloc.lines[0]).toMatchObject({ allocated: '12', missing: '0' });
    const pick = Object.fromEntries(
      (ok(await A.admin.get(wms(w1, `/outbound/${o.id}`))).pickList as Array<{ lot: string; qtyOpen: string }>).map((r) => [
        r.lot,
        r.qtyOpen,
      ]),
    );
    // B (10 days) and A (60 days) fully, then D (no expiry) for the rest; C (expired) untouched.
    expect(pick).toEqual({ 'L-B': '5.000', 'L-A': '5.000', 'L-D': '2.000' });
    await invariants();
  });

  it('honours an explicitly requested lot and refuses unknown lots', async () => {
    const o = ok(await A.admin.post(wms(w1, '/outbound'), { lines: [{ skuId: lotSku, qty: 2, lot: 'L-D' }] }));
    ok(await A.admin.post(wms(w1, `/outbound/${o.id}/allocate`)));
    const pick = ok(await A.admin.get(wms(w1, `/outbound/${o.id}`))).pickList as Array<{ lot: string }>;
    expect(pick.map((r) => r.lot)).toEqual(['L-D']);
    expect((await A.admin.post(wms(w1, '/outbound'), { lines: [{ skuId: lotSku, qty: 1, lot: 'NOPE' }] })).status).toBe(404);
    // Only 1 of L-D is left free (5 − 2 − 2): a 3-unit request for it allocates 1 and reports 2 missing.
    const o2 = ok(await A.admin.post(wms(w1, '/outbound'), { lines: [{ skuId: lotSku, qty: 3, lot: 'L-D' }] }));
    expect(ok(await A.admin.post(wms(w1, `/outbound/${o2.id}/allocate`))).lines[0]).toMatchObject({ allocated: '1', missing: '2' });
    await invariants();
  });

  it('keeps one expiry per lot: fills a missing date once, refuses a conflicting date', async () => {
    ok(
      await A.admin.post(wms(w2, '/stock/opening'), {
        lines: [{ skuId: lotSku, to: { nodeId: N.b1 }, qty: 1, lot: 'L-D', expiresOn: day(90) }],
      }),
    );
    const clash = await A.admin.post(wms(w2, '/stock/opening'), {
      lines: [{ skuId: lotSku, to: { nodeId: N.b1 }, qty: 1, lot: 'L-A', expiresOn: day(61) }],
    });
    expect(clash.body.error.code).toBe('LOT_EXPIRY_MISMATCH');
    const listed = ok(await A.admin.get(wms(w1, `/stock?skuId=${lotSku}`))) as Array<{ lot: string; expiresOn: string | null }>;
    expect(listed.find((p) => p.lot === 'L-D')?.expiresOn).toBe(day(90)); // company-wide lot master
  });
});

describe('Serial numbers', () => {
  const open = (wh: string, nodeId: string, lot: string, qty = 1) =>
    A.admin.post(wms(wh, '/stock/opening'), { lines: [{ skuId: serialSku, to: { nodeId }, qty, lot }] });

  it('allows exactly one unit per serial and one place per serial across the company', async () => {
    expect((await open(w1, N.a1!, 'SN-1', 2)).body.error.code).toBe('SERIAL_QTY');
    ok(await open(w1, N.a1!, 'SN-1'));
    expect((await open(w1, N.a2!, 'SN-1')).body.error.code).toBe('SERIAL_DUPLICATE');
    expect((await open(w2, N.b1!, 'SN-1')).body.error.code).toBe('SERIAL_DUPLICATE'); // other warehouse, same company
    // Moving the unit inside the warehouse is fine (source goes to 0 before the target gets 1).
    const pos = (ok(await A.admin.get(wms(w1, `/stock?skuId=${serialSku}`))) as Array<{ id: string }>)[0]!;
    ok(await A.admin.post(wms(w1, '/stock/move'), { positionId: pos.id, qty: 1, to: { nodeId: N.a2 } }));
    await invariants();
  });

  it('a serial in transit cannot be received elsewhere; it arrives once at the destination', async () => {
    const pos = (ok(await A.admin.get(wms(w1, `/stock?skuId=${serialSku}`))) as Array<{ id: string }>)[0]!;
    const tr = ok(
      await A.admin.post('/api/wms/transfers', { sourceWarehouseId: w1, destWarehouseId: w2, lines: [{ skuId: serialSku, qty: 1 }] }),
    );
    const line = ok(await A.admin.get(`/api/wms/transfers/${tr.id}`)).lines[0].id;
    ok(await A.admin.post(`/api/wms/transfers/${tr.id}/dispatch`, { lines: [{ lineId: line, positionId: pos.id, qty: 1 }] }));
    expect((await open(w1, N.a1!, 'SN-1')).body.error.code).toBe('SERIAL_DUPLICATE'); // in transit
    ok(await A.admin.post(`/api/wms/transfers/${tr.id}/receive`, { stagingNodeId: N.bstage, lines: [{ lineId: line, qty: 1 }] }));
    expect((await open(w1, N.a1!, 'SN-1')).body.error.code).toBe('SERIAL_DUPLICATE'); // now on hand in W2
    await invariants();
  });

  it('concurrent receipts of the same serial in two warehouses: exactly one succeeds', async () => {
    const [r1, r2] = await Promise.all([open(w1, N.a1!, 'SN-RACE'), open(w2, N.b2!, 'SN-RACE')]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect([r1, r2].find((r) => r.status === 409)!.body.error.code).toBe('SERIAL_DUPLICATE');
    const total = (
      await t.owner.query(
        `SELECT coalesce(sum(qty_on_hand), 0)::int AS n FROM stock_positions WHERE sku_id = $1 AND lot_code = 'SN-RACE'`,
        [serialSku],
      )
    ).rows[0].n;
    expect(total).toBe(1);
    await invariants();
  });
});
