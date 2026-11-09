/**
 * @file Warehouse returns: receipt into INSPECTION, then disposition to saleable, quarantine,
 * damaged or scrap — without any CRM or accounting module.
 * @module wms
 *
 * State machine: INSPECTION --disposition (partial allowed)--> CLOSED when every received unit
 * has a disposition. Ledger: RETURN_RECEIPT (+qty INSPECTION), RETURN_DISPOSITION (moves or
 * scrap write-off).
 */
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { CreateReturnInput, ReturnDispositionInput } from '@autolemon/contracts';
import { Conflict, ValidationFailed } from '../common/errors.js';
import { one, rows } from '../db/database.js';
import type { Actor } from '../platform/authz/actor.js';
import {
  applyDelta,
  emitEvent,
  ensurePosition,
  lockPosition,
  newTxn,
  nextDocNumber,
  relocate,
  requireNodeKind,
  requireSku,
  resolveHolder,
  warehouseCode,
} from './inventory/engine.js';
import { cmp, neg, sub, sum } from './inventory/qty.js';
import type { WmsRunner } from './runner.js';

/** Returns use cases. */
export class ReturnsService {
  constructor(private readonly runner: WmsRunner) {}

  /** Lists returns. */
  async list(actor: Actor, warehouseId: string) {
    return this.runner.read(actor, warehouseId, 'wms.view', (ctx) =>
      rows(
        ctx.tx,
        sql`SELECT r.id, r.number, r.status, r.external_ref AS "externalRef", r.created_at AS "createdAt",
              coalesce(json_agg(json_build_object('lineId', l.id, 'skuCode', s.code, 'qtyReceived', l.qty_received::text,
                'qtySaleable', l.qty_saleable::text, 'qtyQuarantined', l.qty_quarantined::text, 'qtyDamaged', l.qty_damaged::text,
                'qtyScrapped', l.qty_scrapped::text) ORDER BY l.line_no), '[]') AS lines
            FROM returns r JOIN return_lines l ON l.return_id = r.id JOIN skus s ON s.id = l.sku_id
            WHERE r.warehouse_id = ${warehouseId} GROUP BY r.id ORDER BY r.created_at DESC LIMIT 200`,
      ),
    );
  }

  /** Receives returned units into an INSPECTION node. */
  async create(actor: Actor, warehouseId: string, key: string, input: z.infer<typeof CreateReturnInput>) {
    return this.runner.command(actor, warehouseId, 'wms.returns', key, 'return.create', input, async (ctx) => {
      const inspection = await requireNodeKind(ctx, input.inspectionNodeId, ['INSPECTION']);
      const number = await nextDocNumber(ctx, await warehouseCode(ctx), 'DEV');
      const r = await one<{ id: string }>(
        ctx.tx,
        sql`INSERT INTO returns (company_id, warehouse_id, number, status, external_ref, inspection_node_id, created_by)
            VALUES (${ctx.companyId}, ${warehouseId}, ${number}, 'INSPECTION', ${input.externalRef ?? null}, ${input.inspectionNodeId}, ${actor.userId})
            RETURNING id`,
      );
      const txnId = await newTxn(ctx, 'RETURN_RECEIPT', { referenceType: 'return', referenceId: r.id, idempotencyKey: key });
      let n = 1;
      for (const l of input.lines) {
        await requireSku(ctx, l.skuId);
        const pos = await ensurePosition(ctx, { skuId: l.skuId, holder: inspection, status: 'INSPECTION' });
        await applyDelta(ctx, txnId, pos, l.qty);
        await ctx.tx
          .execute(sql`INSERT INTO return_lines (company_id, warehouse_id, return_id, line_no, sku_id, inspection_position_id, qty_received)
            VALUES (${ctx.companyId}, ${warehouseId}, ${r.id}, ${n++}, ${l.skuId}, ${pos.id}, ${l.qty}::numeric)`);
      }
      await emitEvent(ctx, 'wms.return.received', 'return', r.id, { txnId });
      return { id: r.id, number, txnId };
    });
  }

