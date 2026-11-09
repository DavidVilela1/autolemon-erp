/**
 * @file Stock counts: full / partial / cycle, blind counting, recounts, discrepancy approval
 * with segregation of duties and compensating COUNT_ADJUST transactions.
 * @module wms
 *
 * Concurrency policy — snapshot + optimistic version check (no warehouse freeze):
 *   each line snapshots qty_on_hand and the position `version`. Any stock movement increments
 *   the version. On submit and on approval, lines whose position changed are marked STALE and
 *   approval is refused until they are recounted. This keeps the warehouse operating while
 *   guaranteeing that adjustments are computed against the quantity actually counted.
 * Blind count: counters do not see expected quantities (only users with wms.count.approve do).
 * Segregation of duties: the approver must not be any of the counters, needs
 * wms.count.approve and a recent step-up MFA; approval is security-audited.
 */
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { CreateCountInput, FoundStockInput, RecordCountInput } from '@autolemon/contracts';
import { Conflict, NotFound } from '../common/errors.js';
import { one, row, rows } from '../db/database.js';
import { type Actor, hasPermission, requirePermission, requireStepUp } from '../platform/authz/actor.js';
import type { AuditService } from '../platform/audit/audit.service.js';
import {
  applyDelta,
  emitEvent,
  ensurePosition,
  lockPosition,
  newTxn,
  nextDocNumber,
  requireSku,
  resolveHolder,
  warehouseCode,
  type OpCtx,
} from './inventory/engine.js';
import { cmp, sub, toMilli } from './inventory/qty.js';
import type { WmsRunner } from './runner.js';

/** Statuses that are counted (in-process RECEIVED/PICKED stock is excluded). */
const COUNTED_STATUSES = ['AVAILABLE', 'QUARANTINE', 'DAMAGED', 'INSPECTION'];

/** Count use cases. */
export class CountService {
  constructor(
    private readonly runner: WmsRunner,
    private readonly audit: AuditService,
    private readonly stepUpMinutes: number,
  ) {}

  /** Lists count sessions. */
  async list(actor: Actor, warehouseId: string) {
    return this.runner.read(actor, warehouseId, 'wms.count', (ctx) =>
      rows(
        ctx.tx,
        sql`SELECT id, number, kind, status, created_at AS "createdAt", approved_at AS "approvedAt" FROM count_sessions
            WHERE warehouse_id = ${warehouseId} ORDER BY created_at DESC LIMIT 100`,
      ),
    );
  }

  /** Session with lines; expected quantities and deltas only for approvers (blind count). */
  async get(actor: Actor, warehouseId: string, id: string) {
    return this.runner.read(actor, warehouseId, 'wms.count', async (ctx) => {
      const h = await one<Record<string, unknown>>(
        ctx.tx,
        sql`SELECT id, number, kind, status, created_at AS "createdAt" FROM count_sessions WHERE id = ${id} AND warehouse_id = ${warehouseId}`,
        'Contagem',
      );
      const reveal = hasPermission(actor, 'wms.count.approve');
      const lines = await rows<Record<string, unknown>>(
        ctx.tx,
        sql`SELECT l.id, l.sku_id AS "skuId", s.code AS "skuCode", l.stock_status AS status, l.lot_code AS lot,
              coalesce(n.path, cn.path) AS "nodePath", c.code AS "containerCode",
              l.qty_snapshot::text AS "qtySnapshot", l.qty_counted::text AS "qtyCounted", l.state,
              (l.qty_counted - l.qty_snapshot)::text AS delta
            FROM count_lines l JOIN skus s ON s.id = l.sku_id
            LEFT JOIN storage_nodes n ON n.id = l.holder_node_id
            LEFT JOIN containers c ON c.id = l.holder_container_id LEFT JOIN storage_nodes cn ON cn.id = c.current_node_id
            WHERE l.session_id = ${id} ORDER BY coalesce(n.path, cn.path), c.code NULLS FIRST, s.code`,
      );
      return {
        ...h,
        blind: !reveal,
        lines: reveal ? lines : lines.map(({ qtySnapshot: _a, delta: _b, ...rest }) => rest),
      };
    });
  }

