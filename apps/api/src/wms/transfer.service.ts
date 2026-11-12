/**
 * @file Inter-warehouse transfers: source dispatch → in transit → destination receipt → putaway.
 * @module wms
 *
 * Accounting of quantities (no double counting):
 *   - Source dispatch posts TRANSFER_OUT in the source warehouse (stock leaves source).
 *   - While in transit the quantity is held ONLY by the transfer document
 *     (in_transit = shipped − received − lost), never by a stock position.
 *   - Destination receipt posts TRANSFER_IN into a STAGING node (status RECEIVED) and creates
 *     putaway tasks.
 * Visibility: each side acts inside its own warehouse scope. Transfer documents expose
 * warehouse codes/names and SKU quantities only — never internal node/position ids — so
 * neither side can browse the other's internal locations.
 */
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { CreateTransferInput, DispatchTransferInput, ReceiveTransferInput } from '@autolemon/contracts';
import { Conflict, NotFound } from '../common/errors.js';
import type { Database } from '../db/database.js';
import { one, row, rows } from '../db/database.js';
import { type Actor, companyScope, requirePermission } from '../platform/authz/actor.js';
import type { AuditService } from '../platform/audit/audit.service.js';
import {
  allocationCandidates,
  applyDelta,
  assertFree,
  emitEvent,
  ensurePosition,
  lockPosition,
  newTxn,
  nextDocNumber,
  type OpCtx,
  requireNodeKind,
  requireSku,
  warehouseCode,
} from './inventory/engine.js';
import { cmp, fromMilli, min, neg, sub, toMilli } from './inventory/qty.js';
import type { WmsRunner } from './runner.js';

interface TransferHeader {
  id: string;
  number: string;
  source_warehouse_id: string;
  dest_warehouse_id: string;
  status: string;
}

/** Transfer use cases. */
export class TransferService {
  constructor(
    private readonly runner: WmsRunner,
    private readonly database: Database,
    private readonly audit: AuditService,
  ) {}

  /** Lists transfers visible to the caller (admins: all; staff: those touching their warehouse). */
  async list(actor: Actor) {
    requirePermission(actor, 'wms.view');
    return this.database.tenantTx(companyScope(actor), (tx) =>
      rows(
        tx,
        sql`SELECT t.id, t.number, t.status, t.created_at AS "createdAt", t.dispatched_at AS "dispatchedAt",
              t.source_warehouse_id AS "sourceWarehouseId", sw.code AS "sourceCode", sw.name AS "sourceName",
              t.dest_warehouse_id AS "destWarehouseId", dw.code AS "destCode", dw.name AS "destName",
              (SELECT coalesce(sum(qty_shipped - qty_received - qty_lost), 0.000)::text FROM transfer_lines l WHERE l.transfer_id = t.id) AS "qtyInTransit"
            FROM transfers t JOIN warehouses sw ON sw.id = t.source_warehouse_id JOIN warehouses dw ON dw.id = t.dest_warehouse_id
            ORDER BY t.created_at DESC LIMIT 200`,
      ),
    );
  }

