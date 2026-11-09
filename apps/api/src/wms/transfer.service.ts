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
  applyDelta,
  assertFree,
  emitEvent,
  ensurePosition,
  lockPosition,
  newTxn,
  nextDocNumber,
  requireNodeKind,
  requireSku,
  warehouseCode,
} from './inventory/engine.js';
import { cmp, neg, sub } from './inventory/qty.js';
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
              (l.qty_shipped - l.qty_received - l.qty_lost)::text AS "qtyInTransit"
            FROM transfer_lines l JOIN skus s ON s.id = l.sku_id WHERE l.transfer_id = ${id} ORDER BY l.line_no`,
      );
      return { ...h, lines };
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
          const pos = await lockPosition(ctx, l.positionId);
          if (pos.sku_id !== line.sku_id || pos.stock_status !== 'AVAILABLE')
            throw new Conflict('Posição não corresponde ao artigo disponível', 'POSITION_MISMATCH');
          assertFree(pos, l.qty);
          await applyDelta(ctx, txnId, pos, neg(l.qty));
          await ctx.tx.execute(sql`UPDATE transfer_lines SET qty_shipped = qty_shipped + ${l.qty}::numeric WHERE id = ${line.id}`);
        }
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
          const pos = await ensurePosition(ctx, { skuId: line.sku_id, holder: staging, status: 'RECEIVED' });
          await applyDelta(ctx, txnId, pos, l.qty);
          await ctx.tx.execute(sql`UPDATE transfer_lines SET qty_received = qty_received + ${l.qty}::numeric WHERE id = ${line.id}`);
          const task = await one<{ id: string }>(
            ctx.tx,
            sql`INSERT INTO putaway_tasks (company_id, warehouse_id, source_type, source_id, sku_id, source_position_id, qty_total)
              VALUES (${ctx.companyId}, ${ctx.warehouseId}, 'TRANSFER', ${id}, ${line.sku_id}, ${pos.id}, ${l.qty}::numeric) RETURNING id`,
          );
          tasks.push(task.id);
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
      const lost = await one<{ q: string }>(
        ctx.tx,
        sql`SELECT coalesce(sum(qty_shipped - qty_received - qty_lost), 0.000)::text AS q FROM transfer_lines WHERE transfer_id = ${id}`,
      );
      await ctx.tx.execute(sql`UPDATE transfer_lines SET qty_lost = qty_shipped - qty_received WHERE transfer_id = ${id}`);
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

  /** Loads a transfer header visible to the caller (RLS: either side) or 404. */
  private async header(actor: Actor, id: string): Promise<TransferHeader> {
    return this.database.tenantTx(companyScope(actor), (tx) =>
      one<TransferHeader>(tx, sql`SELECT * FROM transfers WHERE id = ${id}`, 'Transferência'),
    );
  }
}