  /** Opens a count and snapshots in-scope positions (by node subtree and/or SKU). */
  async create(actor: Actor, warehouseId: string, key: string, input: z.infer<typeof CreateCountInput>) {
    return this.runner.command(actor, warehouseId, 'wms.count', key, 'count.create', input, async (ctx) => {
      if (input.kind !== 'FULL' && !input.nodeIds.length && !input.skuIds.length) {
        throw new Conflict('Contagem parcial/cíclica requer localizações ou artigos', 'SCOPE_REQUIRED');
      }
      const paths = input.nodeIds.length
        ? await rows<{ path: string }>(
            ctx.tx,
            sql`SELECT path FROM storage_nodes WHERE warehouse_id = ${warehouseId} AND id IN (${sql.join(
              input.nodeIds.map((i) => sql`${i}`),
              sql`, `,
            )})`,
          )
        : [];
      if (paths.length !== input.nodeIds.length) throw new NotFound('Localização');
      const number = await nextDocNumber(ctx, await warehouseCode(ctx), 'CNT');
      const s = await one<{ id: string }>(
        ctx.tx,
        sql`INSERT INTO count_sessions (company_id, warehouse_id, number, kind, status, scope, created_by)
            VALUES (${ctx.companyId}, ${warehouseId}, ${number}, ${input.kind}, 'OPEN',
              ${JSON.stringify({ nodeIds: input.nodeIds, skuIds: input.skuIds })}::jsonb, ${actor.userId}) RETURNING id`,
      );
      const pathFilter = paths.length
        ? sql`AND (${sql.join(
            paths.map(
              (p) =>
                sql`(coalesce(n.path, cn.path) = ${p.path} OR coalesce(n.path, cn.path) LIKE ${`${p.path.replace(/[\\%_]/g, (m) => `\\${m}`)}/%`})`,
            ),
            sql` OR `,
          )})`
        : sql``;
      const skuFilter = input.skuIds.length
        ? sql`AND p.sku_id IN (${sql.join(
            input.skuIds.map((i) => sql`${i}`),
            sql`, `,
          )})`
        : sql``;
      const r = await rows<{ n: number }>(
        ctx.tx,
        sql`WITH ins AS (
              INSERT INTO count_lines (company_id, warehouse_id, session_id, position_id, sku_id, holder_node_id, holder_container_id,
                stock_status, lot_code, qty_snapshot, version_snapshot)
              SELECT p.company_id, p.warehouse_id, ${s.id}, p.id, p.sku_id, p.holder_node_id, p.holder_container_id,
                p.stock_status, p.lot_code, p.qty_on_hand, p.version
              FROM stock_positions p
              LEFT JOIN storage_nodes n ON n.id = p.holder_node_id
              LEFT JOIN containers c ON c.id = p.holder_container_id LEFT JOIN storage_nodes cn ON cn.id = c.current_node_id
              WHERE p.warehouse_id = ${warehouseId} AND p.qty_on_hand > 0
                AND p.stock_status IN (${sql.join(
                  COUNTED_STATUSES.map((x) => sql`${x}`),
                  sql`, `,
                )})
                AND (c.id IS NULL OR c.kind <> 'PACKAGE') ${pathFilter} ${skuFilter}
              RETURNING 1)
            SELECT count(*)::int AS n FROM ins`,
      );
      return { id: s.id, number, lines: r[0]?.n ?? 0 };
    });
  }

  /** Records a counted quantity (blind). */
  async record(actor: Actor, warehouseId: string, id: string, lineId: string, key: string, input: z.infer<typeof RecordCountInput>) {
    return this.runner.command(actor, warehouseId, 'wms.count', key, 'count.record', { id, lineId, ...input }, async (ctx) => {
      await this.lockSession(ctx, id, ['OPEN']);
      const l = await row(ctx.tx, sql`SELECT id FROM count_lines WHERE id = ${lineId} AND session_id = ${id} FOR UPDATE`);
      if (!l) throw new NotFound('Linha de contagem');
      await ctx.tx.execute(sql`UPDATE count_lines SET qty_counted = ${input.qtyCounted}::numeric, counted_by = ${actor.userId},
          counted_at = now(), state = 'COUNTED' WHERE id = ${lineId}`);
      return { lineId, state: 'COUNTED' };
    });
  }

