/**
 * @file Atomic inventory engine: positions, locking, ledger and holder validation.
 * @module wms/inventory
 *
 * EVERY change to physical stock goes through {@link applyDelta}, which in one statement
 * updates the position balance and appends a ledger row in the same transaction. Hence:
 *   INVARIANT L1: for every position, qty_on_hand = SUM(inventory_ledger.qty_delta).
 *   INVARIANT L2: 0 <= qty_reserved <= qty_on_hand (DB CHECK) and reserved only on AVAILABLE.
 *   INVARIANT L3: qty_reserved = SUM(open ACTIVE reservations) (maintained by outbound service).
 * Concurrency: positions are locked with SELECT ... FOR UPDATE (or INSERT ... ON CONFLICT DO
 * UPDATE, which also locks) before any read-modify-write. When several positions are locked
 * in one command they are locked in ascending id order to avoid deadlocks; remaining
 * deadlocks are retried by Database.tenantTx.
 * Future modules MUST NOT write stock tables directly (see EXTENDING_AUTOLEMON.md).
 */
import { sql } from 'drizzle-orm';
import type { NodeKind, StockStatus } from '@autolemon/contracts';
import type { Tx } from '../../db/database.js';
import { one, row, rows } from '../../db/database.js';
import { Conflict, InsufficientStock, NotFound } from '../../common/errors.js';
import type { Actor } from '../../platform/authz/actor.js';
import { cmp, isPositive, neg, sub, toMilli } from './qty.js';

/** Operation context: transaction already scoped (RLS) to one company + warehouse. */
export interface OpCtx {
  tx: Tx;
  actor: Actor;
  companyId: string;
  warehouseId: string;
}

/** A stock position row. Quantities are decimal strings. */
export interface PositionRow {
  id: string;
  company_id: string;
  warehouse_id: string;
  sku_id: string;
  holder_node_id: string | null;
  holder_container_id: string | null;
  stock_status: StockStatus;
  lot_code: string;
  qty_on_hand: string;
  qty_reserved: string;
  version: string;
}

/** Validated holder (exactly one of node/container) plus the physical node kind. */
export interface Holder {
  nodeId?: string;
  containerId?: string;
  /** Kind of the fixed node where the stock physically is (container's current node). */
  nodeKind: NodeKind;
}

/** Inventory transaction types (mirrors the CHECK constraint). */
export type TxnType =
  | 'OPENING'
  | 'RECEIPT'
  | 'PUTAWAY'
  | 'MOVE'
  | 'CONTAINER_MOVE'
  | 'PICK'
  | 'PACK'
  | 'DISPATCH'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'RETURN_RECEIPT'
  | 'RETURN_DISPOSITION'
  | 'COUNT_ADJUST'
  | 'ADJUST'
  | 'REPLENISH'
  | 'REVERSAL';

/** Node kinds whose AVAILABLE stock may be allocated to outbound orders. */
export const ALLOCATABLE_NODE_KINDS: readonly NodeKind[] = ['SHELF', 'BIN', 'LOCATION'];

/** Creates the transaction header for a posted inventory change. */
export async function newTxn(
  ctx: OpCtx,
  type: TxnType,
  opts: { referenceType?: string; referenceId?: string; note?: string; reversalOf?: string; idempotencyKey?: string } = {},
): Promise<string> {
  const r = await one<{ id: string }>(
    ctx.tx,
    sql`INSERT INTO inventory_transactions (company_id, warehouse_id, txn_type, actor_user_id, reference_type,
          reference_id, reversal_of, note, idempotency_key)
        VALUES (${ctx.companyId}, ${ctx.warehouseId}, ${type}, ${ctx.actor.userId}, ${opts.referenceType ?? null},
          ${opts.referenceId ?? null}, ${opts.reversalOf ?? null}, ${opts.note ?? null}, ${opts.idempotencyKey ?? null})
        RETURNING id`,
  );
  return r.id;
}

/** Locks and returns a position of the scoped warehouse; NotFound if outside scope. */
export async function lockPosition(ctx: OpCtx, positionId: string): Promise<PositionRow> {
  return one<PositionRow>(
    ctx.tx,
    sql`SELECT * FROM stock_positions WHERE id = ${positionId} AND warehouse_id = ${ctx.warehouseId} FOR UPDATE`,
    'Posição de stock',
  );
}