  /** Transfer header and lines (no internal location data). */
  async get(actor: Actor, id: string) {
    requirePermission(actor, 'wms.view');
    return this.database.tenantTx(companyScope(actor), async (tx) => {
      const h = await one<Record<string, unknown>>(
        tx,
        sql`SELECT t.id, t.number, t.status, t.source_warehouse_id AS "sourceWarehouseId", sw.code AS "sourceCode",
              t.dest_warehouse_id AS "destWarehouseId", dw.code AS "destCode"
            FROM transfers t JOIN warehouses sw ON sw.id = t.source_warehouse_id JOIN warehouses dw ON dw.id = t.dest_warehouse_id
            WHERE t.id = ${id}`,
        'Transferência',
      );
      const lines = await rows(
        tx,
        sql`SELECT l.id, l.line_no AS "lineNo", l.sku_id AS "skuId", s.code AS "skuCode", l.qty_requested::text AS "qtyRequested",
              l.qty_shipped::text AS "qtyShipped", l.qty_received::text AS "qtyReceived", l.qty_lost::text AS "qtyLost",
              (l.qty_shipped - l.qty_received - l.qty_lost)::text AS "qtyInTransit", l.qty_reserved::text AS "qtyReserved",
              coalesce((SELECT json_agg(json_build_object('lot', x.lot_code, 'qtyShipped', x.qty_shipped::text,
                  'qtyReceived', x.qty_received::text, 'qtyLost', x.qty_lost::text,
                  'qtyInTransit', (x.qty_shipped - x.qty_received - x.qty_lost)::text) ORDER BY x.lot_code)
                FROM transfer_line_lots x WHERE x.transfer_line_id = l.id), '[]') AS lots
            FROM transfer_lines l JOIN skus s ON s.id = l.sku_id WHERE l.transfer_id = ${id} ORDER BY l.line_no`,
      );
      // Pick list for the source: visible only inside the source warehouse scope (RLS), empty otherwise.
      const pickList = await rows(
        tx,
        sql`SELECT r.id AS "reservationId", r.transfer_line_id AS "lineId", r.position_id AS "positionId", s.code AS "skuCode",
              r.qty_open::text AS "qtyOpen", coalesce(n.path, cn.path) AS "nodePath", c.code AS "containerCode",
              nullif(p.lot_code, '') AS lot
            FROM reservations r JOIN transfer_lines l ON l.id = r.transfer_line_id
            JOIN stock_positions p ON p.id = r.position_id JOIN skus s ON s.id = p.sku_id
            LEFT JOIN storage_nodes n ON n.id = p.holder_node_id LEFT JOIN containers c ON c.id = p.holder_container_id
            LEFT JOIN storage_nodes cn ON cn.id = c.current_node_id
            WHERE l.transfer_id = ${id} AND r.status = 'ACTIVE' ORDER BY coalesce(n.path, cn.path), s.code`,
      );
      return { ...h, lines, pickList };
    });
  }

  /** Creates a DRAFT transfer from the caller's (source) warehouse to another warehouse of the company. */
  async create(actor: Actor, key: string, input: z.infer<typeof CreateTransferInput>) {
    if (input.sourceWarehouseId === input.destWarehouseId) throw new Conflict('Origem e destino iguais', 'SAME_WAREHOUSE');
    return this.runner.command(actor, input.sourceWarehouseId, 'wms.transfer.dispatch', key, 'transfer.create', input, async (ctx) => {
      // Destination must be an active warehouse of the SAME company (composite FK also enforces).
      const dest = await row(
        ctx.tx,
        sql`SELECT id FROM warehouses WHERE id = ${input.destWarehouseId} AND company_id = ${ctx.companyId} AND active`,
      );
      if (!dest) throw new NotFound('Armazém de destino');
      const number = await nextDocNumber(ctx, await warehouseCode(ctx), 'TRF');
      const t = await one<{ id: string }>(
        ctx.tx,
        sql`INSERT INTO transfers (company_id, number, source_warehouse_id, dest_warehouse_id, status, created_by)
            VALUES (${ctx.companyId}, ${number}, ${input.sourceWarehouseId}, ${input.destWarehouseId}, 'DRAFT', ${actor.userId}) RETURNING id`,
      );
      let n = 1;
      for (const l of input.lines) {
        await requireSku(ctx, l.skuId);
        await ctx.tx.execute(sql`INSERT INTO transfer_lines (company_id, transfer_id, line_no, sku_id, qty_requested)
            VALUES (${ctx.companyId}, ${t.id}, ${n++}, ${l.skuId}, ${l.qty}::numeric)`);
      }
      return { id: t.id, number };
    });
  }

