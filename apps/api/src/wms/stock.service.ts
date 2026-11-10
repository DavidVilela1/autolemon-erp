/**
 * @file Stock visibility, opening stock, internal moves, audited adjustments and reversals.
 * @module wms
 *
 * Corrections policy: posted inventory history is never edited or deleted. Mistakes in posted
 * work are corrected with (a) a new MOVE (e.g. wrong bin), (b) an audited ADJUST requiring
 * step-up MFA, or (c) a REVERSAL (wms.adjust + step-up) that posts the exact opposite ledger
 * lines of an eligible transaction (each transaction can be reversed at most once — unique
 * reversal_of).
 */
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  AdjustStockInput,
  ChangeStockStatusInput,
  MoveStockInput,
  OpeningStockInput,
  ReverseTransactionInput,
} from '@autolemon/contracts';
import { Conflict, NotFound } from '../common/errors.js';
import { one, row, rows } from '../db/database.js';
import { type Actor, requirePermission, requireStepUp } from '../platform/authz/actor.js';
import type { AuditService } from '../platform/audit/audit.service.js';
import {
  ALLOCATABLE_NODE_KINDS,
  applyDelta,
  assertScanMatches,
  assertFree,
  emitEvent,
  ensurePosition,
  lockPosition,
  newTxn,
  type PositionRow,
  reconcile,
  reconcileReservations,
  relocate,
  requireSku,
  resolveHolder,
} from './inventory/engine.js';
import { neg } from './inventory/qty.js';
import type { WmsRunner } from './runner.js';

/** Transaction types eligible for automatic reversal. */
export const REVERSIBLE_TYPES = ['OPENING', 'MOVE', 'ADJUST', 'REPLENISH', 'CONTAINER_MOVE'] as const;

/** Stock use cases. */
export class StockService {
  constructor(
    private readonly runner: WmsRunner,
    private readonly audit: AuditService,
    private readonly stepUpMinutes: number,
  ) {}

  /** Lists non-empty positions of a warehouse (optionally for one SKU) with holder paths. */
  async positions(actor: Actor, warehouseId: string, skuId?: string) {
    return this.runner.read(actor, warehouseId, 'wms.view', (ctx) =>
      rows(
        ctx.tx,
        sql`SELECT p.id, p.sku_id AS "skuId", s.code AS "skuCode", s.description AS "skuDescription",
              p.holder_node_id AS "nodeId", p.holder_container_id AS "containerId",
              coalesce(n.path, cn.path) AS "nodePath", coalesce(n.kind, cn.kind) AS "nodeKind", c.code AS "containerCode",
              p.stock_status AS status, p.lot_code AS lot, p.qty_on_hand::text AS "onHand", p.qty_reserved::text AS reserved,
              (p.qty_on_hand - p.qty_reserved)::text AS free, p.version::text AS version
            FROM stock_positions p
            JOIN skus s ON s.id = p.sku_id
            LEFT JOIN storage_nodes n ON n.id = p.holder_node_id
            LEFT JOIN containers c ON c.id = p.holder_container_id
            LEFT JOIN storage_nodes cn ON cn.id = c.current_node_id
            WHERE p.warehouse_id = ${warehouseId} AND p.qty_on_hand > 0
              AND (${skuId ?? null}::uuid IS NULL OR p.sku_id = ${skuId ?? null}::uuid)
            ORDER BY s.code, coalesce(n.path, cn.path), c.code NULLS FIRST, p.stock_status`,
      ),
    );
  }

  /**
   * Per-SKU totals of a warehouse: physical on hand by status, reserved and
   * available-to-allocate (AVAILABLE stock in SHELF/BIN/LOCATION holders minus reservations).
   */
  async summary(actor: Actor, warehouseId: string) {
    return this.runner.read(actor, warehouseId, 'wms.view', (ctx) => stockSummary(ctx.tx, warehouseId));
  }

  /** Loads opening stock (requires wms.adjust). Posts an OPENING transaction. */
  async opening(actor: Actor, warehouseId: string, key: string, input: z.infer<typeof OpeningStockInput>) {
    return this.runner.command(actor, warehouseId, 'wms.adjust', key, 'stock.opening', input, async (ctx) => {
      const txnId = await newTxn(ctx, 'OPENING', { note: input.note, idempotencyKey: key });
      for (const l of input.lines) {
        await requireSku(ctx, l.skuId);
        const holder = await resolveHolder(ctx, l.to, { allowedKinds: ['SHELF', 'BIN', 'LOCATION'] });
        const pos = await ensurePosition(ctx, { skuId: l.skuId, holder, status: 'AVAILABLE', lot: l.lot });
        await applyDelta(ctx, txnId, pos, l.qty);
      }
      await emitEvent(ctx, 'wms.stock.opening_posted', 'inventory_transaction', txnId, { lines: input.lines.length });
      return { txnId };
    });
  }

