/**
 * @file Property-based test of inventory invariants against real PostgreSQL.
 * @module tests/integration
 *
 * fast-check generates random sequences of WMS commands (opening, moves, allocations, picks,
 * adjustments — including invalid ones that must be rejected). After every sequence:
 *   L1 ledger sum per position = balance, L2 0 ≤ reserved ≤ on hand (DB CHECK),
 *   L3 reserved = open reservations, and total on hand = sum of accepted deltas (model).
 */
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS, type Permission } from '../../packages/contracts/src/index.js';
import type { Actor } from '../../apps/api/src/platform/authz/actor.js';
import { provisionTenant } from '../../apps/api/src/platform/tenant/provision.js';
import { reconcile, reconcileReservations } from '../../apps/api/src/wms/inventory/engine.js';
import { startApp, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let actor: Actor;
let wh: string;
let sku: string;
let holders: string[] = [];
let disp: string;

const key = () => `p-${randomUUID()}`;

beforeAll(async () => {
  t = await startApp();
  const p = await provisionTenant(t.services.database, t.services.auth, {
    code: `PROP-${randomUUID().slice(0, 6).toUpperCase()}`,
    name: 'Prop',
    adminEmail: `prop-${randomUUID().slice(0, 6)}@x.test`,
    adminName: 'P',
    warehouses: [{ code: 'W', name: 'W' }],
  });
  wh = p.warehouses.W!;
  actor = {
    userId: p.adminId,
    companyId: p.companyId,
    role: 'ADMIN',
    displayName: 'prop',
    warehouseId: null,
    permissions: new Set<Permission>(PERMISSIONS),
    sessionId: randomUUID(),
    stepUpAt: new Date(Date.now() + 3_600_000),
    requestId: 'prop',
    clientIp: '127.0.0.1',
  };
  const s = t.services;
  const z = (await s.topology.createNode(actor, wh, key(), { kind: 'ZONE', code: 'Z', name: 'Z' })).id;
  const r = (await s.topology.createNode(actor, wh, key(), { kind: 'RACK', code: 'R', name: 'R', parentId: z })).id;
  const sh = (await s.topology.createNode(actor, wh, key(), { kind: 'SHELF', code: 'S', name: 'S', parentId: r })).id;
  const b1 = (await s.topology.createNode(actor, wh, key(), { kind: 'BIN', code: 'B1', name: 'B1', parentId: sh })).id;
  const l1 = (await s.topology.createNode(actor, wh, key(), { kind: 'LOCATION', code: 'L1', name: 'L1', parentId: z })).id;
  disp = (await s.topology.createNode(actor, wh, key(), { kind: 'DISPATCH', code: 'D', name: 'D' })).id;
  holders = [sh, b1, l1];
  sku = (await s.skus.create(actor, { code: 'PROP-1', description: 'p', baseUom: 'UN', tracking: 'NONE', barcodes: [] })).id;
});
afterAll(async () => {
  await t?.close();
});

type Cmd =
  | { k: 'open'; h: number; q: number }
  | { k: 'move'; p: number; h: number; q: number }
  | { k: 'alloc'; q: number }
  | { k: 'pick'; r: number; q: number; short: boolean }
  | { k: 'adjust'; p: number; d: number };

const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ k: fc.constant('open' as const), h: fc.nat(2), q: fc.integer({ min: 1, max: 20 }) }),
  fc.record({ k: fc.constant('move' as const), p: fc.nat(10), h: fc.nat(2), q: fc.integer({ min: 1, max: 25 }) }),
  fc.record({ k: fc.constant('alloc' as const), q: fc.integer({ min: 1, max: 30 }) }),
  fc.record({ k: fc.constant('pick' as const), r: fc.nat(10), q: fc.integer({ min: 0, max: 15 }), short: fc.boolean() }),
  fc.record({ k: fc.constant('adjust' as const), p: fc.nat(10), d: fc.integer({ min: -10, max: 10 }).filter((d) => d !== 0) }),
);

describe('Inventory invariants under random command sequences (property-based, real DB)', () => {
  it('never violates ledger/balance/reservation invariants', async () => {
    let modelTotal = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(cmd, { minLength: 5, maxLength: 25 }), async (cmds) => {
        const s = t.services;
        for (const c of cmds) {
          const positions = await s.stock.positions(actor, wh, sku);
          try {
            if (c.k === 'open') {
              await s.stock.opening(actor, wh, key(), { lines: [{ skuId: sku, to: { nodeId: holders[c.h]! }, qty: String(c.q) }] });
              modelTotal += c.q;
            } else if (c.k === 'move' && positions.length) {
              const p = positions[c.p % positions.length] as { id: string };
              await s.stock.move(actor, wh, key(), { positionId: p.id, qty: String(c.q), to: { nodeId: holders[c.h]! } });
            } else if (c.k === 'alloc') {
              const o = await s.outbound.create(actor, wh, key(), { lines: [{ skuId: sku, qty: String(c.q) }] });
              await s.outbound.allocate(actor, wh, o.id, key());
            } else if (c.k === 'pick') {
              const res = await t.owner.query(
                `SELECT r.id, l.outbound_id, r.qty_open::text FROM reservations r JOIN outbound_lines l ON l.id = r.outbound_line_id
                 WHERE r.warehouse_id = $1 AND r.status = 'ACTIVE' ORDER BY r.id`,
                [wh],
              );
              if (res.rows.length) {
                const r = res.rows[c.r % res.rows.length];
                await s.outbound.pick(actor, wh, r.outbound_id, key(), {
                  reservationId: r.id,
                  qty: String(c.q),
                  barcode: 'PROP-1',
                  packingNodeId: disp,
                  closeShort: c.short,
                });
              }
            } else if (c.k === 'adjust' && positions.length) {
              const p = positions[c.p % positions.length] as { id: string; status: string };
              await s.stock.adjust(actor, wh, key(), { positionId: p.id, qtyDelta: String(c.d), reasonCode: 'OTHER', note: 'prop' });
              modelTotal += c.d;
            }
          } catch (e) {
            // Rejections are fine (insufficient stock, zero qty, invalid state…); they must not corrupt state.
            expect((e as { status?: number }).status ?? 500, String(e)).toBeLessThan(500);
          }
        }
        const check = await t.services.database.tenantTx({ companyId: actor.companyId, whScope: wh }, async (tx) => ({
          l1: await reconcile({ tx, warehouseId: wh }),
          l3: await reconcileReservations({ tx, warehouseId: wh }),
        }));
        expect(check.l1).toEqual([]);
        expect(check.l3).toEqual([]);
        const total = await t.owner.query(
          `SELECT coalesce(sum(qty_on_hand), 0)::int AS n, min(qty_on_hand - qty_reserved)::float AS free FROM stock_positions WHERE warehouse_id = $1`,
          [wh],
        );
        expect(total.rows[0].n).toBe(modelTotal);
        expect(total.rows[0].free ?? 0).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 12, endOnFailure: true },
    );
  });
});
