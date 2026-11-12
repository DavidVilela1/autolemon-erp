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
import type { ExpiryReportQuery, LedgerExportQuery, LedgerQuery, SearchQuery } from '@autolemon/contracts';
import { toCsv } from '../common/csv.js';
import type { Database } from '../db/database.js';
import { rows } from '../db/database.js';
import { Conflict } from '../common/errors.js';
import { type Actor, companyScope, requirePermission, requireStepUp } from '../platform/authz/actor.js';
import type { AuditService } from '../platform/audit/audit.service.js';
import { stockSummary } from './stock.service.js';
import type { WmsRunner } from './runner.js';

/** Row cap for CSV exports (refused, never truncated, beyond it). */
export const EXPORT_MAX_ROWS = 100_000;

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

  /**
   * CSV export of the activity history (ledger) for a bounded period (wms.export + step-up +
   * security audit, CSV-injection safe). Refuses more than EXPORT_MAX_ROWS rows instead of
   * silently truncating, so an export is always complete for the period it names.
   */
  async exportLedgerCsv(actor: Actor, warehouseId: string, q: z.infer<typeof LedgerExportQuery>): Promise<string> {
    requirePermission(actor, 'wms.export');
    requireStepUp(actor, 'report.export', this.stepUpMinutes);
    return this.runner.read(actor, warehouseId, 'wms.export', async (ctx) => {
      const to = q.to ?? new Date().toISOString();
      const data = await rows<Record<string, string | null>>(
        ctx.tx,
        sql`SELECT to_char(l.created_at AT TIME ZONE 'Europe/Lisbon', 'YYYY-MM-DD HH24:MI:SS') AS at, t.txn_type AS type,
              t.id::text AS txn, coalesce(io.number, oo.number, tr.number, rt.number, cs.number) AS document,
              s.code AS sku, coalesce(n.path, cn.path) AS path, c.code AS container, l.stock_status AS status, l.lot_code AS lot,
              l.qty_delta::text AS delta, u.display_name AS actor, t.note
            FROM inventory_ledger l JOIN inventory_transactions t ON t.id = l.txn_id JOIN skus s ON s.id = l.sku_id
            JOIN users u ON u.id = t.actor_user_id
            LEFT JOIN storage_nodes n ON n.id = l.holder_node_id
            LEFT JOIN containers c ON c.id = l.holder_container_id LEFT JOIN storage_nodes cn ON cn.id = c.current_node_id
            LEFT JOIN inbound_orders io ON t.reference_type = 'inbound' AND io.id = t.reference_id
            LEFT JOIN outbound_orders oo ON t.reference_type = 'outbound' AND oo.id = t.reference_id
            LEFT JOIN transfers tr ON t.reference_type = 'transfer' AND tr.id = t.reference_id
            LEFT JOIN returns rt ON t.reference_type = 'return' AND rt.id = t.reference_id
            LEFT JOIN count_sessions cs ON t.reference_type = 'count' AND cs.id = t.reference_id
            WHERE l.warehouse_id = ${warehouseId}
              AND l.created_at >= ${q.from}::timestamptz AND l.created_at <= ${to}::timestamptz
              AND (${q.skuId ?? null}::uuid IS NULL OR l.sku_id = ${q.skuId ?? null}::uuid)
              AND (${q.type ?? null}::text IS NULL OR t.txn_type = ${q.type ?? null}::text)
            ORDER BY l.id LIMIT ${EXPORT_MAX_ROWS + 1}`,
      );
      if (data.length > EXPORT_MAX_ROWS) {
        throw new Conflict(`Mais de ${EXPORT_MAX_ROWS} movimentos no período; reduza o intervalo`, 'EXPORT_TOO_LARGE');
      }
      await this.audit.recordInTx(ctx.tx, {
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'wms.export.ledger_csv',
        resourceType: 'warehouse',
        resourceId: warehouseId,
        warehouseId,
        outcome: 'SUCCESS',
        requestId: actor.requestId,
        clientIp: actor.clientIp,
        details: { rows: data.length, from: q.from, to, type: q.type ?? null, skuId: q.skuId ?? null },
      });
      return toCsv([
        [
          'data_hora',
          'tipo',
          'transacao',
          'documento',
          'artigo',
          'localizacao',
          'caixa',
          'estado',
          'lote',
          'quantidade',
          'utilizador',
          'nota',
        ],
        ...data.map((r) => [r.at, r.type, r.txn, r.document, r.sku, r.path, r.container, r.status, r.lot, r.delta, r.actor, r.note]),
      ]);
    });
  }

  /**
   * Cross-document search inside one warehouse (wms.view). Matches document numbers and
   * external references, SKU code/description/barcode, location code/path and container code.
   * Transfers are found from either side. At most 10 hits per kind; never returns PII
   * (recipient contacts stay encrypted and are not searched).
   */
  async search(actor: Actor, warehouseId: string, q: z.infer<typeof SearchQuery>) {
    // Escape LIKE metacharacters so user text is matched literally (the value is still a bound parameter).
    const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    return this.runner.read(actor, warehouseId, 'wms.view', async (ctx) => {
      const hits = await rows<{ kind: string; id: string; label: string; detail: string | null; status: string | null }>(
        ctx.tx,
        sql`(SELECT 'inbound' AS kind, id::text, number AS label, external_ref AS detail, status FROM inbound_orders
              WHERE warehouse_id = ${warehouseId} AND (number ILIKE ${like} OR external_ref ILIKE ${like}) ORDER BY created_at DESC LIMIT 10)
            UNION ALL
            (SELECT 'outbound', id::text, number, external_ref, status FROM outbound_orders
              WHERE warehouse_id = ${warehouseId} AND (number ILIKE ${like} OR external_ref ILIKE ${like}) ORDER BY created_at DESC LIMIT 10)
            UNION ALL
            (SELECT 'transfer', id::text, number, NULL, status FROM transfers
              WHERE (source_warehouse_id = ${warehouseId} OR dest_warehouse_id = ${warehouseId}) AND number ILIKE ${like}
              ORDER BY created_at DESC LIMIT 10)
            UNION ALL
            (SELECT 'return', id::text, number, external_ref, status FROM returns
              WHERE warehouse_id = ${warehouseId} AND (number ILIKE ${like} OR external_ref ILIKE ${like}) ORDER BY created_at DESC LIMIT 10)
            UNION ALL
            (SELECT 'count', id::text, number, kind, status FROM count_sessions
              WHERE warehouse_id = ${warehouseId} AND number ILIKE ${like} ORDER BY created_at DESC LIMIT 10)
            UNION ALL
            (SELECT 'sku', s.id::text, s.code, s.description, NULL FROM skus s
              WHERE s.company_id = ${ctx.companyId} AND (s.code ILIKE ${like} OR s.description ILIKE ${like}
                OR EXISTS (SELECT 1 FROM sku_barcodes b WHERE b.sku_id = s.id AND b.barcode ILIKE ${like}))
              ORDER BY s.code LIMIT 10)
            UNION ALL
            (SELECT 'location', id::text, path, kind, CASE WHEN active THEN 'ACTIVE' ELSE 'INACTIVE' END FROM storage_nodes
              WHERE warehouse_id = ${warehouseId} AND (code ILIKE ${like} OR path ILIKE ${like} OR name ILIKE ${like}) ORDER BY path LIMIT 10)
            UNION ALL
            (SELECT 'container', id::text, code, kind, status FROM containers
              WHERE warehouse_id = ${warehouseId} AND code ILIKE ${like} ORDER BY code LIMIT 10)`,
      );
      return { q: q.q, hits };
    });
  }

  /**
   * Near-expiry report (wms.report): on-hand positions whose lot expires within `days` (expired
   * lots included, flagged), earliest first, with free and reserved quantities and status, so
   * supervisors can block, discount, return or dispose in time. Reads only this warehouse.
   */
  async expiry(actor: Actor, warehouseId: string, q: z.infer<typeof ExpiryReportQuery>) {
    return this.runner.read(actor, warehouseId, 'wms.report', (ctx) =>
      rows(
        ctx.tx,
        sql`SELECT p.id AS "positionId", s.code AS "skuCode", s.description, p.lot_code AS lot, sl.expires_on::text AS "expiresOn",
              (sl.expires_on - current_date) AS "daysLeft", (sl.expires_on < current_date) AS expired,
              p.stock_status AS status, p.qty_on_hand::text AS "onHand", p.qty_reserved::text AS reserved,
              coalesce(n.path, cn.path) AS "nodePath", c.code AS "containerCode"
            FROM stock_positions p
            JOIN sku_lots sl ON sl.company_id = p.company_id AND sl.sku_id = p.sku_id AND sl.lot_code = p.lot_code
            JOIN skus s ON s.id = p.sku_id
            LEFT JOIN storage_nodes n ON n.id = p.holder_node_id LEFT JOIN containers c ON c.id = p.holder_container_id
            LEFT JOIN storage_nodes cn ON cn.id = c.current_node_id
            WHERE p.warehouse_id = ${warehouseId} AND p.qty_on_hand > 0
              AND sl.expires_on <= current_date + ${q.days}::int
            ORDER BY sl.expires_on, s.code, p.lot_code LIMIT 2000`,
      ),
    );
  }

  /** Stock summary report (same data as the stock overview). */
  async stock(actor: Actor, warehouseId: string) {
    return this.runner.read(actor, warehouseId, 'wms.report', (ctx) => stockSummary(ctx.tx, warehouseId));
  }
}
