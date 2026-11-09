/**
 * @file Operational reports, searchable activity history and authorized CSV export.
 * @module wms
 *
 * Exports are high-risk reads: they require wms.export + a recent step-up MFA, are written to
 * the security audit log, never contain encrypted/PII fields and are encoded against CSV
 * formula injection.
 */
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { LedgerQuery } from '@autolemon/contracts';
import { toCsv } from '../common/csv.js';
import type { Database } from '../db/database.js';
import { rows } from '../db/database.js';
import { type Actor, companyScope, requirePermission, requireStepUp } from '../platform/authz/actor.js';
import type { AuditService } from '../platform/audit/audit.service.js';
import { stockSummary } from './stock.service.js';
import type { WmsRunner } from './runner.js';

/** Reporting use cases. */
export class ReportService {
  constructor(
    private readonly runner: WmsRunner,
    private readonly database: Database,
    private readonly audit: AuditService,
    private readonly stepUpMinutes: number,
  ) {}

  /** Activity history (ledger) with filters; bounded result size. */
  async ledger(actor: Actor, warehouseId: string, q: z.infer<typeof LedgerQuery>) {
    return this.runner.read(actor, warehouseId, 'wms.report', (ctx) =>
      rows(
        ctx.tx,
        sql`SELECT l.id::text, l.created_at AS "at", t.txn_type AS type, t.id AS "txnId", t.reference_type AS "refType",
              t.reference_id AS "refId", s.code AS "skuCode", coalesce(n.path, cn.path) AS "nodePath", c.code AS "containerCode",
              l.stock_status AS status, l.qty_delta::text AS delta, u.display_name AS actor, t.note, t.reversal_of AS "reversalOf"
            FROM inventory_ledger l JOIN inventory_transactions t ON t.id = l.txn_id JOIN skus s ON s.id = l.sku_id
            JOIN users u ON u.id = t.actor_user_id
            LEFT JOIN storage_nodes n ON n.id = l.holder_node_id
            LEFT JOIN containers c ON c.id = l.holder_container_id LEFT JOIN storage_nodes cn ON cn.id = c.current_node_id
            WHERE l.warehouse_id = ${warehouseId}
              AND (${q.skuId ?? null}::uuid IS NULL OR l.sku_id = ${q.skuId ?? null}::uuid)
              AND (${q.type ?? null}::text IS NULL OR t.txn_type = ${q.type ?? null}::text)
              AND (${q.from ?? null}::timestamptz IS NULL OR l.created_at >= ${q.from ?? null}::timestamptz)
              AND (${q.to ?? null}::timestamptz IS NULL OR l.created_at <= ${q.to ?? null}::timestamptz)
            ORDER BY l.id DESC LIMIT ${q.limit}`,
      ),
    );
  }

  /** Inbound shortages/excess/damage and approved count discrepancies. */
  async discrepancies(actor: Actor, warehouseId: string) {
    return this.runner.read(actor, warehouseId, 'wms.report', async (ctx) => ({
      inbound: await rows(
        ctx.tx,
        sql`SELECT o.number, s.code AS "skuCode", l.qty_expected::text AS expected, l.qty_received::text AS received,
              l.qty_short::text AS short, l.qty_excess::text AS excess, l.qty_damaged::text AS damaged
            FROM inbound_lines l JOIN inbound_orders o ON o.id = l.inbound_id JOIN skus s ON s.id = l.sku_id
            WHERE l.warehouse_id = ${warehouseId} AND (l.qty_short > 0 OR l.qty_excess > 0 OR l.qty_damaged > 0)
            ORDER BY o.created_at DESC LIMIT 200`,
      ),
      counts: await rows(
        ctx.tx,
        sql`SELECT cs.number, s.code AS "skuCode", cl.qty_snapshot::text AS expected, cl.qty_counted::text AS counted,
              (cl.qty_counted - cl.qty_snapshot)::text AS delta, cl.state
            FROM count_lines cl JOIN count_sessions cs ON cs.id = cl.session_id JOIN skus s ON s.id = cl.sku_id
            WHERE cl.warehouse_id = ${warehouseId} AND cl.qty_counted IS NOT NULL AND cl.qty_counted <> cl.qty_snapshot
            ORDER BY cs.created_at DESC LIMIT 200`,
      ),
    }));
  }

  /** Company-level in-transit quantities (staff: only transfers touching their warehouse). */
  async inTransit(actor: Actor) {
    requirePermission(actor, 'wms.report');
    return this.database.tenantTx(companyScope(actor), (tx) =>
      rows(
        tx,
        sql`SELECT t.number, sw.code AS source, dw.code AS dest, s.code AS "skuCode",
              (l.qty_shipped - l.qty_received - l.qty_lost)::text AS "qtyInTransit"
            FROM transfer_lines l JOIN transfers t ON t.id = l.transfer_id JOIN skus s ON s.id = l.sku_id
            JOIN warehouses sw ON sw.id = t.source_warehouse_id JOIN warehouses dw ON dw.id = t.dest_warehouse_id
            WHERE l.qty_shipped - l.qty_received - l.qty_lost > 0 ORDER BY t.number`,
      ),
    );
  }

  /** CSV export of stock positions (wms.export + step-up + security audit). */
  async exportStockCsv(actor: Actor, warehouseId: string): Promise<string> {
    requirePermission(actor, 'wms.export');
    requireStepUp(actor, 'report.export', this.stepUpMinutes);
    return this.runner.read(actor, warehouseId, 'wms.export', async (ctx) => {
      const data = await rows<Record<string, string | null>>(
        ctx.tx,
        sql`SELECT s.code, s.description, coalesce(n.path, cn.path) AS path, c.code AS container, p.stock_status AS status,
              p.lot_code AS lot, p.qty_on_hand::text AS on_hand, p.qty_reserved::text AS reserved
            FROM stock_positions p JOIN skus s ON s.id = p.sku_id
            LEFT JOIN storage_nodes n ON n.id = p.holder_node_id
            LEFT JOIN containers c ON c.id = p.holder_container_id LEFT JOIN storage_nodes cn ON cn.id = c.current_node_id
            WHERE p.warehouse_id = ${warehouseId} AND p.qty_on_hand > 0 ORDER BY s.code, 3 LIMIT 50000`,
      );
      await this.audit.recordInTx(ctx.tx, {
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'wms.export.stock_csv',
        resourceType: 'warehouse',
        resourceId: warehouseId,
        warehouseId,
        outcome: 'SUCCESS',
        requestId: actor.requestId,
        clientIp: actor.clientIp,
        details: { rows: data.length },
      });
      return toCsv([
        ['artigo', 'descricao', 'localizacao', 'caixa', 'estado', 'lote', 'existencia', 'reservado'],
        ...data.map((r) => [r.code, r.description, r.path, r.container, r.status, r.lot, r.on_hand, r.reserved]),
      ]);
    });
  }

  /** Stock summary report (same data as the stock overview). */
  async stock(actor: Actor, warehouseId: string) {
    return this.runner.read(actor, warehouseId, 'wms.report', (ctx) => stockSummary(ctx.tx, warehouseId));
  }
}
