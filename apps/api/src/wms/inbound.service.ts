/**
 * @file WMS-native inbound: expected/unplanned receipts, partial receiving, shortages/excess,
 * damaged goods, and putaway tasks with destination suggestions.
 * @module wms
 *
 * State machine (docs/WMS_STATE_MACHINES.md §Inbound):
 *   EXPECTED: DRAFT --release--> OPEN --receive--> RECEIVING --close--> CLOSED
 *   UNPLANNED: created directly OPEN (no lines) --receive--> RECEIVING --close--> CLOSED
 *   DRAFT/OPEN (nothing received) --cancel--> CANCELLED
 * Good units land in a STAGING node with status RECEIVED (not allocatable) and get a putaway
 * task; damaged units land in a QUARANTINE/INSPECTION node with status DAMAGED.
 * No purchase order is required (WMS-only mode); externalRef is an optional free reference.
 */
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { CompletePutawayInput, CreateInboundInput, ReceiveInput, ReplaceInboundLinesInput } from '@autolemon/contracts';
import { Conflict, NotFound, ValidationFailed } from '../common/errors.js';
import { one, row, rows } from '../db/database.js';
import type { Actor } from '../platform/authz/actor.js';
import {
  applyDelta,
  assertScanMatches,
  emitEvent,
  ensurePosition,
  lockPosition,
  newTxn,
  nextDocNumber,
  relocate,
  requireNodeKind,
  requireSku,
  scannedBaseQty,
  resolveHolder,
  skuIdForBarcode,
  warehouseCode,
  type OpCtx,
} from './inventory/engine.js';
import { cmp, sub, toMilli } from './inventory/qty.js';
import type { WmsRunner } from './runner.js';

interface InboundRow {
  id: string;
  number: string;
  kind: 'EXPECTED' | 'UNPLANNED';
  status: string;
}

/** Inbound and putaway use cases. */
export class InboundService {
  constructor(private readonly runner: WmsRunner) {}

  /** Lists inbound documents of a warehouse (newest first, bounded). */
  async list(actor: Actor, warehouseId: string) {
    return this.runner.read(actor, warehouseId, 'wms.view', (ctx) =>
      rows(
        ctx.tx,
        sql`SELECT o.id, o.number, o.kind, o.status, o.external_ref AS "externalRef", o.created_at AS "createdAt",
              coalesce(sum(l.qty_expected), 0.000)::text AS "qtyExpected", coalesce(sum(l.qty_received), 0.000)::text AS "qtyReceived"
            FROM inbound_orders o LEFT JOIN inbound_lines l ON l.inbound_id = o.id
            WHERE o.warehouse_id = ${warehouseId} GROUP BY o.id ORDER BY o.created_at DESC LIMIT 200`,
      ),
    );
  }

  /** Inbound document with lines. */
  async get(actor: Actor, warehouseId: string, id: string) {
    return this.runner.read(actor, warehouseId, 'wms.view', async (ctx) => {
      const header = await one<Record<string, unknown>>(
        ctx.tx,
        sql`SELECT id, number, kind, status, external_ref AS "externalRef", note, created_at AS "createdAt", closed_at AS "closedAt"
            FROM inbound_orders WHERE id = ${id} AND warehouse_id = ${warehouseId}`,
        'Entrada',
      );
      const lines = await rows(
        ctx.tx,
        sql`SELECT l.id, l.line_no AS "lineNo", l.sku_id AS "skuId", s.code AS "skuCode", s.description,
              l.qty_expected::text AS "qtyExpected", l.qty_received::text AS "qtyReceived", l.qty_damaged::text AS "qtyDamaged",
              l.qty_short::text AS "qtyShort", l.qty_excess::text AS "qtyExcess"
            FROM inbound_lines l JOIN skus s ON s.id = l.sku_id WHERE l.inbound_id = ${id} ORDER BY l.line_no`,
      );
      return { ...header, lines };
    });
  }

