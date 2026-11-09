/**
 * @file Company-owned stock item (SKU) master, barcodes and validated CSV import.
 * @module wms
 *
 * The SKU master is company-level (shared by all warehouses of a tenant) and intentionally
 * independent of any automotive catalogue/fitment module. Optional simple attributes live in
 * validated JSONB; anything relational belongs in extension-owned tables.
 */
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { CreateSkuInput } from '@autolemon/contracts';
import { Conflict, ValidationFailed } from '../common/errors.js';
import { CsvError, isFormulaLike, parseCsv } from '../common/csv.js';
import type { Database, Tx } from '../db/database.js';
import { one, rows } from '../db/database.js';
import { type Actor, companyScope, requirePermission } from '../platform/authz/actor.js';
import type { AuditService } from '../platform/audit/audit.service.js';

/** Expected CSV header for SKU import (order-insensitive, case-insensitive). */
export const SKU_CSV_COLUMNS = ['code', 'description', 'base_uom', 'brand', 'manufacturer_ref', 'barcode'] as const;

/** SKU use cases. */
export class SkuService {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
  ) {}

  /** Lists SKUs (optionally filtered by code/description substring; bounded). */
  async list(actor: Actor, q: string | undefined, limit = 100) {
    requirePermission(actor, 'wms.view');
    const term = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    return this.database.tenantTx(companyScope(actor), (tx) =>
      rows(
        tx,
        sql`SELECT s.id, s.code, s.description, s.base_uom AS "baseUom", s.brand, s.manufacturer_ref AS "manufacturerRef",
              s.tracking, s.status, s.attributes,
              coalesce((SELECT json_agg(json_build_object('barcode', b.barcode, 'uom', b.uom, 'qtyPerUom', b.qty_per_uom) ORDER BY b.barcode)
                FROM sku_barcodes b WHERE b.sku_id = s.id), '[]') AS barcodes
            FROM skus s
            WHERE s.company_id = ${actor.companyId}
              AND (${term}::text IS NULL OR s.code ILIKE ${term} OR s.description ILIKE ${term})
            ORDER BY s.code LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
      ),
    );
  }

  /** Creates a SKU with optional barcodes. */
  async create(actor: Actor, input: z.infer<typeof CreateSkuInput>) {
    requirePermission(actor, 'wms.sku.manage');
    return this.database.tenantTx(companyScope(actor), (tx) => this.insert(tx, actor.companyId, input));
  }

  private async insert(tx: Tx, companyId: string, input: z.infer<typeof CreateSkuInput>) {
    const s = await one<{ id: string }>(
      tx,
      sql`INSERT INTO skus (company_id, code, description, base_uom, brand, manufacturer_ref, tracking, attributes)
          VALUES (${companyId}, ${input.code}, ${input.description}, ${input.baseUom}, ${input.brand ?? null},
            ${input.manufacturerRef ?? null}, ${input.tracking}, ${JSON.stringify(input.attributes ?? {})}::jsonb)
          RETURNING id`,
    );
    for (const b of input.barcodes) {
      await tx.execute(
        sql`INSERT INTO sku_barcodes (company_id, sku_id, barcode, uom, qty_per_uom)
            VALUES (${companyId}, ${s.id}, ${b.barcode}, ${b.uom}, ${b.qtyPerUom}::numeric)`,
      );
    }
    return { id: s.id };
  }

  /**
   * All-or-nothing CSV import of new SKUs. Every cell is validated with the same strict
   * schema as the API; formula-leading cells and malformed rows abort the import with a
   * per-row error list (no partial writes).
   */
  async importCsv(actor: Actor, csvText: string) {
    requirePermission(actor, 'wms.sku.manage');
    let table: string[][];
    try {
      table = parseCsv(csvText);
    } catch (e) {
      throw new ValidationFailed([{ row: 0, message: e instanceof CsvError ? e.message : 'CSV inválido' }], 'CSV inválido');
    }
    const header = (table.shift() ?? []).map((h) => h.trim().toLowerCase());
    const unknown = header.filter((h) => !(SKU_CSV_COLUMNS as readonly string[]).includes(h));
    if (!header.includes('code') || !header.includes('description') || unknown.length) {
      throw new ValidationFailed([{ row: 1, message: `Cabeçalho inválido. Colunas permitidas: ${SKU_CSV_COLUMNS.join(', ')}` }]);
    }
    const errors: Array<{ row: number; message: string }> = [];
    const parsed: Array<z.infer<typeof CreateSkuInput>> = [];
    table.forEach((cells, idx) => {
      const rowNo = idx + 2;
      if (cells.some(isFormulaLike)) {
        errors.push({ row: rowNo, message: 'Célula começa por carácter de fórmula (= + - @)' });
        return;
      }
      const rec: Record<string, string> = {};
      header.forEach((h, i) => (rec[h] = (cells[i] ?? '').trim()));
      const candidate = {
        code: rec.code,
        description: rec.description,
        ...(rec.base_uom ? { baseUom: rec.base_uom.toUpperCase() } : {}),
        ...(rec.brand ? { brand: rec.brand } : {}),
        ...(rec.manufacturer_ref ? { manufacturerRef: rec.manufacturer_ref } : {}),
        barcodes: rec.barcode ? [{ barcode: rec.barcode, uom: (rec.base_uom || 'UN').toUpperCase(), qtyPerUom: 1 }] : [],
      };
      const r = CreateSkuInput.safeParse(candidate);
      if (!r.success) errors.push({ row: rowNo, message: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      else parsed.push(r.data);
    });
    if (errors.length) throw new ValidationFailed(errors.slice(0, 100), `Importação rejeitada: ${errors.length} linha(s) inválida(s)`);
    const result = await this.database.tenantTx(companyScope(actor), async (tx) => {
      const ids: string[] = [];
      for (const p of parsed) {
        try {
          ids.push((await this.insert(tx, actor.companyId, p)).id);
        } catch (e) {
          if ((e as { cause?: { code?: string } }).cause?.code === '23505') {
            throw new Conflict(`Código ou código de barras duplicado: ${p.code}`, 'DUPLICATE');
          }
          throw e;
        }
      }
      await this.audit.recordInTx(tx, {
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'wms.sku.import',
        outcome: 'SUCCESS',
        requestId: actor.requestId,
        clientIp: actor.clientIp,
        details: { rows: ids.length },
      });
      return { imported: ids.length };
    });
    return result;
  }
}