  /** Internal move of unreserved stock to another holder (status unchanged). */
  async move(actor: Actor, warehouseId: string, key: string, input: z.infer<typeof MoveStockInput>) {
    return this.runner.command(actor, warehouseId, 'wms.putaway', key, 'stock.move', input, async (ctx) => {
      const src = await lockPosition(ctx, input.positionId);
      if (src.stock_status !== 'AVAILABLE' && src.stock_status !== 'QUARANTINE' && src.stock_status !== 'DAMAGED') {
        throw new Conflict('Este stock está em processamento e não pode ser movido livremente', 'STATUS_NOT_MOVABLE');
      }
      assertFree(src, input.qty);
      const holder = await resolveHolder(ctx, input.to, {
        allowedKinds:
          src.stock_status === 'AVAILABLE' ? ['SHELF', 'BIN', 'LOCATION'] : ['QUARANTINE', 'INSPECTION', 'SHELF', 'BIN', 'LOCATION'],
      });
      await assertScanMatches(ctx, input.to, input.scan);
      const txnId = await newTxn(ctx, 'MOVE', { note: input.reason, idempotencyKey: key });
      const r = await relocate(ctx, txnId, src, input.qty, { holder, status: src.stock_status });
      return { txnId, targetPositionId: r.target.id };
    });
  }

  /**
   * Quality status change of unreserved stock (posts STATUS_CHANGE, lot preserved):
   *   - block: AVAILABLE/INSPECTION → QUARANTINE/DAMAGED/INSPECTION (wms.adjust);
   *   - release: QUARANTINE/DAMAGED/INSPECTION → AVAILABLE (wms.adjust + recent step-up),
   *     only into an allocatable holder (SHELF/BIN/LOCATION), so released stock is never
   *     stranded in a quarantine area.
   * Both directions are written to the security audit log. Scrapping blocked stock is an
   * ADJUST with reason DAMAGE (also step-up).
   */
  async changeStatus(actor: Actor, warehouseId: string, key: string, input: z.infer<typeof ChangeStockStatusInput>) {
    requirePermission(actor, 'wms.adjust');
    if (input.toStatus === 'AVAILABLE') requireStepUp(actor, 'inventory.adjust.approve', this.stepUpMinutes);
    return this.runner.command(actor, warehouseId, 'wms.adjust', key, 'stock.status', input, async (ctx) => {
      const src = await lockPosition(ctx, input.positionId);
      if (!['AVAILABLE', 'QUARANTINE', 'DAMAGED', 'INSPECTION'].includes(src.stock_status)) {
        throw new Conflict('Este stock está em processamento (receção/expedição)', 'STATUS_NOT_CHANGEABLE');
      }
      if (src.stock_status === input.toStatus) throw new Conflict('O stock já tem este estado', 'SAME_STATUS');
      assertFree(src, input.qty);
      const ref = input.to ?? { nodeId: src.holder_node_id ?? undefined, containerId: src.holder_container_id ?? undefined };
      const holder = await resolveHolder(ctx, ref, {
        allowedKinds: input.toStatus === 'AVAILABLE' ? ALLOCATABLE_NODE_KINDS : ['QUARANTINE', 'INSPECTION', 'SHELF', 'BIN', 'LOCATION'],
      });
      const txnId = await newTxn(ctx, 'STATUS_CHANGE', { note: input.reason, idempotencyKey: key });
      const r = await relocate(ctx, txnId, src, input.qty, { holder, status: input.toStatus });
      await this.audit.recordInTx(ctx.tx, {
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: input.toStatus === 'AVAILABLE' ? 'wms.inventory.release' : 'wms.inventory.block',
        resourceType: 'stock_position',
        resourceId: src.id,
        warehouseId,
        outcome: 'SUCCESS',
        requestId: actor.requestId,
        clientIp: actor.clientIp,
        details: { from: src.stock_status, to: input.toStatus, qty: input.qty, txnId },
      });
      await emitEvent(ctx, 'wms.stock.status_changed', 'stock_position', r.target.id, {
        from: src.stock_status,
        to: input.toStatus,
        qty: input.qty,
      });
      return { txnId, targetPositionId: r.target.id };
    });
  }

