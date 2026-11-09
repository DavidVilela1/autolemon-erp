/**
 * @file Internal pick-location replenishment (min/target) and non-financial purchase suggestions.
 * @module wms
 *
 * A rule says: keep between min and target units of a SKU AVAILABLE at a pick node. When the
 * pick node falls below min, suggestions propose moving (target − current) from bulk positions
 * (other AVAILABLE positions of the same warehouse). If the whole warehouse cannot cover the
 * rules, a PURCHASE SUGGESTION is reported — informational only, never a purchase order
 * (Purchasing is out of scope in v0.5).
 */
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { ExecuteReplenishmentInput, ReplenishmentRuleInput } from '@autolemon/contracts';
import { Conflict } from '../common/errors.js';
import { one, rows } from '../db/database.js';
import type { Actor } from '../platform/authz/actor.js';
import { assertFree, lockPosition, newTxn, relocate, requireNodeKind, requireSku } from './inventory/engine.js';
import { cmp, fromMilli, sub, toMilli } from './inventory/qty.js';
import type { WmsRunner } from './runner.js';

/** Replenishment use cases. */
export class ReplenishmentService {
  constructor(private readonly runner: WmsRunner) {}

  /** Creates or updates a rule (unique per sku + pick node). */
  async upsertRule(actor: Actor, warehouseId: string, key: string, input: z.infer<typeof ReplenishmentRuleInput>) {
    return this.runner.command(actor, warehouseId, 'wms.replenish', key, 'replenish.rule', input, async (ctx) => {
      if (cmp(input.targetQty, input.minQty) < 0) throw new Conflict('Alvo deve ser ≥ mínimo', 'INVALID_RULE');
      await requireSku(ctx, input.skuId);
      await requireNodeKind(ctx, input.pickNodeId, ['SHELF', 'BIN', 'LOCATION']);
      const r = await one<{ id: string }>(
        ctx.tx,
        sql`INSERT INTO replenishment_rules (company_id, warehouse_id, sku_id, pick_node_id, min_qty, target_qty)
            VALUES (${ctx.companyId}, ${warehouseId}, ${input.skuId}, ${input.pickNodeId}, ${input.minQty}::numeric, ${input.targetQty}::numeric)
            ON CONFLICT (warehouse_id, sku_id, pick_node_id) DO UPDATE SET min_qty = EXCLUDED.min_qty, target_qty = EXCLUDED.target_qty, updated_at = now()
            RETURNING id`,
      );
      return { id: r.id };
    });
  }

  /** Computes internal replenishment moves and purchase suggestions. */
  async suggestions(actor: Actor, warehouseId: string) {
    return this.runner.read(actor, warehouseId, 'wms.replenish', async (ctx) => {
      const rules = await rows<{
        id: string;
        sku_id: string;
        sku_code: string;
        pick_node_id: string;
        pick_path: string;
        min_qty: string;
        target_qty: string;
        current: string;
      }>(
        ctx.tx,
        sql`SELECT r.id, r.sku_id, s.code AS sku_code, r.pick_node_id, n.path AS pick_path, r.min_qty::text, r.target_qty::text,
              coalesce((SELECT sum(p.qty_on_hand) FROM stock_positions p WHERE p.holder_node_id = r.pick_node_id
                AND p.sku_id = r.sku_id AND p.stock_status = 'AVAILABLE'), 0.000)::text AS current
            FROM replenishment_rules r JOIN skus s ON s.id = r.sku_id JOIN storage_nodes n ON n.id = r.pick_node_id
            WHERE r.warehouse_id = ${warehouseId} ORDER BY s.code`,
      );
      const moves: unknown[] = [];
      const purchase: unknown[] = [];
      for (const r of rules) {
        if (cmp(r.current, r.min_qty) >= 0) continue;
        let need = toMilli(r.target_qty) - toMilli(r.current);
        const sources = await rows<{ id: string; free: string; path: string; container: string | null }>(
          ctx.tx,
          sql`SELECT p.id, (p.qty_on_hand - p.qty_reserved)::text AS free, coalesce(n.path, cn.path) AS path, c.code AS container
              FROM stock_positions p LEFT JOIN storage_nodes n ON n.id = p.holder_node_id
              LEFT JOIN containers c ON c.id = p.holder_container_id LEFT JOIN storage_nodes cn ON cn.id = c.current_node_id
              WHERE p.warehouse_id = ${warehouseId} AND p.sku_id = ${r.sku_id} AND p.stock_status = 'AVAILABLE'
                AND p.qty_on_hand > p.qty_reserved AND (p.holder_node_id IS NULL OR p.holder_node_id <> ${r.pick_node_id})
                AND coalesce(n.kind, cn.kind) IN ('SHELF', 'BIN', 'LOCATION') AND (c.id IS NULL OR c.kind <> 'PACKAGE')
              ORDER BY (p.qty_on_hand - p.qty_reserved) DESC LIMIT 10`,
        );
        for (const s of sources) {
          if (need <= 0n) break;
          const take = toMilli(s.free) < need ? toMilli(s.free) : need;
          moves.push({
            ruleId: r.id,
            skuCode: r.sku_code,
            fromPositionId: s.id,
            fromPath: s.path,
            fromContainer: s.container,
            toPath: r.pick_path,
            qty: fromMilli(take),
          });
          need -= take;
        }
        if (need > 0n) {
          purchase.push({
            skuId: r.sku_id,
            skuCode: r.sku_code,
            suggestedQty: fromMilli(need),
            reason: 'Stock interno insuficiente para repor o mínimo',
          });
        }
      }
      return { moves, purchaseSuggestions: purchase, note: 'Sugestões de compra são informativas; não criam encomendas.' };
    });
  }

  /** Executes a replenishment move from a bulk position to the rule's pick node. */
  async execute(actor: Actor, warehouseId: string, key: string, input: z.infer<typeof ExecuteReplenishmentInput>) {
    return this.runner.command(actor, warehouseId, 'wms.replenish', key, 'replenish.execute', input, async (ctx) => {
      const rule = await one<{ sku_id: string; pick_node_id: string; target_qty: string }>(
        ctx.tx,
        sql`SELECT sku_id, pick_node_id, target_qty::text FROM replenishment_rules WHERE id = ${input.ruleId} AND warehouse_id = ${warehouseId}`,
        'Regra',
      );
      const src = await lockPosition(ctx, input.fromPositionId);
      if (src.sku_id !== rule.sku_id || src.stock_status !== 'AVAILABLE')
        throw new Conflict('Posição de origem inválida', 'POSITION_MISMATCH');
      if (src.holder_node_id === rule.pick_node_id) throw new Conflict('Origem já é a localização de picking', 'SAME_POSITION');
      assertFree(src, input.qty);
      const holder = await requireNodeKind(ctx, rule.pick_node_id, ['SHELF', 'BIN', 'LOCATION']);
      const txnId = await newTxn(ctx, 'REPLENISH', { referenceType: 'replenishment_rule', referenceId: input.ruleId, idempotencyKey: key });
      const r = await relocate(ctx, txnId, src, input.qty, { holder, status: 'AVAILABLE' });
      return {
        txnId,
        pickQty: r.target.qty_on_hand,
        belowTarget: cmp(r.target.qty_on_hand, rule.target_qty) < 0,
        overTargetBy: cmp(r.target.qty_on_hand, rule.target_qty) > 0 ? sub(r.target.qty_on_hand, rule.target_qty) : '0',
      };
    });
  }
}