  /**
   * Source side: reserves stock for every line that is not yet shipped or reserved, using the
   * same allocation policy as outbound orders (FEFO, expired lots excluded, fullest first —
   * ADR-0024/0025). Reserved stock cannot be taken by outbound orders or moves; dispatch then
   * consumes these reservations first. Re-running reserves only the remaining need.
   */
  async allocate(actor: Actor, id: string, key: string) {
    const h = await this.header(actor, id);
    return this.runner.command(actor, h.source_warehouse_id, 'wms.transfer.dispatch', key, 'transfer.allocate', { id }, async (ctx) => {
      const t = await one<TransferHeader>(ctx.tx, sql`SELECT * FROM transfers WHERE id = ${id} FOR UPDATE`, 'Transferência');
      if (!['DRAFT', 'IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(t.status)) throw new Conflict('Transferência fechada', 'INVALID_STATE');
      const lines = await rows<{ id: string; sku_id: string; need: string }>(
        ctx.tx,
        sql`SELECT id, sku_id, (qty_requested - qty_shipped - qty_reserved)::text AS need FROM transfer_lines
            WHERE transfer_id = ${id} ORDER BY line_no FOR UPDATE`,
      );
      const result: Array<{ lineId: string; reserved: string; missing: string }> = [];
      for (const line of lines) {
        let need = toMilli(line.need);
        let got = 0n;
        if (need > 0n) {
          for (const p of await allocationCandidates(ctx, t.source_warehouse_id, line.sku_id, null)) {
            if (need <= 0n) break;
            const free = toMilli(p.qty_on_hand) - toMilli(p.qty_reserved);
            const take = free < need ? free : need;
            if (take <= 0n) continue;
            const q = fromMilli(take);
            await ctx.tx.execute(
              sql`UPDATE stock_positions SET qty_reserved = qty_reserved + ${q}::numeric, updated_at = now() WHERE id = ${p.id}`,
            );
            await ctx.tx.execute(
              sql`INSERT INTO reservations (company_id, warehouse_id, position_id, transfer_line_id, qty_initial, qty_open)
                  VALUES (${ctx.companyId}, ${t.source_warehouse_id}, ${p.id}, ${line.id}, ${q}::numeric, ${q}::numeric)`,
            );
            need -= take;
            got += take;
          }
          if (got > 0n)
            await ctx.tx.execute(
              sql`UPDATE transfer_lines SET qty_reserved = qty_reserved + ${fromMilli(got)}::numeric WHERE id = ${line.id}`,
            );
        }
        result.push({ lineId: line.id, reserved: fromMilli(got), missing: fromMilli(need > 0n ? need : 0n) });
      }
      await emitEvent({ ...ctx, warehouseId: t.source_warehouse_id }, 'wms.transfer.allocated', 'transfer', id, {});
      return { id, lines: result };
    });
  }

  /**
   * Releases `qty` (or everything when undefined) of the ACTIVE reservations of a transfer line,
   * optionally only those on one position; returns the released quantity. Keeps
   * stock_positions.qty_reserved and transfer_lines.qty_reserved in step.
   */
  private async releaseLineReservations(ctx: OpCtx, lineId: string, qty?: string, positionId?: string): Promise<string> {
    const res = await rows<{ id: string; position_id: string; qty_open: string }>(
      ctx.tx,
      sql`SELECT id, position_id, qty_open::text FROM reservations
          WHERE transfer_line_id = ${lineId} AND status = 'ACTIVE' AND (${positionId ?? null}::uuid IS NULL OR position_id = ${positionId ?? null}::uuid)
          ORDER BY id FOR UPDATE`,
    );
    let left = qty === undefined ? null : toMilli(qty);
    let released = 0n;
    for (const r of res) {
      if (left !== null && left <= 0n) break;
      const open = toMilli(r.qty_open);
      const take = left === null || open <= left ? open : left;
      await ctx.tx.execute(
        sql`UPDATE reservations SET qty_open = qty_open - ${fromMilli(take)}::numeric,
              status = CASE WHEN qty_open - ${fromMilli(take)}::numeric = 0 THEN 'CLOSED' ELSE 'ACTIVE' END, updated_at = now()
            WHERE id = ${r.id}`,
      );
      await ctx.tx.execute(
        sql`UPDATE stock_positions SET qty_reserved = qty_reserved - ${fromMilli(take)}::numeric, updated_at = now() WHERE id = ${r.position_id}`,
      );
      released += take;
      if (left !== null) left -= take;
    }
    if (released > 0n)
      await ctx.tx.execute(
        sql`UPDATE transfer_lines SET qty_reserved = qty_reserved - ${fromMilli(released)}::numeric WHERE id = ${lineId}`,
      );
    return fromMilli(released);
  }

  /** Source side: ships quantities from specific source positions (TRANSFER_OUT). */
  async dispatch(actor: Actor, id: string, key: string, input: z.infer<typeof DispatchTransferInput>) {
    const h = await this.header(actor, id);
    return this.runner.command(
      actor,
      h.source_warehouse_id,
      'wms.transfer.dispatch',
      key,
      'transfer.dispatch',
      { id, ...input },
      async (ctx) => {
        const t = await one<TransferHeader>(ctx.tx, sql`SELECT * FROM transfers WHERE id = ${id} FOR UPDATE`, 'Transferência');
        if (!['DRAFT', 'IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(t.status)) throw new Conflict('Transferência fechada', 'INVALID_STATE');
        const txnId = await newTxn(ctx, 'TRANSFER_OUT', { referenceType: 'transfer', referenceId: id, idempotencyKey: key });
        for (const l of input.lines) {
          const line = await one<{ id: string; sku_id: string; qty_requested: string; qty_shipped: string }>(
            ctx.tx,
            sql`SELECT id, sku_id, qty_requested::text, qty_shipped::text FROM transfer_lines WHERE id = ${l.lineId} AND transfer_id = ${id} FOR UPDATE`,
            'Linha',
          );
          if (cmp(l.qty, sub(line.qty_requested, line.qty_shipped)) > 0)
            throw new Conflict('Quantidade superior ao pedido', 'QTY_EXCEEDS_REQUEST');
          const locked = await lockPosition(ctx, l.positionId);
          if (locked.sku_id !== line.sku_id || locked.stock_status !== 'AVAILABLE')
            throw new Conflict('Posição não corresponde ao artigo disponível', 'POSITION_MISMATCH');
          // Units this line reserved on this position are consumed first; the rest must be free.
          await this.releaseLineReservations(ctx, line.id, l.qty, locked.id);
          const pos = await lockPosition(ctx, l.positionId);
          assertFree(pos, l.qty);
          await applyDelta(ctx, txnId, pos, neg(l.qty));
          await ctx.tx.execute(sql`UPDATE transfer_lines SET qty_shipped = qty_shipped + ${l.qty}::numeric WHERE id = ${line.id}`);
          // The lot travels with the goods: in-transit quantity is tracked per lot.
          await ctx.tx.execute(sql`INSERT INTO transfer_line_lots (company_id, transfer_line_id, lot_code, qty_shipped)
              VALUES (${ctx.companyId}, ${line.id}, ${pos.lot_code}, ${l.qty}::numeric)
              ON CONFLICT (transfer_line_id, lot_code) DO UPDATE SET qty_shipped = transfer_line_lots.qty_shipped + EXCLUDED.qty_shipped`);
        }
        // A fully shipped line keeps no reservation (stock may have come from other positions).
        const done = await rows<{ id: string }>(
          ctx.tx,
          sql`SELECT id FROM transfer_lines WHERE transfer_id = ${id} AND qty_shipped >= qty_requested AND qty_reserved > 0`,
        );
        for (const d of done) await this.releaseLineReservations(ctx, d.id);
        await ctx.tx.execute(sql`UPDATE transfers SET status = CASE WHEN status = 'DRAFT' THEN 'IN_TRANSIT' ELSE status END,
          dispatched_at = coalesce(dispatched_at, now()) WHERE id = ${id}`);
        await emitEvent({ ...ctx, warehouseId: t.source_warehouse_id }, 'wms.transfer.dispatched', 'transfer', id, { txnId });
        return { txnId, status: 'IN_TRANSIT' };
      },
    );
  }

  /** Destination side: receives shipped quantities into STAGING (TRANSFER_IN) + putaway tasks. */
  async receive(actor: Actor, id: string, key: string, input: z.infer<typeof ReceiveTransferInput>) {
    const h = await this.header(actor, id);
    return this.runner.command(
      actor,
      h.dest_warehouse_id,
      'wms.transfer.receive',
      key,
      'transfer.receive',
      { id, ...input },
      async (ctx) => {
        const t = await one<TransferHeader>(ctx.tx, sql`SELECT * FROM transfers WHERE id = ${id} FOR UPDATE`, 'Transferência');
        if (!['IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(t.status)) throw new Conflict('Nada em trânsito para receber', 'INVALID_STATE');
        const staging = await requireNodeKind(ctx, input.stagingNodeId, ['STAGING']);
        const txnId = await newTxn(ctx, 'TRANSFER_IN', { referenceType: 'transfer', referenceId: id, idempotencyKey: key });
        const tasks: string[] = [];
        for (const l of input.lines) {
          const line = await one<{ id: string; sku_id: string; in_transit: string }>(
            ctx.tx,
            sql`SELECT id, sku_id, (qty_shipped - qty_received - qty_lost)::text AS in_transit FROM transfer_lines
              WHERE id = ${l.lineId} AND transfer_id = ${id} FOR UPDATE`,
            'Linha',
          );
          if (cmp(l.qty, line.in_transit) > 0) throw new Conflict(`Só há ${line.in_transit} em trânsito`, 'QTY_EXCEEDS_IN_TRANSIT');
          // Receive per lot bucket: the requested lot, or else lots in ascending lot-code order
          // (deterministic; oldest first when lot codes are date-based).
          const buckets = await rows<{ id: string; lot_code: string; left: string }>(
            ctx.tx,
            sql`SELECT id, lot_code, (qty_shipped - qty_received - qty_lost)::text AS left FROM transfer_line_lots
                WHERE transfer_line_id = ${line.id} AND qty_shipped > qty_received + qty_lost
                  AND (${l.lot ?? null}::text IS NULL OR lot_code = ${l.lot ?? ''})
                ORDER BY lot_code, id FOR UPDATE`,
          );
          let remaining = toMilli(l.qty);
          for (const b of buckets) {
            if (remaining <= 0n) break;
            const take = min(b.left, fromMilli(remaining));
            const pos = await ensurePosition(ctx, { skuId: line.sku_id, holder: staging, status: 'RECEIVED', lot: b.lot_code });
            await applyDelta(ctx, txnId, pos, take);
            await ctx.tx.execute(sql`UPDATE transfer_line_lots SET qty_received = qty_received + ${take}::numeric WHERE id = ${b.id}`);
            const task = await one<{ id: string }>(
              ctx.tx,
              sql`INSERT INTO putaway_tasks (company_id, warehouse_id, source_type, source_id, sku_id, source_position_id, qty_total)
                VALUES (${ctx.companyId}, ${ctx.warehouseId}, 'TRANSFER', ${id}, ${line.sku_id}, ${pos.id}, ${take}::numeric) RETURNING id`,
            );
            tasks.push(task.id);
            remaining -= toMilli(take);
          }
          if (remaining > 0n) throw new Conflict('Quantidade superior à do lote em trânsito', 'QTY_EXCEEDS_LOT_IN_TRANSIT');
          await ctx.tx.execute(sql`UPDATE transfer_lines SET qty_received = qty_received + ${l.qty}::numeric WHERE id = ${line.id}`);
        }
        const open = await one<{ n: number }>(
          ctx.tx,
          sql`SELECT count(*)::int AS n FROM transfer_lines WHERE transfer_id = ${id} AND (qty_received + qty_lost < qty_requested)`,
        );
        const status = open.n === 0 ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
        await ctx.tx.execute(sql`UPDATE transfers SET status = ${status} WHERE id = ${id}`);
        await emitEvent({ ...ctx, warehouseId: t.dest_warehouse_id }, 'wms.transfer.received', 'transfer', id, { txnId });
        return { txnId, status, putawayTaskIds: tasks };
      },
    );
  }

  /**
   * Closes a transfer from the destination side. Any quantity still in transit is recorded as
   * LOST (it already left the source ledger), audited as an inventory override.
   */
  async close(actor: Actor, id: string, key: string) {
    const h = await this.header(actor, id);
    return this.runner.command(actor, h.dest_warehouse_id, 'wms.transfer.receive', key, 'transfer.close', { id }, async (ctx) => {
      const t = await one<TransferHeader>(ctx.tx, sql`SELECT * FROM transfers WHERE id = ${id} FOR UPDATE`, 'Transferência');
      if (['CLOSED', 'CANCELLED'].includes(t.status)) throw new Conflict('Transferência já fechada', 'INVALID_STATE');
      // The destination cannot see (RLS) nor release the source's reservations: the source must
      // dispatch or cancel first. transfer_lines.qty_reserved is visible to both sides.
      const held = await one<{ q: string }>(
        ctx.tx,
        sql`SELECT coalesce(sum(qty_reserved), 0)::text AS q FROM transfer_lines WHERE transfer_id = ${id}`,
      );
      if (toMilli(held.q) > 0n) throw new Conflict('A origem ainda tem stock reservado para esta transferência', 'TRANSFER_RESERVED');
      const lost = await one<{ q: string }>(
        ctx.tx,
        sql`SELECT coalesce(sum(qty_shipped - qty_received - qty_lost), 0.000)::text AS q FROM transfer_lines WHERE transfer_id = ${id}`,
      );
      await ctx.tx.execute(sql`UPDATE transfer_lines SET qty_lost = qty_shipped - qty_received WHERE transfer_id = ${id}`);
      await ctx.tx.execute(sql`UPDATE transfer_line_lots SET qty_lost = qty_shipped - qty_received
          WHERE transfer_line_id IN (SELECT id FROM transfer_lines WHERE transfer_id = ${id})`);
      await ctx.tx.execute(
        sql`UPDATE transfers SET status = ${t.status === 'DRAFT' ? 'CANCELLED' : 'CLOSED'}, closed_at = now() WHERE id = ${id}`,
      );
      await this.audit.recordInTx(ctx.tx, {
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'wms.transfer.close',
        resourceType: 'transfer',
        resourceId: id,
        warehouseId: t.dest_warehouse_id,
        outcome: 'SUCCESS',
        requestId: actor.requestId,
        clientIp: actor.clientIp,
        details: { qtyLostInTransit: lost.q },
      });
      return { id, qtyLost: lost.q };
    });
  }

  /** Source side: cancels a DRAFT transfer (nothing shipped yet). */
  async cancel(actor: Actor, id: string, key: string) {
    const h = await this.header(actor, id);
    return this.runner.command(actor, h.source_warehouse_id, 'wms.transfer.dispatch', key, 'transfer.cancel', { id }, async (ctx) => {
      const t = await one<TransferHeader>(ctx.tx, sql`SELECT * FROM transfers WHERE id = ${id} FOR UPDATE`, 'Transferência');
      if (t.status !== 'DRAFT') throw new Conflict('Só transferências por expedir podem ser anuladas pela origem', 'INVALID_STATE');
      for (const l of await rows<{ id: string }>(ctx.tx, sql`SELECT id FROM transfer_lines WHERE transfer_id = ${id} ORDER BY line_no`)) {
        await this.releaseLineReservations(ctx, l.id);
      }
      await ctx.tx.execute(sql`UPDATE transfers SET status = 'CANCELLED', closed_at = now() WHERE id = ${id}`);
      await emitEvent({ ...ctx, warehouseId: t.source_warehouse_id }, 'wms.transfer.cancelled', 'transfer', id, {});
      return { id, status: 'CANCELLED' };
    });
  }

  /** Loads a transfer header visible to the caller (RLS: either side) or 404. */
  private async header(actor: Actor, id: string): Promise<TransferHeader> {
    return this.database.tenantTx(companyScope(actor), (tx) =>
      one<TransferHeader>(tx, sql`SELECT * FROM transfers WHERE id = ${id}`, 'Transferência'),
    );
  }
}