  /**
   * Applies dispositions after inspection:
   *  SALEABLE → AVAILABLE at a SHELF/BIN/LOCATION holder; QUARANTINE → QUARANTINE node;
   *  DAMAGED → DAMAGED status at a QUARANTINE/INSPECTION node; SCRAP → written off the ledger.
   */
  async disposition(actor: Actor, warehouseId: string, id: string, key: string, input: z.infer<typeof ReturnDispositionInput>) {
    return this.runner.command(actor, warehouseId, 'wms.returns', key, 'return.disposition', { id, ...input }, async (ctx) => {
      const ret = await one<{ status: string }>(
        ctx.tx,
        sql`SELECT status FROM returns WHERE id = ${id} AND warehouse_id = ${warehouseId} FOR UPDATE`,
        'Devolução',
      );
      if (ret.status !== 'INSPECTION') throw new Conflict('Devolução já fechada', 'INVALID_STATE');
      const txnId = await newTxn(ctx, 'RETURN_DISPOSITION', { referenceType: 'return', referenceId: id, idempotencyKey: key });
      for (const d of input.lines) {
        const line = await one<{
          id: string;
          inspection_position_id: string;
          qty_received: string;
          qty_saleable: string;
          qty_quarantined: string;
          qty_damaged: string;
          qty_scrapped: string;
        }>(
          ctx.tx,
          sql`SELECT id, inspection_position_id, qty_received::text, qty_saleable::text, qty_quarantined::text, qty_damaged::text, qty_scrapped::text
              FROM return_lines WHERE id = ${d.lineId} AND return_id = ${id} FOR UPDATE`,
          'Linha',
        );
        const pending = sub(line.qty_received, sum([line.qty_saleable, line.qty_quarantined, line.qty_damaged, line.qty_scrapped]));
        if (cmp(d.qty, pending) > 0) throw new Conflict(`Só há ${pending} unidades por inspecionar`, 'QTY_EXCEEDS_PENDING');
        const src = await lockPosition(ctx, line.inspection_position_id);
        if (d.disposition === 'SCRAP') {
          await applyDelta(ctx, txnId, src, neg(d.qty));
          await ctx.tx.execute(sql`UPDATE return_lines SET qty_scrapped = qty_scrapped + ${d.qty}::numeric WHERE id = ${line.id}`);
          continue;
        }
        if (!d.to) throw new ValidationFailed([{ path: 'to', message: 'Destino obrigatório' }]);
        const spec = {
          SALEABLE: { status: 'AVAILABLE', kinds: ['SHELF', 'BIN', 'LOCATION'], col: 'qty_saleable' },
          QUARANTINE: { status: 'QUARANTINE', kinds: ['QUARANTINE'], col: 'qty_quarantined' },
          DAMAGED: { status: 'DAMAGED', kinds: ['QUARANTINE', 'INSPECTION'], col: 'qty_damaged' },
        } as const;
        const s = spec[d.disposition];
        const holder = await resolveHolder(ctx, d.to, { allowedKinds: s.kinds });
        await relocate(ctx, txnId, src, d.qty, { holder, status: s.status });
        // Column name comes from the constant map above (reviewed raw SQL identifier).
        await ctx.tx.execute(sql`UPDATE return_lines SET ${sql.raw(s.col)} = ${sql.raw(s.col)} + ${d.qty}::numeric WHERE id = ${line.id}`);
      }
      const open = await one<{ n: number }>(
        ctx.tx,
        sql`SELECT count(*)::int AS n FROM return_lines WHERE return_id = ${id}
            AND qty_saleable + qty_quarantined + qty_damaged + qty_scrapped < qty_received`,
      );
      if (open.n === 0) await ctx.tx.execute(sql`UPDATE returns SET status = 'CLOSED' WHERE id = ${id}`);
      await emitEvent(ctx, 'wms.return.disposed', 'return', id, { txnId });
      return { txnId, status: open.n === 0 ? 'CLOSED' : 'INSPECTION' };
    });
  }
}