  /** Records stock found in a holder where the system expected none. */
  async found(actor: Actor, warehouseId: string, id: string, key: string, input: z.infer<typeof FoundStockInput>) {
    return this.runner.command(actor, warehouseId, 'wms.count', key, 'count.found', { id, ...input }, async (ctx) => {
      await this.lockSession(ctx, id, ['OPEN']);
      await requireSku(ctx, input.skuId);
      const holder = await resolveHolder(ctx, input.holder, { allowedKinds: ['SHELF', 'BIN', 'LOCATION'] });
      const l = await one<{ id: string }>(
        ctx.tx,
        sql`INSERT INTO count_lines (company_id, warehouse_id, session_id, position_id, sku_id, holder_node_id, holder_container_id,
              stock_status, lot_code, qty_snapshot, version_snapshot, qty_counted, counted_by, counted_at, state)
            VALUES (${ctx.companyId}, ${warehouseId}, ${id}, NULL, ${input.skuId}, ${holder.nodeId ?? null}, ${holder.containerId ?? null},
              'AVAILABLE', ${input.lot ?? ''}, 0, -1, ${input.qtyCounted}::numeric, ${actor.userId}, now(), 'COUNTED') RETURNING id`,
      );
      return { lineId: l.id };
    });
  }

  /** Submits the count: all lines must be counted; changed positions are flagged STALE. */
  async submit(actor: Actor, warehouseId: string, id: string, key: string) {
    return this.runner.command(actor, warehouseId, 'wms.count', key, 'count.submit', { id }, async (ctx) => {
      await this.lockSession(ctx, id, ['OPEN']);
      const pending = await one<{ n: number }>(
        ctx.tx,
        sql`SELECT count(*)::int AS n FROM count_lines WHERE session_id = ${id} AND state = 'PENDING'`,
      );
      if (pending.n > 0) throw new Conflict(`${pending.n} linha(s) por contar`, 'COUNT_INCOMPLETE');
      const stale = await this.markStale(ctx, id);
      await ctx.tx.execute(sql`UPDATE count_sessions SET status = 'SUBMITTED', submitted_at = now() WHERE id = ${id}`);
      const disc = await one<{ n: number }>(
        ctx.tx,
        sql`SELECT count(*)::int AS n FROM count_lines WHERE session_id = ${id} AND qty_counted <> qty_snapshot`,
      );
      return { id, status: 'SUBMITTED', staleLines: stale, discrepancies: disc.n };
    });
  }

  /** Re-snapshots a line for recount (OPEN or SUBMITTED sessions; reopens the session). */
  async recount(actor: Actor, warehouseId: string, id: string, lineId: string, key: string) {
    return this.runner.command(actor, warehouseId, 'wms.count', key, 'count.recount', { id, lineId }, async (ctx) => {
      await this.lockSession(ctx, id, ['OPEN', 'SUBMITTED']);
      const l = await row<{ position_id: string | null }>(
        ctx.tx,
        sql`SELECT position_id FROM count_lines WHERE id = ${lineId} AND session_id = ${id} FOR UPDATE`,
      );
      if (!l) throw new NotFound('Linha de contagem');
      if (l.position_id) {
        await ctx.tx.execute(sql`UPDATE count_lines cl SET qty_snapshot = p.qty_on_hand, version_snapshot = p.version,
            qty_counted = NULL, counted_by = NULL, counted_at = NULL, state = 'PENDING'
            FROM stock_positions p WHERE cl.id = ${lineId} AND p.id = cl.position_id`);
      } else {
        await ctx.tx.execute(
          sql`UPDATE count_lines SET qty_counted = NULL, counted_by = NULL, counted_at = NULL, state = 'PENDING' WHERE id = ${lineId}`,
        );
      }
      await ctx.tx.execute(sql`UPDATE count_sessions SET status = 'OPEN' WHERE id = ${id}`);
      return { lineId, state: 'PENDING' };
    });
  }