  /**
   * Direct audited adjustment of a position (damage, loss, found, data error). Requires
   * wms.adjust AND a recent step-up MFA; written to the security audit log.
   */
  async adjust(actor: Actor, warehouseId: string, key: string, input: z.infer<typeof AdjustStockInput>) {
    requirePermission(actor, 'wms.adjust');
    requireStepUp(actor, 'inventory.adjust.approve', this.stepUpMinutes);
    return this.runner.command(actor, warehouseId, 'wms.adjust', key, 'stock.adjust', input, async (ctx) => {
      const pos = await lockPosition(ctx, input.positionId);
      const txnId = await newTxn(ctx, 'ADJUST', { note: `${input.reasonCode}: ${input.note}`, idempotencyKey: key });
      await applyDelta(ctx, txnId, pos, input.qtyDelta);
      await this.audit.recordInTx(ctx.tx, {
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'wms.inventory.adjust',
        resourceType: 'stock_position',
        resourceId: pos.id,
        warehouseId,
        outcome: 'SUCCESS',
        requestId: actor.requestId,
        clientIp: actor.clientIp,
        details: { qtyDelta: input.qtyDelta, reasonCode: input.reasonCode, txnId },
      });
      await emitEvent(ctx, 'wms.stock.adjusted', 'stock_position', pos.id, { qtyDelta: input.qtyDelta, reasonCode: input.reasonCode });
      return { txnId };
    });
  }

  /**
   * Posts a compensating REVERSAL of an eligible transaction. Each original ledger line is
   * negated on the same position (positions are locked in id order). Fails if stock has since
   * been consumed/reserved (no negative balances, no reservation breakage).
   */
  async reverse(actor: Actor, warehouseId: string, txnId: string, key: string, input: z.infer<typeof ReverseTransactionInput>) {
    // A reversal changes balances exactly like an adjustment: same permission AND step-up.
    requirePermission(actor, 'wms.adjust');
    requireStepUp(actor, 'inventory.adjust.approve', this.stepUpMinutes);
    return this.runner.command(actor, warehouseId, 'wms.adjust', key, 'txn.reverse', { txnId, ...input }, async (ctx) => {
      const t = await row<{ id: string; txn_type: string; reference_id: string | null }>(
        ctx.tx,
        sql`SELECT id, txn_type, reference_id FROM inventory_transactions WHERE id = ${txnId} AND warehouse_id = ${warehouseId}`,
      );
      if (!t) throw new NotFound('Transação');
      if (!(REVERSIBLE_TYPES as readonly string[]).includes(t.txn_type)) {
        throw new Conflict(
          'Este tipo de transação não pode ser revertido automaticamente; use um movimento ou devolução',
          'NOT_REVERSIBLE',
        );
      }
      const already = await row(ctx.tx, sql`SELECT 1 FROM inventory_transactions WHERE reversal_of = ${txnId}`);
      if (already) throw new Conflict('Transação já revertida', 'ALREADY_REVERSED');
      const reversalId = await newTxn(ctx, 'REVERSAL', { reversalOf: txnId, note: input.reason, idempotencyKey: key });
      if (t.txn_type === 'CONTAINER_MOVE') {
        const m = await one<{ container_id: string; from_node_id: string; to_node_id: string }>(
          ctx.tx,
          sql`SELECT container_id, from_node_id, to_node_id FROM container_movements WHERE txn_id = ${txnId}`,
        );
        const c = await one<{ current_node_id: string }>(
          ctx.tx,
          sql`SELECT current_node_id FROM containers WHERE id = ${m.container_id} FOR UPDATE`,
        );
        if (c.current_node_id !== m.to_node_id) throw new Conflict('A caixa já foi movida novamente', 'STALE_REVERSAL');
        await ctx.tx.execute(
          sql`UPDATE containers SET current_node_id = ${m.from_node_id}, updated_at = now() WHERE id = ${m.container_id}`,
        );
        await ctx.tx.execute(
          sql`INSERT INTO container_movements (company_id, warehouse_id, container_id, from_node_id, to_node_id, txn_id, actor_user_id, reason)
              VALUES (${ctx.companyId}, ${warehouseId}, ${m.container_id}, ${m.to_node_id}, ${m.from_node_id}, ${reversalId}, ${actor.userId}, ${input.reason})`,
        );
      } else {
        const lines = await rows<{ position_id: string; qty_delta: string }>(
          ctx.tx,
          sql`SELECT position_id, qty_delta::text FROM inventory_ledger WHERE txn_id = ${txnId} ORDER BY position_id, id`,
        );
        const locked = new Map<string, PositionRow>();
        for (const l of lines) if (!locked.has(l.position_id)) locked.set(l.position_id, await lockPosition(ctx, l.position_id));
        // Apply increases first so a move's reversal never transiently goes negative.
        const ordered = [...lines].sort((a, b) => (a.qty_delta.startsWith('-') ? 1 : 0) - (b.qty_delta.startsWith('-') ? 1 : 0));
        for (const l of ordered) {
          const updated = await applyDelta(ctx, reversalId, locked.get(l.position_id)!, neg(l.qty_delta));
          locked.set(l.position_id, updated);
        }
      }
      await this.audit.recordInTx(ctx.tx, {
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'wms.inventory.reverse',
        resourceType: 'inventory_transaction',
        resourceId: txnId,
        warehouseId,
        outcome: 'SUCCESS',
        requestId: actor.requestId,
        clientIp: actor.clientIp,
        details: { reversalTxnId: reversalId, originalType: t.txn_type },
      });
      return { reversalTxnId: reversalId };
    });
  }

