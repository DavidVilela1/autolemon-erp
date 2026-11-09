/**
 * @file Warehouse acceptance scenarios 1–9 and 12 from the master specification, executed end
 * to end through the real HTTP API against real PostgreSQL (no mocks).
 * @module tests/integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, node, ok, staff, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let A: Tenant;
let porto: string;
let lisboa: string;
let portoStaff: Client;
let lisboaStaff: Client;
let sku: string;
const N: Record<string, string> = {};
let boxId: string;

const summaryFor = async (c: Client, wh: string) => {
  const rows = ok(await c.get(`/api/wms/w/${wh}/stock/summary`)) as Array<Record<string, string>>;
  return rows.find((r) => r.skuCode === 'BRK-001');
};
const positions = async (c: Client, wh: string) => ok(await c.get(`/api/wms/w/${wh}/stock?skuId=${sku}`)) as Array<Record<string, string>>;

beforeAll(async () => {
  t = await startApp();
});
afterAll(async () => {
  await t?.close();
});

describe('Acceptance: autonomous WMS end-to-end (real Postgres)', () => {
  it('1. creates Company A with Porto and Lisboa, warehouse-only staff and an Admin', async () => {
    A = await tenant(t, 'A', ['PORTO', 'LISBOA']);
    porto = A.wh.PORTO!;
    lisboa = A.wh.LISBOA!;
    const all = [
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
    ];
    portoStaff = await staff(t, A, porto, all);
    lisboaStaff = await staff(t, A, lisboa, all);
    const s = ok(await portoStaff.get('/api/auth/session'));
    expect(s.user.role).toBe('STAFF');
    expect(s.warehouses.map((w: { id: string }) => w.id)).toEqual([porto]);
    const adm = ok(await A.admin.get('/api/auth/session'));
    expect(adm.warehouses).toHaveLength(2);

    // Topology (admin) in both warehouses.
    for (const [code, wh] of [
      ['P', porto],
      ['L', lisboa],
    ] as const) {
      const zone = await node(A.admin, wh, 'ZONE', `${code}-Z`);
      const aisle = await node(A.admin, wh, 'AISLE', `${code}-A1`, zone);
      const rack = await node(A.admin, wh, 'RACK', `${code}-R1`, aisle);
      N[`${code}shelf`] = await node(A.admin, wh, 'SHELF', `${code}-S1`, rack);
      N[`${code}shelf2`] = await node(A.admin, wh, 'SHELF', `${code}-S2`, rack);
      N[`${code}bin`] = await node(A.admin, wh, 'BIN', `${code}-S1-B1`, N[`${code}shelf`]);
      N[`${code}stage`] = await node(A.admin, wh, 'STAGING', `${code}-REC`);
      N[`${code}insp`] = await node(A.admin, wh, 'INSPECTION', `${code}-INSP`);
      N[`${code}quar`] = await node(A.admin, wh, 'QUARANTINE', `${code}-QUAR`);
      N[`${code}disp`] = await node(A.admin, wh, 'DISPATCH', `${code}-EXP`);
    }
    boxId = ok(await A.admin.post(`/api/wms/w/${porto}/containers`, { code: 'P-BOX-1', kind: 'BOX', nodeId: N.Pshelf2 })).id;
  });

  it('2. adds SKU BRK-001 and receives 28 of 30 expected units, recording a shortage of 2', async () => {
    sku = ok(
      await A.admin.post('/api/wms/skus', {
        code: 'BRK-001',
        description: 'Pastilhas de travão',
        barcodes: [{ barcode: '5601234567890', uom: 'UN', qtyPerUom: 1 }],
      }),
    ).id;
    const inb = ok(
      await portoStaff.post(`/api/wms/w/${porto}/inbound`, {
        kind: 'EXPECTED',
        externalRef: 'GUIA-FORN-1',
        lines: [{ skuId: sku, qtyExpected: 30 }],
      }),
    );
    ok(await portoStaff.post(`/api/wms/w/${porto}/inbound/${inb.id}/release`));
    // Partial receipts by barcode scan: 20 then 8.
    const r1 = ok(
      await portoStaff.post(`/api/wms/w/${porto}/inbound/${inb.id}/receive`, {
        stagingNodeId: N.Pstage,
        lines: [{ barcode: '5601234567890', qty: 20 }],
      }),
    );
    const r2 = ok(
      await portoStaff.post(`/api/wms/w/${porto}/inbound/${inb.id}/receive`, { stagingNodeId: N.Pstage, lines: [{ skuId: sku, qty: 8 }] }),
    );
    expect(r1.putawayTaskIds).toHaveLength(1);
    expect(r2.putawayTaskIds).toHaveLength(1);
    const closed = ok(await portoStaff.post(`/api/wms/w/${porto}/inbound/${inb.id}/close`));
    expect(closed.short).toBe('2.000');
    const doc = ok(await portoStaff.get(`/api/wms/w/${porto}/inbound/${inb.id}`));
    expect(doc.lines[0].qtyReceived).toBe('28.000');
    expect(doc.lines[0].qtyShort).toBe('2.000');
    const sum = await summaryFor(portoStaff, porto);
    expect(sum?.received).toBe('28.000');
    expect(sum?.availableToAllocate).toBe('0.000'); // staging stock is not allocatable
  });

  it('3. puts away 10 on a direct shelf, 10 in a fixed bin and 8 in a movable box (3 positions, 28 units)', async () => {
    const tasks = ok(await portoStaff.get(`/api/wms/w/${porto}/putaway`)) as Array<{ id: string; qtyRemaining: string }>;
    const t20 = tasks.find((x) => x.qtyRemaining === '20.000')!;
    const t8 = tasks.find((x) => x.qtyRemaining === '8.000')!;
    const sug = ok(await portoStaff.get(`/api/wms/w/${porto}/putaway/${t20.id}/suggestions`));
    expect(Array.isArray(sug)).toBe(true);
    ok(await portoStaff.post(`/api/wms/w/${porto}/putaway/${t20.id}/complete`, { qty: 10, to: { nodeId: N.Pshelf } }));
    const part = ok(await portoStaff.post(`/api/wms/w/${porto}/putaway/${t20.id}/complete`, { qty: 10, to: { nodeId: N.Pbin } }));
    expect(part.taskStatus).toBe('DONE');
    ok(await portoStaff.post(`/api/wms/w/${porto}/putaway/${t8.id}/complete`, { qty: 8, to: { containerId: boxId } }));
    const pos = await positions(portoStaff, porto);
    expect(pos).toHaveLength(3);
    expect(pos.map((p) => p.onHand).sort()).toEqual(['10.000', '10.000', '8.000']);
    expect(pos.every((p) => p.status === 'AVAILABLE')).toBe(true);
    const sum = await summaryFor(portoStaff, porto);
    expect(sum?.onHand).toBe('28.000');
    expect(sum?.availableToAllocate).toBe('28.000');
  });

  let outId: string;
  it('4. reserves 12 for a WMS-native outbound request; available-to-allocate becomes 16', async () => {
    outId = ok(
      await portoStaff.post(`/api/wms/w/${porto}/outbound`, {
        externalRef: 'PEDIDO-BALCAO-7',
        recipientContact: 'Oficina Exemplo, Rua Fictícia 1',
        lines: [{ skuId: sku, qty: 12 }],
      }),
    ).id;
    const alloc = ok(await portoStaff.post(`/api/wms/w/${porto}/outbound/${outId}/allocate`));
    expect(alloc.lines[0].allocated).toBe('12');
    const sum = await summaryFor(portoStaff, porto);
    expect(sum?.availableToAllocate).toBe('16.000');
    expect(sum?.reserved).toBe('12.000');
  });

  it('5. picks (barcode verified) and packs 12 into two packages, dispatches; physical Porto stock becomes 16', async () => {
    const o = ok(await portoStaff.get(`/api/wms/w/${porto}/outbound/${outId}`));
    expect(o.recipientContact).toContain('Oficina Exemplo'); // decrypted for wms.dispatch holders
    // Wrong barcode is rejected.
    const bad = await portoStaff.post(`/api/wms/w/${porto}/outbound/${outId}/pick`, {
      reservationId: o.pickList[0].reservationId,
      qty: 1,
      barcode: 'WRONG-ITEM',
      packingNodeId: N.Pdisp,
    });
    expect(bad.status).toBe(409);
    for (const r of o.pickList) {
      ok(
        await portoStaff.post(`/api/wms/w/${porto}/outbound/${outId}/pick`, {
          reservationId: r.reservationId,
          qty: r.qtyOpen,
          barcode: '5601234567890',
          packingNodeId: N.Pdisp,
        }),
      );
    }
    const lineId = o.lines[0].id;
    const p1 = ok(await portoStaff.post(`/api/wms/w/${porto}/outbound/${outId}/packages`, { code: 'VOL-1', nodeId: N.Pdisp })).packageId;
    const p2 = ok(await portoStaff.post(`/api/wms/w/${porto}/outbound/${outId}/packages`, { code: 'VOL-2', nodeId: N.Pdisp })).packageId;
    ok(await portoStaff.post(`/api/wms/w/${porto}/outbound/${outId}/pack`, { packageId: p1, lineId, qty: 6, barcode: 'BRK-001' }));
    ok(await portoStaff.post(`/api/wms/w/${porto}/outbound/${outId}/pack`, { packageId: p2, lineId, qty: 6, barcode: '5601234567890' }));
    // Partial dispatch: first package, then second.
    const d1 = ok(await portoStaff.post(`/api/wms/w/${porto}/outbound/${outId}/dispatch`, { packageIds: [p1] }));
    expect(d1.orderStatus).toBe('IN_PROGRESS');
    const d2 = ok(await portoStaff.post(`/api/wms/w/${porto}/outbound/${outId}/dispatch`, { packageIds: [p2], carrierRef: 'TRANSP-1' }));
    expect(d2.orderStatus).toBe('CLOSED');
    const sum = await summaryFor(portoStaff, porto);
    expect(sum?.onHand).toBe('16.000');
    expect(sum?.reserved).toBe('0.000');
    const note = ok(await portoStaff.get(`/api/wms/w/${porto}/outbound/${outId}/dispatch-note`));
    expect(note.disclaimer).toMatch(/NÃO é um documento de transporte/);
  });

  it('6. transfers 5 to Lisboa (dispatch → in transit → receive → putaway); Porto 11, Lisboa 5', async () => {
    const tr = ok(
      await portoStaff.post('/api/wms/transfers', { sourceWarehouseId: porto, destWarehouseId: lisboa, lines: [{ skuId: sku, qty: 5 }] }),
    );
    const detail = ok(await portoStaff.get(`/api/wms/transfers/${tr.id}`));
    // Source: the fixed-node position with the most free stock (allocation emptied one of them).
    const src = (await positions(portoStaff, porto))
      .filter((p) => p.nodeId && Number(p.free) >= 5)
      .sort((a, b) => Number(b.free) - Number(a.free))[0]!;
    ok(
      await portoStaff.post(`/api/wms/transfers/${tr.id}/dispatch`, {
        lines: [{ lineId: detail.lines[0].id, positionId: src.id, qty: 5 }],
      }),
    );
    expect((await summaryFor(portoStaff, porto))?.onHand).toBe('11.000');
    const transit = ok(await A.admin.get('/api/wms/reports/in-transit'));
    expect(transit[0].qtyInTransit).toBe('5.000');
    // Lisboa staff sees the transfer header (no Porto internal locations) and receives it.
    const seen = ok(await lisboaStaff.get(`/api/wms/transfers/${tr.id}`));
    expect(JSON.stringify(seen)).not.toContain(N.Pshelf);
    expect(JSON.stringify(seen)).not.toContain(src.id);
    const rec = ok(
      await lisboaStaff.post(`/api/wms/transfers/${tr.id}/receive`, {
        stagingNodeId: N.Lstage,
        lines: [{ lineId: detail.lines[0].id, qty: 5 }],
      }),
    );
    expect(rec.status).toBe('RECEIVED');
    ok(await lisboaStaff.post(`/api/wms/w/${lisboa}/putaway/${rec.putawayTaskIds[0]}/complete`, { qty: 5, to: { nodeId: N.Lbin } }));
    expect((await summaryFor(lisboaStaff, lisboa))?.onHand).toBe('5.000');
    expect((await summaryFor(lisboaStaff, lisboa))?.available).toBe('5.000');
    expect(ok(await A.admin.get('/api/wms/reports/in-transit'))).toHaveLength(0);
    // Company total = 11 + 5 = 16 (no double counting while/after in transit).
  });

  it('7. receives 2 returned units in Porto; releases 1 to saleable and quarantines 1', async () => {
    const ret = ok(
      await portoStaff.post(`/api/wms/w/${porto}/returns`, {
        externalRef: 'DEV-CLIENTE-3',
        inspectionNodeId: N.Pinsp,
        lines: [{ skuId: sku, qty: 2 }],
      }),
    );
    let sum = await summaryFor(portoStaff, porto);
    expect(sum?.inspection).toBe('2.000');
    expect(sum?.onHand).toBe('13.000');
    const list = ok(await portoStaff.get(`/api/wms/w/${porto}/returns`));
    const lineId = list.find((r: { id: string }) => r.id === ret.id).lines[0].lineId;
    const d = ok(
      await portoStaff.post(`/api/wms/w/${porto}/returns/${ret.id}/disposition`, {
        lines: [
          { lineId, disposition: 'SALEABLE', qty: 1, to: { nodeId: N.Pbin } },
          { lineId, disposition: 'QUARANTINE', qty: 1, to: { nodeId: N.Pquar } },
        ],
      }),
    );
    expect(d.status).toBe('CLOSED');
    sum = await summaryFor(portoStaff, porto);
    expect(sum?.available).toBe('12.000');
    expect(sum?.quarantine).toBe('1.000');
    expect(sum?.inspection).toBe('0.000');
    expect(sum?.availableToAllocate).toBe('12.000');
  });

  it('8. counts stock, flags a discrepancy, approves a compensating adjustment (segregated, step-up) and verifies the ledger', async () => {
    // Count the subtree of the fixed node holding the most AVAILABLE units (it may include child
    // bins). The operator finds exactly one unit missing at the target position; all other lines
    // in scope are counted correctly.
    const all = await positions(portoStaff, porto);
    const target = all.filter((p) => p.nodeId && p.status === 'AVAILABLE').sort((a, b) => Number(b.onHand) - Number(a.onHand))[0]!;
    const counted = String(Number(target.onHand) - 1);
    const cnt = ok(await portoStaff.post(`/api/wms/w/${porto}/counts`, { kind: 'CYCLE', nodeIds: [target.nodeId], skuIds: [sku] }));
    expect(cnt.lines).toBeGreaterThanOrEqual(1);
    const view = ok(await portoStaff.get(`/api/wms/w/${porto}/counts/${cnt.id}`));
    expect(view.blind).toBe(true);
    expect(view.lines[0].qtySnapshot).toBeUndefined(); // blind count for operators
    for (const line of view.lines as Array<Record<string, string | null>>) {
      const pos = all.find(
        (p) => p.nodePath === line.nodePath && (p.containerCode ?? null) === (line.containerCode ?? null) && p.status === line.status,
      )!;
      const qty = pos.id === target.id ? counted : pos.onHand;
      ok(await portoStaff.post(`/api/wms/w/${porto}/counts/${cnt.id}/lines/${line.id}/count`, { qtyCounted: qty }));
    }
    const sub = ok(await portoStaff.post(`/api/wms/w/${porto}/counts/${cnt.id}/submit`));
    expect(sub.discrepancies).toBe(1);
    // Staff cannot approve (missing wms.count.approve).
    expect((await portoStaff.post(`/api/wms/w/${porto}/counts/${cnt.id}/approve`)).status).toBe(403);
    // Admin needs step-up first.
    const noStep = await A.admin.post(`/api/wms/w/${porto}/counts/${cnt.id}/approve`);
    expect(noStep.status).toBe(403);
    expect(noStep.body.error.code).toBe('STEP_UP_REQUIRED');
    await A.admin.stepUp();
    const appr = ok(await A.admin.post(`/api/wms/w/${porto}/counts/${cnt.id}/approve`));
    expect(appr.adjustedLines).toBe(1);
    const after = (await positions(portoStaff, porto)).find((p) => p.id === target.id)!;
    expect(Number(after.onHand)).toBe(Number(counted));
    const ledger = ok(await portoStaff.get(`/api/wms/w/${porto}/reports/ledger?type=COUNT_ADJUST`));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].delta).toBe('-1.000');
    const rec = ok(await portoStaff.get(`/api/wms/w/${porto}/stock/reconciliation`));
    expect(rec.ledgerMismatches).toEqual([]);
    expect(rec.reservationMismatches).toEqual([]);
    expect((await summaryFor(portoStaff, porto))?.onHand).toBe('12.000');
  });

  it('9. moves a whole movable box; contents unchanged, location and history updated', async () => {
    const before = (await positions(portoStaff, porto)).find((p) => p.containerId === boxId)!;
    expect(before.onHand).toBe('8.000');
    expect(before.nodePath).toContain('P-S2');
    const mv = ok(await portoStaff.post(`/api/wms/w/${porto}/containers/${boxId}/move`, { toNodeId: N.Pshelf, reason: 'Reorganização' }));
    const after = (await positions(portoStaff, porto)).find((p) => p.containerId === boxId)!;
    expect(after.id).toBe(before.id); // same position, no redistribution
    expect(after.onHand).toBe('8.000');
    expect(after.nodePath).toContain('P-S1');
    const hist = ok(await portoStaff.get(`/api/wms/w/${porto}/containers/${boxId}/history`));
    expect(hist).toHaveLength(1);
    expect(hist[0].txnId).toBe(mv.txnId);
    expect((await summaryFor(portoStaff, porto))?.onHand).toBe('12.000');
  });

  it('12. runs in WMS-only mode (no Sales/Purchasing/Accounting modules installed or required)', async () => {
    const m = ok(await A.admin.get('/api/system/modules'));
    expect(m.modules.map((x: { id: string }) => x.id)).toEqual(['wms']);
    const { resolveModules } = await import('../../apps/api/src/platform/modules/registry.js');
    expect(() => resolveModules('wms,sales')).toThrow(/not installed/);
  });

  it('records outbox events and publishes them with no subscribers (WMS-only)', async () => {
    const n = await t.services.outbox.runOnce();
    expect(n).toBeGreaterThan(5);
    const again = await t.services.outbox.runOnce();
    expect(again).toBe(0);
  });

  it('keeps every invariant: ledger = balances, reservations = reserved, audit chain intact', async () => {
    for (const wh of [porto, lisboa]) {
      const rec = ok(await A.admin.get(`/api/wms/w/${wh}/stock/reconciliation`));
      expect(rec.ledgerMismatches).toEqual([]);
      expect(rec.reservationMismatches).toEqual([]);
    }
    const v = ok(await A.admin.get('/api/admin/audit/verify'));
    expect(v.ok).toBe(true);
    expect(v.checked).toBeGreaterThan(5);
  });
});