  /** Creates an inbound document (EXPECTED → DRAFT, UNPLANNED → OPEN). */
  async create(actor: Actor, warehouseId: string, key: string, input: z.infer<typeof CreateInboundInput>) {
    return this.runner.command(actor, warehouseId, 'wms.inbound.manage', key, 'inbound.create', input, async (ctx) => {
      if (input.kind === 'EXPECTED' && input.lines.length === 0) {
        throw new ValidationFailed([{ path: 'lines', message: 'Entrada prevista requer linhas' }]);
      }
      const number = await nextDocNumber(ctx, await warehouseCode(ctx), 'ENT');
      const o = await one<{ id: string }>(
        ctx.tx,
        sql`INSERT INTO inbound_orders (company_id, warehouse_id, number, kind, status, external_ref, note, created_by)
            VALUES (${ctx.companyId}, ${warehouseId}, ${number}, ${input.kind}, ${input.kind === 'EXPECTED' ? 'DRAFT' : 'OPEN'},
              ${input.externalRef ?? null}, ${input.note ?? null}, ${actor.userId}) RETURNING id`,
      );
      await this.writeLines(ctx, o.id, input.lines);
      return { id: o.id, number };
    });
  }

  /** Replaces the lines of a DRAFT document (self-service correction before release). */
  async replaceLines(actor: Actor, warehouseId: string, id: string, key: string, input: z.infer<typeof ReplaceInboundLinesInput>) {
    return this.runner.command(actor, warehouseId, 'wms.inbound.manage', key, 'inbound.replace_lines', { id, ...input }, async (ctx) => {
      const o = await this.lockInbound(ctx, id);
      if (o.status !== 'DRAFT') throw new Conflict('Só rascunhos podem ser editados', 'INVALID_STATE');
      // Draft lines carry no stock or history; they may be replaced (not ledger data).
      await ctx.tx.execute(sql`UPDATE inbound_lines SET qty_expected = 0 WHERE inbound_id = ${id}`);
      const existing = await rows<{ id: string; sku_id: string }>(
        ctx.tx,
        sql`SELECT id, sku_id FROM inbound_lines WHERE inbound_id = ${id}`,
      );
      for (const l of input.lines) {
        const match = existing.find((e) => e.sku_id === l.skuId);
        if (match)
          await ctx.tx.execute(
            sql`UPDATE inbound_lines SET qty_expected = qty_expected + ${l.qtyExpected}::numeric WHERE id = ${match.id}`,
          );
        else await this.writeLines(ctx, id, [l]);
      }
      return { id };
    });
  }

  /** DRAFT → OPEN. */
  async release(actor: Actor, warehouseId: string, id: string, key: string) {
    return this.runner.command(actor, warehouseId, 'wms.inbound.manage', key, 'inbound.release', { id }, async (ctx) => {
      const o = await this.lockInbound(ctx, id);
      if (o.status !== 'DRAFT') throw new Conflict('Só rascunhos podem ser libertados', 'INVALID_STATE');
      const n = await one<{ n: number }>(
        ctx.tx,
        sql`SELECT count(*)::int AS n FROM inbound_lines WHERE inbound_id = ${id} AND qty_expected > 0`,
      );
      if (n.n === 0) throw new Conflict('Documento sem linhas', 'EMPTY_DOCUMENT');
      await ctx.tx.execute(sql`UPDATE inbound_orders SET status = 'OPEN' WHERE id = ${id}`);
      return { id, status: 'OPEN' };
    });
  }

  /** Cancels a DRAFT/OPEN document that has nothing received. */
  async cancel(actor: Actor, warehouseId: string, id: string, key: string) {
    return this.runner.command(actor, warehouseId, 'wms.inbound.manage', key, 'inbound.cancel', { id }, async (ctx) => {
      const o = await this.lockInbound(ctx, id);
      if (!['DRAFT', 'OPEN'].includes(o.status)) throw new Conflict('Documento já em receção ou fechado', 'INVALID_STATE');
      await ctx.tx.execute(sql`UPDATE inbound_orders SET status = 'CANCELLED', closed_at = now() WHERE id = ${id}`);
      return { id, status: 'CANCELLED' };
    });
  }

