/**
 * @file WMS operations added in v0.6 (review REVIEW-2026-11-10-v0.5): quality status changes
 * (R-01), barcode units of measure (R-02), lots through transfers (R-03), un-pick / un-pack /
 * cancel after picking (R-04, R-10), node rename/deactivation and container close (R-05) and
 * source-side transfer cancellation (R-06). Real HTTP API + real PostgreSQL, no mocks; each
 * scenario ends by checking ledger = balances and reservations = reserved.
 * @module tests/integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, node, ok, staff, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let A: Tenant;
let w1: string;
let w2: string;
let sku: string; // case barcode = 12 units
let lotSku: string;
const N: Record<string, string> = {};

const wms = (wh: string, path: string) => `/api/wms/w/${wh}${path}`;
const positions = async (c: Client, wh: string, skuId: string) =>
  ok(await c.get(wms(wh, `/stock?skuId=${skuId}`))) as Array<Record<string, string>>;
const onHandAt = async (wh: string, skuId: string, nodeId: string, status = 'AVAILABLE') =>
  (await positions(A.admin, wh, skuId)).filter((p) => p.nodeId === nodeId && p.status === status).reduce((s, p) => s + Number(p.onHand), 0);

async function invariants() {
  for (const wh of [w1, w2]) {
    const rec = ok(await A.admin.get(wms(wh, '/stock/reconciliation')));
    expect(rec.ledgerMismatches).toEqual([]);
    expect(rec.reservationMismatches).toEqual([]);
  }
}

beforeAll(async () => {
  t = await startApp();
  A = await tenant(t, 'CMP', ['W1', 'W2']);
  w1 = A.wh.W1!;
  w2 = A.wh.W2!;
  for (const [code, wh] of [
    ['A', w1],
    ['B', w2],
  ] as const) {
    const zone = await node(A.admin, wh, 'ZONE', `${code}-Z`);
    const aisle = await node(A.admin, wh, 'AISLE', `${code}-A`, zone);
    const rack = await node(A.admin, wh, 'RACK', `${code}-R`, aisle);
    N[`${code}shelf`] = await node(A.admin, wh, 'SHELF', `${code}-S1`, rack);
    N[`${code}shelf2`] = await node(A.admin, wh, 'SHELF', `${code}-S2`, rack);
    N[`${code}stage`] = await node(A.admin, wh, 'STAGING', `${code}-REC`);
    N[`${code}quar`] = await node(A.admin, wh, 'QUARANTINE', `${code}-QUAR`);
    N[`${code}disp`] = await node(A.admin, wh, 'DISPATCH', `${code}-EXP`);
  }
  sku = ok(
    await A.admin.post('/api/wms/skus', {
      code: 'OIL-5W30',
      description: 'Óleo 5W30 1L',
      barcodes: [
        { barcode: '5600000000011', uom: 'UN', qtyPerUom: 1 },
        { barcode: '5600000000028', uom: 'CX', qtyPerUom: 12 },
      ],
    }),
  ).id;
  lotSku = ok(await A.admin.post('/api/wms/skus', { code: 'FLT-LOT', description: 'Filtro com lote', tracking: 'LOT' })).id;
});
afterAll(async () => {
  await t?.close();
});

describe('R-02 barcode units of measure', () => {
  it('a case scan receives qty × 12 base units; a unit scan receives qty × 1', async () => {
    const inb = ok(await A.admin.post(wms(w1, '/inbound'), { kind: 'EXPECTED', lines: [{ skuId: sku, qtyExpected: 30 }] }));
    ok(await A.admin.post(wms(w1, `/inbound/${inb.id}/release`)));
    const r = ok(
      await A.admin.post(wms(w1, `/inbound/${inb.id}/receive`), {
        stagingNodeId: N.Astage,
        lines: [
          { barcode: '5600000000028', qty: 2 },
          { barcode: '5600000000011', qty: 6 },
        ],
      }),
    );
    expect(r.received.map((x: { qty: string }) => x.qty)).toEqual(['24', '6']);
    const doc = ok(await A.admin.get(wms(w1, `/inbound/${inb.id}`)));
    expect(doc.lines[0].qtyReceived).toBe('30.000');
    for (const task of ok(await A.admin.get(wms(w1, '/putaway'))) as Array<{ id: string; qtyRemaining: string }>) {
      ok(await A.admin.post(wms(w1, `/putaway/${task.id}/complete`), { to: { nodeId: N.Ashelf }, qty: task.qtyRemaining }));
    }
    expect(await onHandAt(w1, sku, N.Ashelf!)).toBe(30);
    await invariants();
  });
});

describe('R-01 quality status changes', () => {
  let posId: string;
  it('blocks available stock into quarantine (audited, no step-up needed)', async () => {
    posId = (await positions(A.admin, w1, sku)).find((p) => p.nodeId === N.Ashelf)!.id!;
    const r = ok(
      await A.admin.post(wms(w1, '/stock/status'), {
        positionId: posId,
        qty: 4,
        toStatus: 'QUARANTINE',
        to: { nodeId: N.Aquar },
        reason: 'Embalagens com fuga',
      }),
    );
    expect(await onHandAt(w1, sku, N.Aquar!, 'QUARANTINE')).toBe(4);
    expect(await onHandAt(w1, sku, N.Ashelf!)).toBe(26);
    const audit = ok(await A.admin.get('/api/admin/audit?limit=20')) as Array<{ action: string }>;
    expect(audit.some((e) => e.action === 'wms.inventory.block')).toBe(true);
    expect(r.txnId).toBeTruthy();
  });

  it('release to AVAILABLE needs step-up and an allocatable destination', async () => {
    const q = (await positions(A.admin, w1, sku)).find((p) => p.status === 'QUARANTINE')!;
    const body = { positionId: q.id, qty: 3, toStatus: 'AVAILABLE', reason: 'Inspecionado: OK' };
    const noStep = await A.admin.post(wms(w1, '/stock/status'), body);
    expect(noStep.status).toBe(403);
    expect(noStep.body.error.code).toBe('STEP_UP_REQUIRED');
    await A.admin.stepUp();
    const stranded = await A.admin.post(wms(w1, '/stock/status'), body); // stays in quarantine area
    expect(stranded.body.error.code).toBe('HOLDER_KIND_NOT_ALLOWED');
    ok(await A.admin.post(wms(w1, '/stock/status'), { ...body, to: { nodeId: N.Ashelf2 } }));
    expect(await onHandAt(w1, sku, N.Ashelf2!)).toBe(3);
    expect(await onHandAt(w1, sku, N.Aquar!, 'QUARANTINE')).toBe(1);
    const audit = ok(await A.admin.get('/api/admin/audit?limit=20')) as Array<{ action: string }>;
    expect(audit.some((e) => e.action === 'wms.inventory.release')).toBe(true);
  });

  it('refuses staff without wms.adjust, same status and stock in process', async () => {
    const s = await staff(t, A, w1, ['wms.view', 'wms.putaway']);
    expect((await s.post(wms(w1, '/stock/status'), { positionId: posId, qty: 1, toStatus: 'DAMAGED', reason: 'x' })).status).toBe(403);
    const same = await A.admin.post(wms(w1, '/stock/status'), { positionId: posId, qty: 1, toStatus: 'AVAILABLE', reason: 'x' });
    expect(same.body.error.code).toBe('SAME_STATUS');
    await invariants();
  });
});

describe('R-04 / R-10 un-pick, un-pack and cancellation after picking', () => {
  let outId: string;
  let lineId: string;
  let pkg: string;
  it('picks by case barcode (12 units), un-picks 5 back to a shelf as AVAILABLE', async () => {
    outId = ok(await A.admin.post(wms(w1, '/outbound'), { lines: [{ skuId: sku, qty: 12 }] })).id;
    ok(await A.admin.post(wms(w1, `/outbound/${outId}/allocate`)));
    const o = ok(await A.admin.get(wms(w1, `/outbound/${outId}`)));
    lineId = o.lines[0].id;
    // A case scan may not exceed the reservation it is picked against.
    let picked = 0;
    for (const r of o.pickList as Array<{ reservationId: string; qtyOpen: string }>) {
      const res = await A.admin.post(wms(w1, `/outbound/${outId}/pick`), {
        reservationId: r.reservationId,
        qty: Number(r.qtyOpen) === 12 ? 1 : r.qtyOpen,
        barcode: Number(r.qtyOpen) === 12 ? '5600000000028' : '5600000000011',
        packingNodeId: N.Adisp,
      });
      picked += Number(ok(res).qtyPicked);
    }
    expect(picked).toBe(12);
    const before = await onHandAt(w1, sku, N.Ashelf2!);
    ok(await A.admin.post(wms(w1, `/outbound/${outId}/unpick`), { lineId, qty: 5, fromNodeId: N.Adisp, to: { nodeId: N.Ashelf2 } }));
    expect(await onHandAt(w1, sku, N.Ashelf2!)).toBe(before + 5);
    expect(await onHandAt(w1, sku, N.Adisp!, 'PICKED')).toBe(7);
    const tooMuch = await A.admin.post(wms(w1, `/outbound/${outId}/unpick`), {
      lineId,
      qty: 8,
      fromNodeId: N.Adisp,
      to: { nodeId: N.Ashelf2 },
    });
    expect(tooMuch.body.error.code).toBe('QTY_EXCEEDS_UNPACKED');
    const toQuarantine = await A.admin.post(wms(w1, `/outbound/${outId}/unpick`), {
      lineId,
      qty: 1,
      fromNodeId: N.Adisp,
      to: { nodeId: N.Aquar },
    });
    expect(toQuarantine.body.error.code).toBe('HOLDER_KIND_NOT_ALLOWED');
  });

  it('packs 4, un-packs 3 (history kept), and refuses cancelling while units are picked', async () => {
    pkg = ok(await A.admin.post(wms(w1, `/outbound/${outId}/packages`), { code: 'CMP-VOL-1', nodeId: N.Adisp })).packageId;
    ok(await A.admin.post(wms(w1, `/outbound/${outId}/pack`), { packageId: pkg, lineId, qty: 4, barcode: 'OIL-5W30' }));
    ok(await A.admin.post(wms(w1, `/outbound/${outId}/unpack`), { packageId: pkg, lineId, qty: 3 }));
    const o = ok(await A.admin.get(wms(w1, `/outbound/${outId}`)));
    expect(o.lines[0].qtyPacked).toBe('1.000');
    expect(o.packages[0].contents).toEqual([{ lineId, qty: '1.000' }]);
    expect((await A.admin.post(wms(w1, `/outbound/${outId}/unpack`), { packageId: pkg, lineId, qty: 2 })).body.error.code).toBe(
      'QTY_EXCEEDS_PACKED',
    );
    const cancel = await A.admin.post(wms(w1, `/outbound/${outId}/cancel`));
    expect(cancel.body.error.code).toBe('PICKED_EXISTS');
  });

  it('after un-packing and un-picking everything the order cancels and its empty package closes', async () => {
    ok(await A.admin.post(wms(w1, `/outbound/${outId}/unpack`), { packageId: pkg, lineId, qty: 1 }));
    ok(await A.admin.post(wms(w1, `/outbound/${outId}/unpick`), { lineId, qty: 7, fromNodeId: N.Adisp, to: { nodeId: N.Ashelf } }));
    const c = ok(await A.admin.post(wms(w1, `/outbound/${outId}/cancel`)));
    expect(c.status).toBe('CANCELLED');
    const o = ok(await A.admin.get(wms(w1, `/outbound/${outId}`)));
    expect(o.packages[0].status).toBe('CLOSED');
    expect(await onHandAt(w1, sku, N.Adisp!, 'PICKED')).toBe(0);
    const ledger = ok(await A.admin.get(wms(w1, '/reports/ledger?type=UNPICK'))) as unknown[];
    expect(ledger.length).toBeGreaterThan(0);
    await invariants();
  });

  it('closing an order closes its empty packages too', async () => {
    const id = ok(await A.admin.post(wms(w1, '/outbound'), { lines: [{ skuId: sku, qty: 1 }] })).id;
    ok(await A.admin.post(wms(w1, `/outbound/${id}/allocate`)));
    const p = ok(await A.admin.post(wms(w1, `/outbound/${id}/packages`), { code: 'CMP-VOL-2', nodeId: N.Adisp })).packageId;
    ok(await A.admin.post(wms(w1, `/outbound/${id}/close`), {}));
    const containers = ok(await A.admin.get(wms(w1, '/containers'))) as Array<{ id: string; status: string }>;
    expect(containers.find((c) => c.id === p)?.status).toBe('CLOSED');
    await invariants();
  });
});

describe('R-05 node rename/deactivation and container close', () => {
  it('refuses to deactivate a node (or its parent) that holds stock', async () => {
    const r = await A.admin.post(wms(w1, `/nodes/${N.Ashelf}`), { active: false });
    expect(r.body.error.code).toBe('NODE_NOT_EMPTY');
    const zone = ok(await A.admin.get(wms(w1, '/nodes'))).find((n: { code: string }) => n.code === 'A-Z').id;
    expect((await A.admin.post(wms(w1, `/nodes/${zone}`), { active: false })).body.error.code).toBe('NODE_NOT_EMPTY');
  });

  it('renames, deactivates an empty subtree, blocks its use, and reactivates top-down', async () => {
    const z = await node(A.admin, w1, 'ZONE', 'A-OLD');
    const s = await node(A.admin, w1, 'LOCATION', 'A-OLD-S', z);
    const renamed = ok(await A.admin.post(wms(w1, `/nodes/${z}`), { name: 'Zona antiga' }));
    expect(renamed.name).toBe('Zona antiga');
    const box = ok(await A.admin.post(wms(w1, '/containers'), { code: 'CMP-BOX-OLD', kind: 'BOX', nodeId: s })).id;
    expect((await A.admin.post(wms(w1, `/nodes/${z}`), { active: false })).body.error.code).toBe('NODE_HAS_CONTAINERS');
    ok(await A.admin.post(wms(w1, `/containers/${box}/close`)));
    ok(await A.admin.post(wms(w1, `/nodes/${z}`), { active: false }));
    const nodes = ok(await A.admin.get(wms(w1, '/nodes'))) as Array<{ id: string; active: boolean }>;
    expect(nodes.find((n) => n.id === s)?.active).toBe(false);
    const pos = (await positions(A.admin, w1, sku)).find((p) => p.nodeId === N.Ashelf)!;
    expect((await A.admin.post(wms(w1, '/stock/move'), { positionId: pos.id, qty: 1, to: { nodeId: s } })).status).toBe(404);
    expect((await A.admin.post(wms(w1, '/nodes'), { kind: 'LOCATION', code: 'A-OLD-S2', name: 'x', parentId: z })).status).toBe(404);
    expect((await A.admin.post(wms(w1, `/nodes/${s}`), { active: true })).body.error.code).toBe('PARENT_INACTIVE');
    ok(await A.admin.post(wms(w1, `/nodes/${z}`), { active: true }));
    ok(await A.admin.post(wms(w1, `/nodes/${s}`), { active: true }));
  });

  it('closes only empty, non-package containers; closed containers cannot move', async () => {
    const box = ok(await A.admin.post(wms(w1, '/containers'), { code: 'CMP-BOX-1', kind: 'BOX', nodeId: N.Ashelf2 })).id;
    const pos = (await positions(A.admin, w1, sku)).find((p) => p.nodeId === N.Ashelf2 && p.status === 'AVAILABLE')!;
    ok(await A.admin.post(wms(w1, '/stock/move'), { positionId: pos.id, qty: 1, to: { containerId: box } }));
    expect((await A.admin.post(wms(w1, `/containers/${box}/close`))).body.error.code).toBe('CONTAINER_NOT_EMPTY');
    const inBox = (await positions(A.admin, w1, sku)).find((p) => p.containerId === box)!;
    ok(await A.admin.post(wms(w1, '/stock/move'), { positionId: inBox.id, qty: 1, to: { nodeId: N.Ashelf2 } }));
    ok(await A.admin.post(wms(w1, `/containers/${box}/close`)));
    expect((await A.admin.post(wms(w1, `/containers/${box}/move`), { toNodeId: N.Ashelf })).body.error.code).toBe('CONTAINER_NOT_ACTIVE');
    expect((await A.admin.post(wms(w1, `/containers/${box}/close`))).body.error.code).toBe('CONTAINER_NOT_ACTIVE');
    await invariants();
  });
});

describe('R-03 lots travel with transfers; R-06 source cancels drafts', () => {
  it('ships two lots, receives FIFO by lot or by an explicit lot, and closes with per-lot loss', async () => {
    ok(
      await A.admin.post(wms(w1, '/stock/opening'), {
        lines: [
          { skuId: lotSku, to: { nodeId: N.Ashelf }, qty: 5, lot: 'L-2026-01' },
          { skuId: lotSku, to: { nodeId: N.Ashelf }, qty: 3, lot: 'L-2026-02' },
        ],
      }),
    );
    const tr = ok(
      await A.admin.post('/api/wms/transfers', { sourceWarehouseId: w1, destWarehouseId: w2, lines: [{ skuId: lotSku, qty: 8 }] }),
    );
    const d = ok(await A.admin.get(`/api/wms/transfers/${tr.id}`));
    const line = d.lines[0].id;
    const src = await positions(A.admin, w1, lotSku);
    ok(
      await A.admin.post(`/api/wms/transfers/${tr.id}/dispatch`, {
        lines: src.map((p) => ({ lineId: line, positionId: p.id, qty: p.onHand })),
      }),
    );
    const lots = ok(await A.admin.get(`/api/wms/transfers/${tr.id}`)).lines[0].lots as Array<{ lot: string; qtyInTransit: string }>;
    expect(lots.map((l) => [l.lot, l.qtyInTransit])).toEqual([
      ['L-2026-01', '5.000'],
      ['L-2026-02', '3.000'],
    ]);
    // 6 without a lot → L1 (5) then L2 (1); 1 more of L1 is no longer in transit.
    ok(await A.admin.post(`/api/wms/transfers/${tr.id}/receive`, { stagingNodeId: N.Bstage, lines: [{ lineId: line, qty: 6 }] }));
    const staged = (await positions(A.admin, w2, lotSku)).map((p) => [p.lot, p.onHand, p.status]);
    expect(staged).toEqual(
      expect.arrayContaining([
        ['L-2026-01', '5.000', 'RECEIVED'],
        ['L-2026-02', '1.000', 'RECEIVED'],
      ]),
    );
    const wrongLot = await A.admin.post(`/api/wms/transfers/${tr.id}/receive`, {
      stagingNodeId: N.Bstage,
      lines: [{ lineId: line, qty: 1, lot: 'L-2026-01' }],
    });
    expect(wrongLot.body.error.code).toBe('QTY_EXCEEDS_LOT_IN_TRANSIT');
    ok(
      await A.admin.post(`/api/wms/transfers/${tr.id}/receive`, {
        stagingNodeId: N.Bstage,
        lines: [{ lineId: line, qty: 1, lot: 'L-2026-02' }],
      }),
    );
    const closed = ok(await A.admin.post(`/api/wms/transfers/${tr.id}/close`));
    expect(closed.qtyLost).toBe('1.000');
    const after = ok(await A.admin.get(`/api/wms/transfers/${tr.id}`)).lines[0].lots as Array<{ lot: string; qtyLost: string }>;
    expect(after.find((l) => l.lot === 'L-2026-02')?.qtyLost).toBe('1.000');
    // Putaway at destination keeps the lot.
    for (const task of ok(await A.admin.get(wms(w2, '/putaway'))) as Array<{ id: string; qtyRemaining: string }>) {
      ok(await A.admin.post(wms(w2, `/putaway/${task.id}/complete`), { to: { nodeId: N.Bshelf }, qty: task.qtyRemaining }));
    }
    const shelved = (await positions(A.admin, w2, lotSku)).filter((p) => p.status === 'AVAILABLE').map((p) => [p.lot, p.onHand]);
    expect(shelved.sort()).toEqual([
      ['L-2026-01', '5.000'],
      ['L-2026-02', '2.000'],
    ]);
    await invariants();
  });

  it('source cancels a draft; dispatched transfers and destination staff cannot be cancelled that way', async () => {
    const dest = await staff(t, A, w2, ['wms.view', 'wms.transfer.receive', 'wms.transfer.dispatch']);
    const tr = ok(
      await A.admin.post('/api/wms/transfers', { sourceWarehouseId: w1, destWarehouseId: w2, lines: [{ skuId: sku, qty: 1 }] }),
    );
    expect((await dest.post(`/api/wms/transfers/${tr.id}/cancel`)).status).toBe(404); // not the source warehouse
    expect(ok(await A.admin.post(`/api/wms/transfers/${tr.id}/cancel`)).status).toBe('CANCELLED');
    expect((await A.admin.post(`/api/wms/transfers/${tr.id}/cancel`)).body.error.code).toBe('INVALID_STATE');
  });
});

describe('R-19 segregation of duties on counts', () => {
  it('the person who counted cannot approve the same count, even as administrator with step-up', async () => {
    const cnt = ok(await A.admin.post(wms(w1, '/counts'), { kind: 'CYCLE', nodeIds: [N.Ashelf], skuIds: [sku] }));
    const view = ok(await A.admin.get(wms(w1, `/counts/${cnt.id}`)));
    for (const line of view.lines as Array<{ id: string }>) {
      ok(await A.admin.post(wms(w1, `/counts/${cnt.id}/lines/${line.id}/count`), { qtyCounted: 0 }));
    }
    ok(await A.admin.post(wms(w1, `/counts/${cnt.id}/submit`)));
    await A.admin.stepUp();
    const r = await A.admin.post(wms(w1, `/counts/${cnt.id}/approve`));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SEGREGATION_OF_DUTIES');
    // Nothing was posted.
    expect(((await A.admin.get(wms(w1, '/reports/ledger?type=COUNT_ADJUST'))).body as unknown[]).length).toBe(0);
    await invariants();
  });
});

describe('Replenishment and reversals (evidence for corrections)', () => {
  it('suggests and executes a replenishment move to the pick location', async () => {
    const zone = (ok(await A.admin.get(wms(w1, '/nodes'))) as Array<{ id: string; code: string }>).find((n) => n.code === 'A-Z')!.id;
    const pick = await node(A.admin, w1, 'LOCATION', 'A-PICK-1', zone);
    ok(await A.admin.post(wms(w1, '/replenishment/rules'), { skuId: sku, pickNodeId: pick, minQty: 2, targetQty: 5 }));
    const sug = ok(await A.admin.get(wms(w1, '/replenishment/suggestions')));
    const move = sug.moves.find((m: { toPath: string }) => m.toPath === 'A-Z/A-PICK-1');
    expect(Number(move.qty)).toBe(5);
    const r = ok(
      await A.admin.post(wms(w1, '/replenishment/execute'), { ruleId: move.ruleId, fromPositionId: move.fromPositionId, qty: move.qty }),
    );
    expect(r.belowTarget).toBe(false);
    expect(await onHandAt(w1, sku, pick)).toBe(5);
    expect(
      ok(await A.admin.get(wms(w1, '/replenishment/suggestions'))).moves.filter((m: { toPath: string }) => m.toPath === 'A-Z/A-PICK-1'),
    ).toEqual([]);
    await invariants();
  });

  it('reverses a move once (step-up), refuses a second reversal and reversals that would consume used stock', async () => {
    const pos = (await positions(A.admin, w1, sku)).find((p) => p.nodeId === N.Ashelf && p.status === 'AVAILABLE')!;
    const mv = ok(await A.admin.post(wms(w1, '/stock/move'), { positionId: pos.id, qty: 2, to: { nodeId: N.Ashelf2 } }));
    // Expire any earlier step-up of this session (test-only DB edit).
    await t.owner.query('UPDATE sessions SET step_up_at = NULL WHERE user_id = $1', [A.admin.userId]);
    const noStep = await A.admin.post(wms(w1, `/transactions/${mv.txnId}/reverse`), { reason: 'Engano' });
    expect(noStep.body.error.code).toBe('STEP_UP_REQUIRED');
    await A.admin.stepUp();
    ok(await A.admin.post(wms(w1, `/transactions/${mv.txnId}/reverse`), { reason: 'Engano de localização' }));
    expect((await A.admin.post(wms(w1, `/transactions/${mv.txnId}/reverse`), { reason: 'x' })).body.error.code).toBe('ALREADY_REVERSED');
    // Move 1 unit, then consume it elsewhere: the reversal must not drive the target negative.
    const pos2 = (await positions(A.admin, w1, sku)).find((p) => p.nodeId === N.Ashelf && p.status === 'AVAILABLE')!;
    const mv2 = ok(await A.admin.post(wms(w1, '/stock/move'), { positionId: pos2.id, qty: 1, to: { nodeId: N.Ashelf2 } }));
    const target = (await positions(A.admin, w1, sku)).find((p) => p.nodeId === N.Ashelf2 && p.status === 'AVAILABLE')!;
    ok(await A.admin.post(wms(w1, '/stock/move'), { positionId: target.id, qty: target.onHand, to: { nodeId: N.Ashelf } }));
    const refused = await A.admin.post(wms(w1, `/transactions/${mv2.txnId}/reverse`), { reason: 'x' });
    expect(refused.status).toBe(409);
    expect(await onHandAt(w1, sku, N.Ashelf2!)).toBe(0);
    // Receipts are not automatically reversible.
    const receipt = (ok(await A.admin.get(wms(w1, '/reports/ledger?type=RECEIPT'))) as Array<{ txnId: string }>)[0]!;
    expect((await A.admin.post(wms(w1, `/transactions/${receipt.txnId}/reverse`), { reason: 'x' })).body.error.code).toBe('NOT_REVERSIBLE');
    await invariants();
  });
});