  /** Ledger and reservation reconciliation for a warehouse (both lists must be empty). */
  async reconciliation(actor: Actor, warehouseId: string) {
    return this.runner.read(actor, warehouseId, 'wms.report', async (ctx) => ({
      ledgerMismatches: await reconcile({ tx: ctx.tx, warehouseId }),
      reservationMismatches: await reconcileReservations({ tx: ctx.tx, warehouseId }),
    }));
  }
}

/** Shared summary query (also used by reports). */
export async function stockSummary(tx: Parameters<typeof rows>[0], warehouseId: string) {
  return rows<{
    skuId: string;
    skuCode: string;
    description: string;
    onHand: string;
    available: string;
    received: string;
    inspection: string;
    quarantine: string;
    damaged: string;
    picked: string;
    reserved: string;
    availableToAllocate: string;
    positions: number;
  }>(
    tx,
    sql`SELECT s.id AS "skuId", s.code AS "skuCode", s.description,
          sum(p.qty_on_hand)::text AS "onHand",
          coalesce(sum(p.qty_on_hand) FILTER (WHERE p.stock_status = 'AVAILABLE'), 0.000)::text AS available,
          coalesce(sum(p.qty_on_hand) FILTER (WHERE p.stock_status = 'RECEIVED'), 0.000)::text AS received,
          coalesce(sum(p.qty_on_hand) FILTER (WHERE p.stock_status = 'INSPECTION'), 0.000)::text AS inspection,
          coalesce(sum(p.qty_on_hand) FILTER (WHERE p.stock_status = 'QUARANTINE'), 0.000)::text AS quarantine,
          coalesce(sum(p.qty_on_hand) FILTER (WHERE p.stock_status = 'DAMAGED'), 0.000)::text AS damaged,
          coalesce(sum(p.qty_on_hand) FILTER (WHERE p.stock_status = 'PICKED'), 0.000)::text AS picked,
          sum(p.qty_reserved)::text AS reserved,
          coalesce(sum(p.qty_on_hand - p.qty_reserved) FILTER (
            WHERE p.stock_status = 'AVAILABLE' AND coalesce(n.kind, cn.kind) IN (${sql.join(
              ALLOCATABLE_NODE_KINDS.map((k) => sql`${k}`),
              sql`, `,
            )})), 0.000)::text AS "availableToAllocate",
          count(*)::int AS positions
        FROM stock_positions p
        JOIN skus s ON s.id = p.sku_id
        LEFT JOIN storage_nodes n ON n.id = p.holder_node_id
        LEFT JOIN containers c ON c.id = p.holder_container_id
        LEFT JOIN storage_nodes cn ON cn.id = c.current_node_id
        WHERE p.warehouse_id = ${warehouseId} AND p.qty_on_hand > 0
        GROUP BY s.id, s.code, s.description ORDER BY s.code`,
  );
}