/** Locks several positions in ascending id order (deadlock avoidance). */
export async function lockPositions(ctx: OpCtx, ids: string[]): Promise<Map<string, PositionRow>> {
  const unique = [...new Set(ids)].sort();
  const out = new Map<string, PositionRow>();
  for (const id of unique) out.set(id, await lockPosition(ctx, id));
  return out;
}

/**
 * Finds or creates the position identified by (sku, holder, status, lot) and returns it
 * LOCKED. The upsert's DO UPDATE takes the row lock even when the row already existed.
 */
export async function ensurePosition(
  ctx: OpCtx,
  id: { skuId: string; holder: Pick<Holder, 'nodeId' | 'containerId'>; status: StockStatus; lot?: string },
): Promise<PositionRow> {
  return one<PositionRow>(
    ctx.tx,
    sql`INSERT INTO stock_positions (company_id, warehouse_id, sku_id, holder_node_id, holder_container_id, stock_status, lot_code)
        VALUES (${ctx.companyId}, ${ctx.warehouseId}, ${id.skuId}, ${id.holder.nodeId ?? null},
          ${id.holder.containerId ?? null}, ${id.status}, ${id.lot ?? ''})
        ON CONFLICT (warehouse_id, sku_id, holder_id, stock_status, lot_code)
        DO UPDATE SET updated_at = now()
        RETURNING *`,
  );
}

/**
 * Applies a signed quantity delta to a LOCKED position and appends the ledger row.
 * @param opts.consumeReserved amount of the position's reservation consumed by this
 *   decrement (picking); otherwise decrements may only use unreserved quantity.
 * @throws InsufficientStock when the result would be negative or eat into reservations.
 */
export async function applyDelta(
  ctx: OpCtx,
  txnId: string,
  pos: PositionRow,
  delta: string,
  opts: { consumeReserved?: string } = {},
): Promise<PositionRow> {
  if (toMilli(delta) === 0n) throw new Conflict('Quantidade nula', 'ZERO_QTY');
  const consume = opts.consumeReserved ?? '0';
  if (toMilli(delta) < 0n) {
    // Free = on_hand - reserved (+ the part of the reservation this command consumes).
    const free = toMilli(pos.qty_on_hand) - toMilli(pos.qty_reserved) + toMilli(consume);
    if (-toMilli(delta) > free) throw new InsufficientStock();
  }
  const updated = await one<PositionRow>(
    ctx.tx,
    sql`UPDATE stock_positions
        SET qty_on_hand = qty_on_hand + ${delta}::numeric,
            qty_reserved = qty_reserved - ${consume}::numeric,
            version = version + 1, updated_at = now()
        WHERE id = ${pos.id} AND warehouse_id = ${ctx.warehouseId}
        RETURNING *`,
  );
  await ctx.tx.execute(
    sql`INSERT INTO inventory_ledger (company_id, warehouse_id, txn_id, position_id, sku_id, holder_node_id,
          holder_container_id, stock_status, lot_code, qty_delta)
        VALUES (${ctx.companyId}, ${ctx.warehouseId}, ${txnId}, ${pos.id}, ${pos.sku_id}, ${pos.holder_node_id},
          ${pos.holder_container_id}, ${pos.stock_status}, ${pos.lot_code}, ${delta}::numeric)`,
  );
  return updated;
}

/**
 * Moves `qty` from a locked source position to a target identity (same SKU and lot), possibly
 * changing status (e.g. RECEIVED → AVAILABLE on putaway). Returns the target position.
 */
export async function relocate(
  ctx: OpCtx,
  txnId: string,
  src: PositionRow,
  qty: string,
  target: { holder: Holder; status: StockStatus },
  opts: { consumeReserved?: string } = {},
): Promise<{ source: PositionRow; target: PositionRow }> {
  if (!isPositive(qty)) throw new Conflict('Quantidade inválida', 'INVALID_QTY');
  const sameHolder =
    (target.holder.nodeId ?? null) === src.holder_node_id && (target.holder.containerId ?? null) === src.holder_container_id;
  if (sameHolder && target.status === src.stock_status) {
    throw new Conflict('Origem e destino são iguais', 'SAME_POSITION');
  }
  const source = await applyDelta(ctx, txnId, src, neg(qty), opts);
  const tgt = await ensurePosition(ctx, { skuId: src.sku_id, holder: target.holder, status: target.status, lot: src.lot_code });
  const after = await applyDelta(ctx, txnId, tgt, qty);
  return { source, target: after };
}