  /**
   * Approves a SUBMITTED count and posts compensating COUNT_ADJUST deltas
   * (counted − current on hand) for every discrepancy. Refuses when any line is stale, when the
   * approver counted lines, or when an adjustment would cut into reserved stock.
   */
  async approve(actor: Actor, warehouseId: string, id: string, key: string) {
    requirePermission(actor, 'wms.count.approve');
    requireStepUp(actor, 'inventory.adjust.approve', this.stepUpMinutes);
    return this.runner.command(actor, warehouseId, 'wms.count.approve', key, 'count.approve', { id }, async (ctx) => {
      await this.lockSession(ctx, id, ['SUBMITTED']);
      const counters = await rows<{ counted_by: string }>(
        ctx.tx,
        sql`SELECT DISTINCT counted_by FROM count_lines WHERE session_id = ${id}`,
      );
      if (counters.some((c) => c.counted_by === actor.userId)) {
        throw new Conflict('Quem contou não pode aprovar a mesma contagem', 'SEGREGATION_OF_DUTIES');
      }
      const stale = await this.markStale(ctx, id);
      if (stale > 0) throw new Conflict(`${stale} linha(s) alteradas desde a contagem: recontar`, 'STALE_COUNT_LINES');
      const lines = await rows<{
        id: string;
        position_id: string | null;
        sku_id: string;
        holder_node_id: string | null;
        holder_container_id: string | null;
        lot_code: string;
        qty_counted: string;
      }>(
        ctx.tx,
        sql`SELECT id, position_id, sku_id, holder_node_id, holder_container_id, lot_code, qty_counted::text
                     FROM count_lines WHERE session_id = ${id} ORDER BY position_id NULLS LAST, id`,
      );
      const txnId = await newTxn(ctx, 'COUNT_ADJUST', { referenceType: 'count', referenceId: id, idempotencyKey: key });
      let adjusted = 0;
      for (const l of lines) {
        const pos = l.position_id
          ? await lockPosition(ctx, l.position_id)
          : await ensurePosition(ctx, {
              skuId: l.sku_id,
              holder: { nodeId: l.holder_node_id ?? undefined, containerId: l.holder_container_id ?? undefined },
              status: 'AVAILABLE',
              lot: l.lot_code,
            });
        const delta = sub(l.qty_counted, pos.qty_on_hand);
        if (toMilli(delta) !== 0n) {
          if (cmp(l.qty_counted, pos.qty_reserved) < 0) {
            throw new Conflict('Ajuste afetaria stock reservado: liberte as reservas primeiro', 'ADJUST_BELOW_RESERVED');
          }
          await applyDelta(ctx, txnId, pos, delta);
          adjusted++;
        }
        await ctx.tx.execute(
          sql`UPDATE count_lines SET state = 'APPROVED', adjustment_txn_id = ${toMilli(delta) !== 0n ? txnId : null} WHERE id = ${l.id}`,
        );
      }
      await ctx.tx.execute(
        sql`UPDATE count_sessions SET status = 'APPROVED', approved_by = ${actor.userId}, approved_at = now() WHERE id = ${id}`,
      );
      await this.audit.recordInTx(ctx.tx, {
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'wms.count.approve',
        resourceType: 'count_session',
        resourceId: id,
        warehouseId,
        outcome: 'SUCCESS',
        requestId: actor.requestId,
        clientIp: actor.clientIp,
        details: { adjustedLines: adjusted, txnId },
      });
      await emitEvent(ctx, 'wms.count.approved', 'count', id, { adjustedLines: adjusted, txnId });
      return { id, status: 'APPROVED', adjustedLines: adjusted, txnId: adjusted ? txnId : null };
    });
  }

  /** Cancels an OPEN/SUBMITTED count (no stock effect). */
  async cancel(actor: Actor, warehouseId: string, id: string, key: string) {
    return this.runner.command(actor, warehouseId, 'wms.count', key, 'count.cancel', { id }, async (ctx) => {
      await this.lockSession(ctx, id, ['OPEN', 'SUBMITTED']);
      await ctx.tx.execute(sql`UPDATE count_sessions SET status = 'CANCELLED' WHERE id = ${id}`);
      return { id, status: 'CANCELLED' };
    });
  }

  private async lockSession(ctx: OpCtx, id: string, allowed: string[]) {
    const s = await row<{ status: string }>(
      ctx.tx,
      sql`SELECT status FROM count_sessions WHERE id = ${id} AND warehouse_id = ${ctx.warehouseId} FOR UPDATE`,
    );
    if (!s) throw new NotFound('Contagem');
    if (!allowed.includes(s.status)) throw new Conflict('Estado da contagem não permite esta operação', 'INVALID_STATE');
  }

  /** Marks lines whose position version moved since the snapshot; returns how many are stale. */
  private async markStale(ctx: OpCtx, id: string): Promise<number> {
    const r = await rows(
      ctx.tx,
      sql`UPDATE count_lines cl SET state = 'STALE' FROM stock_positions p
          WHERE cl.session_id = ${id} AND p.id = cl.position_id AND p.version <> cl.version_snapshot AND cl.state <> 'APPROVED'
          RETURNING cl.id`,
    );
    const already = await one<{ n: number }>(
      ctx.tx,
      sql`SELECT count(*)::int AS n FROM count_lines WHERE session_id = ${id} AND state = 'STALE'`,
    );
    return Math.max(r.length, already.n);
  }
}