  /**
   * Receives quantities (partial allowed). Lines are matched by lineId, SKU or scanned barcode;
   * unexpected SKUs create excess lines (expected 0). Barcode, when given, must match the SKU.
   */
  async receive(actor: Actor, warehouseId: string, id: string, key: string, input: z.infer<typeof ReceiveInput>) {
    return this.runner.command(actor, warehouseId, 'wms.receive', key, 'inbound.receive', { id, ...input }, async (ctx) => {
      const o = await this.lockInbound(ctx, id);
      if (!['OPEN', 'RECEIVING'].includes(o.status)) throw new Conflict('Documento não está aberto para receção', 'INVALID_STATE');
      const staging = await requireNodeKind(ctx, input.stagingNodeId, ['STAGING']);
      const damagedHolder = input.damagedNodeId ? await requireNodeKind(ctx, input.damagedNodeId, ['QUARANTINE', 'INSPECTION']) : undefined;
      const txnId = await newTxn(ctx, 'RECEIPT', { referenceType: 'inbound', referenceId: id, idempotencyKey: key });
      const tasks: string[] = [];
      const received: Array<{ lineId: string; skuCode: string; qty: string }> = [];
      for (const l of input.lines) {
        const line = await this.resolveLine(ctx, id, l);
        const sku = await requireSku(ctx, line.sku_id);
        // A scan counts packs of the scanned barcode's unit (e.g. case of 12) → base units.
        const qty = l.barcode ? await scannedBaseQty(ctx, line.sku_id, l.barcode, l.qty) : l.qty;
        received.push({ lineId: line.id, skuCode: sku.code, qty });
        if (sku.tracking !== 'NONE' && !l.lot) throw new ValidationFailed([{ path: 'lot', message: `Lote obrigatório para ${sku.code}` }]);
        if (l.condition === 'DAMAGED') {
          if (!damagedHolder) throw new ValidationFailed([{ path: 'damagedNodeId', message: 'Indique a zona de quarentena/inspeção' }]);
          const pos = await ensurePosition(ctx, { skuId: line.sku_id, holder: damagedHolder, status: 'DAMAGED', lot: l.lot });
          await applyDelta(ctx, txnId, pos, qty);
          await ctx.tx.execute(
            sql`UPDATE inbound_lines SET qty_received = qty_received + ${qty}::numeric, qty_damaged = qty_damaged + ${qty}::numeric WHERE id = ${line.id}`,
          );
        } else {
          const pos = await ensurePosition(ctx, { skuId: line.sku_id, holder: staging, status: 'RECEIVED', lot: l.lot });
          await applyDelta(ctx, txnId, pos, qty);
          await ctx.tx.execute(sql`UPDATE inbound_lines SET qty_received = qty_received + ${qty}::numeric WHERE id = ${line.id}`);
          const t = await one<{ id: string }>(
            ctx.tx,
            sql`INSERT INTO putaway_tasks (company_id, warehouse_id, source_type, source_id, sku_id, source_position_id, qty_total)
                VALUES (${ctx.companyId}, ${warehouseId}, 'INBOUND', ${id}, ${line.sku_id}, ${pos.id}, ${qty}::numeric) RETURNING id`,
          );
          tasks.push(t.id);
        }
      }
      await ctx.tx.execute(sql`UPDATE inbound_orders SET status = 'RECEIVING' WHERE id = ${id}`);
      await emitEvent(ctx, 'wms.inbound.received', 'inbound', id, { txnId, lines: input.lines.length });
      return { txnId, putawayTaskIds: tasks, received };
    });
  }

  /** Closes receiving, recording shortages and excess per line. */
  async close(actor: Actor, warehouseId: string, id: string, key: string) {
    return this.runner.command(actor, warehouseId, 'wms.receive', key, 'inbound.close', { id }, async (ctx) => {
      const o = await this.lockInbound(ctx, id);
      if (!['OPEN', 'RECEIVING'].includes(o.status)) throw new Conflict('Documento não pode ser fechado', 'INVALID_STATE');
      await ctx.tx.execute(sql`UPDATE inbound_lines SET
          qty_short = GREATEST(qty_expected - qty_received, 0), qty_excess = GREATEST(qty_received - qty_expected, 0)
          WHERE inbound_id = ${id}`);
      await ctx.tx.execute(sql`UPDATE inbound_orders SET status = 'CLOSED', closed_at = now() WHERE id = ${id}`);
      const totals = await one<{ short: string; excess: string; damaged: string }>(
        ctx.tx,
        sql`SELECT sum(qty_short)::text AS short, sum(qty_excess)::text AS excess, sum(qty_damaged)::text AS damaged
            FROM inbound_lines WHERE inbound_id = ${id}`,
      );
      await emitEvent(ctx, 'wms.inbound.closed', 'inbound', id, totals);
      return { id, status: 'CLOSED', ...totals };
    });
  }