/**
 * Validates a holder reference inside the scoped warehouse.
 * - Fixed node: must exist (RLS + warehouse filter), be active and hold stock.
 * - Container: must be ACTIVE; PACKAGE containers only when `allowPackage`.
 * @param allowedKinds restricts the PHYSICAL node kind (e.g. putaway cannot target DISPATCH).
 */
export async function resolveHolder(
  ctx: OpCtx,
  ref: { nodeId?: string; containerId?: string },
  opts: { allowPackage?: boolean; allowedKinds?: readonly NodeKind[] } = {},
): Promise<Holder> {
  let holder: Holder;
  if (ref.nodeId) {
    const n = await row<{ id: string; kind: NodeKind; holds_stock: boolean; active: boolean }>(
      ctx.tx,
      sql`SELECT id, kind, holds_stock, active FROM storage_nodes WHERE id = ${ref.nodeId} AND warehouse_id = ${ctx.warehouseId}`,
    );
    if (!n || !n.active) throw new NotFound('Localização');
    if (!n.holds_stock) throw new Conflict('Esta localização não armazena stock', 'NODE_NOT_STOCK_HOLDING');
    holder = { nodeId: n.id, nodeKind: n.kind };
  } else if (ref.containerId) {
    const c = await row<{ id: string; kind: string; status: string; node_kind: NodeKind }>(
      ctx.tx,
      sql`SELECT c.id, c.kind, c.status, n.kind AS node_kind FROM containers c
          JOIN storage_nodes n ON n.id = c.current_node_id
          WHERE c.id = ${ref.containerId} AND c.warehouse_id = ${ctx.warehouseId}`,
    );
    if (!c) throw new NotFound('Caixa');
    if (c.status !== 'ACTIVE') throw new Conflict('A caixa não está ativa', 'CONTAINER_NOT_ACTIVE');
    if (c.kind === 'PACKAGE' && !opts.allowPackage)
      throw new Conflict('Volumes de expedição não aceitam esta operação', 'PACKAGE_NOT_ALLOWED');
    holder = { containerId: c.id, nodeKind: c.node_kind };
  } else {
    throw new NotFound('Localização');
  }
  if (opts.allowedKinds && !opts.allowedKinds.includes(holder.nodeKind)) {
    throw new Conflict(`Destino inválido para esta operação (${holder.nodeKind})`, 'HOLDER_KIND_NOT_ALLOWED');
  }
  return holder;
}

/** Loads a fixed node of the scoped warehouse requiring one of `kinds`. */
export async function requireNodeKind(ctx: OpCtx, nodeId: string, kinds: readonly NodeKind[]): Promise<Holder> {
  return resolveHolder(ctx, { nodeId }, { allowedKinds: kinds });
}

/** Loads an ACTIVE SKU of the company. */
export async function requireSku(
  ctx: Pick<OpCtx, 'tx' | 'companyId'>,
  skuId: string,
): Promise<{ id: string; code: string; tracking: string }> {
  const s = await row<{ id: string; code: string; tracking: string; status: string }>(
    ctx.tx,
    sql`SELECT id, code, tracking, status FROM skus WHERE id = ${skuId} AND company_id = ${ctx.companyId}`,
  );
  if (!s) throw new NotFound('Artigo');
  if (s.status !== 'ACTIVE') throw new Conflict('Artigo bloqueado ou descontinuado', 'SKU_INACTIVE');
  return s;
}

/**
 * Barcode verification: true when the scanned value is the SKU code or one of its barcodes.
 * Used by picking/packing to stop wrong-item errors.
 */
export async function barcodeMatchesSku(ctx: Pick<OpCtx, 'tx' | 'companyId'>, skuId: string, scanned: string): Promise<boolean> {
  const r = await row<{ ok: boolean }>(
    ctx.tx,
    sql`SELECT EXISTS (
          SELECT 1 FROM skus WHERE id = ${skuId} AND company_id = ${ctx.companyId} AND code = ${scanned.toUpperCase()}
          UNION ALL
          SELECT 1 FROM sku_barcodes WHERE sku_id = ${skuId} AND company_id = ${ctx.companyId} AND barcode = ${scanned}
        ) AS ok`,
  );
  return !!r?.ok;
}