  // ------------------------------------------------------------------ putaway

  /** Open putaway tasks of a warehouse. */
  async putawayTasks(actor: Actor, warehouseId: string) {
    return this.runner.read(actor, warehouseId, 'wms.view', (ctx) =>
      rows(
        ctx.tx,
        sql`SELECT t.id, t.source_type AS "sourceType", t.source_id AS "sourceId", t.sku_id AS "skuId", s.code AS "skuCode",
              s.description, t.qty_total::text AS "qtyTotal", t.qty_done::text AS "qtyDone",
              (t.qty_total - t.qty_done)::text AS "qtyRemaining", n.path AS "stagingPath", t.created_at AS "createdAt"
            FROM putaway_tasks t JOIN skus s ON s.id = t.sku_id
            JOIN stock_positions p ON p.id = t.source_position_id JOIN storage_nodes n ON n.id = p.holder_node_id
            WHERE t.warehouse_id = ${warehouseId} AND t.status = 'OPEN' ORDER BY t.created_at`,
      ),
    );
  }

  /**
   * Destination suggestions: (1) holders already containing the same SKU as AVAILABLE
   * (consolidation), then (2) empty stock-holding BIN/LOCATION/SHELF nodes.
   */
  async suggestions(actor: Actor, warehouseId: string, taskId: string) {
    return this.runner.read(actor, warehouseId, 'wms.view', async (ctx) => {
      const t = await one<{ sku_id: string }>(
        ctx.tx,
        sql`SELECT sku_id FROM putaway_tasks WHERE id = ${taskId} AND warehouse_id = ${warehouseId}`,
        'Tarefa',
      );
      const consolidate = await rows(
        ctx.tx,
        sql`SELECT p.holder_node_id AS "nodeId", p.holder_container_id AS "containerId",
              coalesce(n.path, cn.path) AS path, c.code AS "containerCode", p.qty_on_hand::text AS "currentQty", 'CONSOLIDATE' AS reason
            FROM stock_positions p
            LEFT JOIN storage_nodes n ON n.id = p.holder_node_id
            LEFT JOIN containers c ON c.id = p.holder_container_id LEFT JOIN storage_nodes cn ON cn.id = c.current_node_id
            WHERE p.warehouse_id = ${warehouseId} AND p.sku_id = ${t.sku_id} AND p.stock_status = 'AVAILABLE' AND p.qty_on_hand > 0
              AND coalesce(n.kind, cn.kind) IN ('SHELF', 'BIN', 'LOCATION')
            ORDER BY p.qty_on_hand DESC LIMIT 5`,
      );
      const empty = await rows(
        ctx.tx,
        sql`SELECT n.id AS "nodeId", NULL AS "containerId", n.path, NULL AS "containerCode", '0' AS "currentQty", 'EMPTY' AS reason
            FROM storage_nodes n
            WHERE n.warehouse_id = ${warehouseId} AND n.active AND n.holds_stock AND n.kind IN ('BIN', 'LOCATION', 'SHELF')
              AND NOT EXISTS (SELECT 1 FROM stock_positions p WHERE p.holder_node_id = n.id AND p.qty_on_hand > 0)
              AND NOT EXISTS (SELECT 1 FROM containers c WHERE c.current_node_id = n.id AND c.status = 'ACTIVE')
            ORDER BY n.path LIMIT 5`,
      );
      return [...consolidate, ...empty];
    });
  }

  /** Completes (part of) a putaway task: RECEIVED staging stock → AVAILABLE at the target. */
  async completePutaway(actor: Actor, warehouseId: string, taskId: string, key: string, input: z.infer<typeof CompletePutawayInput>) {
    return this.runner.command(actor, warehouseId, 'wms.putaway', key, 'putaway.complete', { taskId, ...input }, async (ctx) => {
      const t = await row<{ id: string; status: string; qty_total: string; qty_done: string; source_position_id: string }>(
        ctx.tx,
        sql`SELECT id, status, qty_total::text, qty_done::text, source_position_id FROM putaway_tasks
            WHERE id = ${taskId} AND warehouse_id = ${warehouseId} FOR UPDATE`,
      );
      if (!t) throw new NotFound('Tarefa de arrumação');
      if (t.status !== 'OPEN') throw new Conflict('Tarefa já concluída', 'INVALID_STATE');
      const remaining = sub(t.qty_total, t.qty_done);
      if (cmp(input.qty, remaining) > 0) throw new Conflict(`Quantidade superior ao pendente (${remaining})`, 'QTY_EXCEEDS_TASK');
      const holder = await resolveHolder(ctx, input.to, { allowedKinds: ['SHELF', 'BIN', 'LOCATION'] });
      await assertScanMatches(ctx, input.to, input.scan);
      const src = await lockPosition(ctx, t.source_position_id);
      const txnId = await newTxn(ctx, 'PUTAWAY', { referenceType: 'putaway_task', referenceId: taskId, idempotencyKey: key });
      const r = await relocate(ctx, txnId, src, input.qty, { holder, status: 'AVAILABLE' });
      const done = toMilli(t.qty_done) + toMilli(input.qty) === toMilli(t.qty_total);
      await ctx.tx.execute(
        sql`UPDATE putaway_tasks SET qty_done = qty_done + ${input.qty}::numeric, status = ${done ? 'DONE' : 'OPEN'}, updated_at = now() WHERE id = ${taskId}`,
      );
      await emitEvent(ctx, 'wms.putaway.completed', 'putaway_task', taskId, { qty: input.qty, txnId });
      return { txnId, targetPositionId: r.target.id, taskStatus: done ? 'DONE' : 'OPEN' };
    });
  }

  // ------------------------------------------------------------------ internals

  private async lockInbound(ctx: OpCtx, id: string): Promise<InboundRow> {
    const o = await row<InboundRow>(
      ctx.tx,
      sql`SELECT id, number, kind, status FROM inbound_orders WHERE id = ${id} AND warehouse_id = ${ctx.warehouseId} FOR UPDATE`,
    );
    if (!o) throw new NotFound('Entrada');
    return o;
  }

  private async writeLines(ctx: OpCtx, inboundId: string, lines: Array<{ skuId: string; qtyExpected: string }>) {
    for (const l of lines) {
      await requireSku(ctx, l.skuId);
      await ctx.tx.execute(
        sql`INSERT INTO inbound_lines (company_id, warehouse_id, inbound_id, line_no, sku_id, qty_expected)
            VALUES (${ctx.companyId}, ${ctx.warehouseId}, ${inboundId},
              (SELECT coalesce(max(line_no), 0) + 1 FROM inbound_lines WHERE inbound_id = ${inboundId}), ${l.skuId}, ${l.qtyExpected}::numeric)`,
      );
    }
  }

  private async resolveLine(ctx: OpCtx, inboundId: string, l: { lineId?: string; skuId?: string; barcode?: string }) {
    if (l.lineId) {
      return one<{ id: string; sku_id: string }>(
        ctx.tx,
        sql`SELECT id, sku_id FROM inbound_lines WHERE id = ${l.lineId} AND inbound_id = ${inboundId} FOR UPDATE`,
        'Linha',
      );
    }
    const skuId = l.skuId ?? (l.barcode ? await skuIdForBarcode(ctx, l.barcode) : undefined);
    if (!skuId) throw new NotFound('Artigo para o código lido');
    const existing = await row<{ id: string; sku_id: string }>(
      ctx.tx,
      sql`SELECT id, sku_id FROM inbound_lines WHERE inbound_id = ${inboundId} AND sku_id = ${skuId} ORDER BY line_no LIMIT 1 FOR UPDATE`,
    );
    if (existing) return existing;
    await this.writeLines(ctx, inboundId, [{ skuId, qtyExpected: '0' }]);
    return one<{ id: string; sku_id: string }>(
      ctx.tx,
      sql`SELECT id, sku_id FROM inbound_lines WHERE inbound_id = ${inboundId} AND sku_id = ${skuId} ORDER BY line_no LIMIT 1 FOR UPDATE`,
    );
  }
}