/** Resolves a barcode/SKU code to a SKU id, or undefined. */
export async function skuIdForBarcode(ctx: Pick<OpCtx, 'tx' | 'companyId'>, scanned: string): Promise<string | undefined> {
  const r = await row<{ id: string }>(
    ctx.tx,
    sql`SELECT sku_id AS id FROM sku_barcodes WHERE company_id = ${ctx.companyId} AND barcode = ${scanned}
        UNION ALL SELECT id FROM skus WHERE company_id = ${ctx.companyId} AND code = ${scanned.toUpperCase()} LIMIT 1`,
  );
  return r?.id;
}

/** Appends a versioned domain event to the transactional outbox. */
export async function emitEvent(
  ctx: Pick<OpCtx, 'tx' | 'companyId'> & { warehouseId?: string | null },
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await ctx.tx.execute(
    sql`INSERT INTO domain_outbox (company_id, warehouse_id, event_type, event_version, aggregate_type, aggregate_id, payload)
        VALUES (${ctx.companyId}, ${ctx.warehouseId ?? null}, ${eventType}, 1, ${aggregateType}, ${aggregateId}, ${JSON.stringify(payload)}::jsonb)`,
  );
}

/** Next human-readable document number, e.g. ENT-PORTO-000001. */
export async function nextDocNumber(ctx: Pick<OpCtx, 'tx' | 'companyId'>, scope: string, docType: string): Promise<string> {
  const r = await one<{ v: string }>(
    ctx.tx,
    sql`INSERT INTO doc_sequences (company_id, scope, doc_type, next_value) VALUES (${ctx.companyId}, ${scope}, ${docType}, 2)
        ON CONFLICT (company_id, scope, doc_type) DO UPDATE SET next_value = doc_sequences.next_value + 1
        RETURNING (next_value - 1)::text AS v`,
  );
  return `${docType}-${scope}-${r.v.padStart(6, '0')}`;
}

/** Warehouse code used in document numbers. */
export async function warehouseCode(ctx: Pick<OpCtx, 'tx' | 'companyId' | 'warehouseId'>): Promise<string> {
  const r = await one<{ code: string }>(
    ctx.tx,
    sql`SELECT code FROM warehouses WHERE id = ${ctx.warehouseId} AND company_id = ${ctx.companyId}`,
  );
  return r.code;
}

/**
 * Ledger reconciliation (INVARIANT L1): positions whose balance differs from the ledger sum.
 * Must always return an empty list; exposed through reports and asserted by tests.
 */
export async function reconcile(
  ctx: Pick<OpCtx, 'tx'> & { warehouseId: string },
): Promise<Array<{ position_id: string; on_hand: string; ledger: string }>> {
  return rows(
    ctx.tx,
    sql`SELECT p.id AS position_id, p.qty_on_hand::text AS on_hand, coalesce(sum(l.qty_delta), 0.000)::text AS ledger
        FROM stock_positions p LEFT JOIN inventory_ledger l ON l.position_id = p.id
        WHERE p.warehouse_id = ${ctx.warehouseId}
        GROUP BY p.id HAVING p.qty_on_hand <> coalesce(sum(l.qty_delta), 0)`,
  );
}

/** Reservation reconciliation (INVARIANT L3). Must always be empty. */
export async function reconcileReservations(ctx: Pick<OpCtx, 'tx'> & { warehouseId: string }): Promise<Array<{ position_id: string }>> {
  return rows(
    ctx.tx,
    sql`SELECT p.id AS position_id FROM stock_positions p
        LEFT JOIN reservations r ON r.position_id = p.id AND r.status = 'ACTIVE'
        WHERE p.warehouse_id = ${ctx.warehouseId}
        GROUP BY p.id HAVING p.qty_reserved <> coalesce(sum(r.qty_open), 0)`,
  );
}

/** Free (unreserved) quantity of a position. */
export function freeQty(p: PositionRow): string {
  return sub(p.qty_on_hand, p.qty_reserved);
}

/** Throws InsufficientStock when `qty` exceeds the free quantity of `p`. */
export function assertFree(p: PositionRow, qty: string): void {
  if (cmp(qty, freeQty(p)) > 0) throw new InsufficientStock();
}
