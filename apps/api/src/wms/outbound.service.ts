/**
 * @file WMS-native outbound: allocation (reservations), multi-position picking with barcode
 * verification, short picks, packing into traceable packages, partial dispatch, backorders.
 * @module wms
 *
 * State machine (docs/WMS_STATE_MACHINES.md §Outbound):
 *   DRAFT --allocate--> ALLOCATED --pick--> IN_PROGRESS --dispatch(all)--> CLOSED
 *   ALLOCATED/IN_PROGRESS --close[backorder]--> CLOSED (+ new DRAFT backorder)
 *   DRAFT/ALLOCATED (nothing picked) --cancel--> CANCELLED
 * Line counters: requested >= allocated(open reservations) + picked + short;
 *   picked >= packed >= dispatched. Stock statuses: AVAILABLE(reserved) → PICKED (packing node)
 *   → PICKED (inside PACKAGE container) → removed from stock on dispatch.
 * The recipient contact may contain personal data: it is AES-256-GCM encrypted and only
 * decrypted for users with wms.dispatch (masked otherwise).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  CloseOutboundInput,
  CreateOutboundInput,
  CreatePackageInput,
  DispatchInput,
  PackInput,
  PickInput,
  ReplaceOutboundLinesInput,
  UnpackInput,
  UnpickInput,
} from '@autolemon/contracts';
import { Conflict, InsufficientStock, NotFound } from '../common/errors.js';
import { one, row, rows } from '../db/database.js';
import { type Actor, hasPermission } from '../platform/authz/actor.js';
import type { FieldCrypto } from '../platform/crypto/field-crypto.js';
import {
  ALLOCATABLE_NODE_KINDS,
  applyDelta,
  emitEvent,
  lockPosition,
  newTxn,
  nextDocNumber,
  type PositionRow,
  relocate,
  requireNodeKind,
  requireSku,
  resolveHolder,
  scannedBaseQty,
  warehouseCode,
  type OpCtx,
} from './inventory/engine.js';
import { cmp, fromMilli, isPositive, min, sub, toMilli } from './inventory/qty.js';
import type { WmsRunner } from './runner.js';

interface LineRow {
  id: string;
  outbound_id: string;
  sku_id: string;
  qty_requested: string;
  qty_allocated: string;
  qty_picked: string;
  qty_packed: string;
  qty_dispatched: string;
  qty_short: string;
}

/** Outbound use cases. */
export class OutboundService {
  constructor(
    private readonly runner: WmsRunner,
    private readonly crypto: FieldCrypto,
  ) {}

  /** Lists outbound requests of a warehouse. */
  async list(actor: Actor, warehouseId: string) {
    return this.runner.read(actor, warehouseId, 'wms.view', (ctx) =>
      rows(
        ctx.tx,
        sql`SELECT o.id, o.number, o.status, o.external_ref AS "externalRef", o.backorder_of AS "backorderOf", o.created_at AS "createdAt",
              sum(l.qty_requested)::text AS "qtyRequested", sum(l.qty_dispatched)::text AS "qtyDispatched"
            FROM outbound_orders o JOIN outbound_lines l ON l.outbound_id = o.id
            WHERE o.warehouse_id = ${warehouseId} GROUP BY o.id ORDER BY o.created_at DESC LIMIT 200`,
      ),
    );
  }

  /**
   * Full outbound view: header (recipient decrypted only with wms.dispatch), lines, the pick
   * list (active reservations with holder paths) and packages with contents.
   */
  async get(actor: Actor, warehouseId: string, id: string) {
    return this.runner.read(actor, warehouseId, 'wms.view', async (ctx) => {
      const h = await one<{
        id: string;
        number: string;
        status: string;
        externalRef: string | null;
        recipient_contact_enc: string | null;
        backorderOf: string | null;
      }>(
        ctx.tx,
        sql`SELECT id, number, status, external_ref AS "externalRef", recipient_contact_enc, backorder_of AS "backorderOf"
            FROM outbound_orders WHERE id = ${id} AND warehouse_id = ${warehouseId}`,
        'Pedido de saída',
      );
      let recipientContact: string | null = null;
      if (h.recipient_contact_enc) {
        recipientContact = hasPermission(actor, 'wms.dispatch')
          ? await this.crypto.decrypt(
              { companyId: actor.companyId, table: 'outbound_orders', recordId: id, field: 'recipient_contact' },
              h.recipient_contact_enc,
            )
          : '•••••• (sem permissão)';
      }
      const lines = await rows(
        ctx.tx,
        sql`SELECT l.id, l.line_no AS "lineNo", l.sku_id AS "skuId", s.code AS "skuCode", s.description,
              l.qty_requested::text AS "qtyRequested", l.qty_allocated::text AS "qtyAllocated", l.qty_picked::text AS "qtyPicked",
              l.qty_packed::text AS "qtyPacked", l.qty_dispatched::text AS "qtyDispatched", l.qty_short::text AS "qtyShort"
            FROM outbound_lines l JOIN skus s ON s.id = l.sku_id WHERE l.outbound_id = ${id} ORDER BY l.line_no`,
      );
      const pickList = await rows(
        ctx.tx,
        sql`SELECT r.id AS "reservationId", r.outbound_line_id AS "lineId", r.position_id AS "positionId", s.code AS "skuCode",
              r.qty_open::text AS "qtyOpen", coalesce(n.path, cn.path) AS "nodePath", c.code AS "containerCode"
            FROM reservations r JOIN stock_positions p ON p.id = r.position_id JOIN skus s ON s.id = p.sku_id
            LEFT JOIN storage_nodes n ON n.id = p.holder_node_id
            LEFT JOIN containers c ON c.id = p.holder_container_id LEFT JOIN storage_nodes cn ON cn.id = c.current_node_id
            JOIN outbound_lines l ON l.id = r.outbound_line_id
            WHERE l.outbound_id = ${id} AND r.status = 'ACTIVE' ORDER BY coalesce(n.path, cn.path), c.code NULLS FIRST`,
      );
      const packages = await rows(
        ctx.tx,
        sql`SELECT c.id, c.code, c.status, n.path AS "nodePath",
              coalesce((SELECT json_agg(json_build_object('lineId', pl.outbound_line_id, 'qty', (pl.qty - pl.qty_unpacked)::text))
                FROM outbound_package_lines pl WHERE pl.package_id = c.id AND pl.qty > pl.qty_unpacked), '[]') AS contents
            FROM containers c JOIN storage_nodes n ON n.id = c.current_node_id
            WHERE c.outbound_id = ${id} ORDER BY c.code`,
      );
      const { recipient_contact_enc: _omit, ...header } = h;
      return { ...header, recipientContact, lines, pickList, packages };
    });
  }

  /** Creates a DRAFT outbound request; recipient contact is encrypted before storage. */
  async create(actor: Actor, warehouseId: string, key: string, input: z.infer<typeof CreateOutboundInput>) {
    return this.runner.command(actor, warehouseId, 'wms.outbound.manage', key, 'outbound.create', input, async (ctx) => {
      const id = randomUUID();
      const enc = input.recipientContact
        ? await this.crypto.encrypt(
            { companyId: actor.companyId, table: 'outbound_orders', recordId: id, field: 'recipient_contact' },
            input.recipientContact,
          )
        : null;
      const number = await nextDocNumber(ctx, await warehouseCode(ctx), 'SAI');
      await ctx.tx.execute(
        sql`INSERT INTO outbound_orders (id, company_id, warehouse_id, number, status, external_ref, recipient_contact_enc, created_by)
            VALUES (${id}, ${ctx.companyId}, ${warehouseId}, ${number}, 'DRAFT', ${input.externalRef ?? null}, ${enc}, ${actor.userId})`,
      );
      await this.writeLines(ctx, id, input.lines);
      return { id, number };
    });
  }

  /** Replaces the lines of a DRAFT request. */
  async replaceLines(actor: Actor, warehouseId: string, id: string, key: string, input: z.infer<typeof ReplaceOutboundLinesInput>) {
    return this.runner.command(actor, warehouseId, 'wms.outbound.manage', key, 'outbound.replace_lines', { id, ...input }, async (ctx) => {
      const o = await this.lockOrder(ctx, id);
      if (o.status !== 'DRAFT') throw new Conflict('Só rascunhos podem ser editados', 'INVALID_STATE');
      // Draft lines are not referenced by reservations or stock; safe to rebuild.
      const old = await rows<{ id: string; sku_id: string }>(ctx.tx, sql`SELECT id, sku_id FROM outbound_lines WHERE outbound_id = ${id}`);
      // qty_requested must stay > 0 (CHECK), so dropping an article from a draft is not
      // supported in v0.5: cancel the draft and create a new one instead.
      if (old.some((x) => !input.lines.some((l) => l.skuId === x.sku_id))) {
        throw new Conflict('Para remover artigos, cancele o rascunho e crie outro', 'LINE_REMOVAL_UNSUPPORTED');
      }
      for (const l of input.lines) {
        const match = old.find((x) => x.sku_id === l.skuId);
        if (match) await ctx.tx.execute(sql`UPDATE outbound_lines SET qty_requested = ${l.qty}::numeric WHERE id = ${match.id}`);
        else await this.writeLines(ctx, id, [l]);
      }
      return { id };
    });
  }

  /**
   * Allocates (reserves) free AVAILABLE stock in SHELF/BIN/LOCATION holders for every open
   * line quantity. Candidate positions are locked FOR UPDATE in id order, so concurrent
   * allocations serialise and can never over-reserve. Partial allocation is allowed.
   */
  async allocate(actor: Actor, warehouseId: string, id: string, key: string) {
    return this.runner.command(actor, warehouseId, 'wms.outbound.manage', key, 'outbound.allocate', { id }, async (ctx) => {
      const o = await this.lockOrder(ctx, id);
      if (!['DRAFT', 'ALLOCATED', 'IN_PROGRESS'].includes(o.status)) throw new Conflict('Pedido não pode ser alocado', 'INVALID_STATE');
      const lines = await rows<LineRow>(ctx.tx, sql`SELECT * FROM outbound_lines WHERE outbound_id = ${id} ORDER BY line_no FOR UPDATE`);
      let allocatedTotal = 0n;
      const result: Array<{ lineId: string; allocated: string; missing: string }> = [];
      for (const line of lines) {
        let need = toMilli(line.qty_requested) - toMilli(line.qty_allocated) - toMilli(line.qty_picked) - toMilli(line.qty_short);
        const candidates = await rows<PositionRow>(
          ctx.tx,
          sql`SELECT p.* FROM stock_positions p
              LEFT JOIN storage_nodes n ON n.id = p.holder_node_id
              LEFT JOIN containers c ON c.id = p.holder_container_id
              LEFT JOIN storage_nodes cn ON cn.id = c.current_node_id
              WHERE p.warehouse_id = ${warehouseId} AND p.sku_id = ${line.sku_id} AND p.stock_status = 'AVAILABLE'
                AND p.qty_on_hand > p.qty_reserved AND (c.id IS NULL OR c.status = 'ACTIVE')
                AND coalesce(n.kind, cn.kind) IN (${sql.join(
                  ALLOCATABLE_NODE_KINDS.map((k) => sql`${k}`),
                  sql`, `,
                )})
              ORDER BY p.id FOR UPDATE OF p`,
        );
        // Prefer the fullest positions to minimise pick stops.
        candidates.sort((a, b) => cmp(sub(b.qty_on_hand, b.qty_reserved), sub(a.qty_on_hand, a.qty_reserved)));
        let got = 0n;
        for (const p of candidates) {
          if (need <= 0n) break;
          const free = toMilli(p.qty_on_hand) - toMilli(p.qty_reserved);
          const take = free < need ? free : need;
          if (take <= 0n) continue;
          const q = fromMilli(take);
          await ctx.tx.execute(
            sql`UPDATE stock_positions SET qty_reserved = qty_reserved + ${q}::numeric, updated_at = now() WHERE id = ${p.id}`,
          );
          await ctx.tx.execute(
            sql`INSERT INTO reservations (company_id, warehouse_id, position_id, outbound_line_id, qty_initial, qty_open)
                VALUES (${ctx.companyId}, ${warehouseId}, ${p.id}, ${line.id}, ${q}::numeric, ${q}::numeric)`,
          );
          need -= take;
          got += take;
        }
        if (got > 0n)
          await ctx.tx.execute(
            sql`UPDATE outbound_lines SET qty_allocated = qty_allocated + ${fromMilli(got)}::numeric WHERE id = ${line.id}`,
          );
        allocatedTotal += got;
        result.push({ lineId: line.id, allocated: fromMilli(got), missing: fromMilli(need > 0n ? need : 0n) });
      }
      if (o.status === 'DRAFT') await ctx.tx.execute(sql`UPDATE outbound_orders SET status = 'ALLOCATED' WHERE id = ${id}`);
      await emitEvent(ctx, 'wms.outbound.allocated', 'outbound', id, { allocated: fromMilli(allocatedTotal) });
      return { id, lines: result };
    });
  }

  /**
   * Picks against a reservation: scanned barcode must match the SKU; stock moves to the
   * packing (DISPATCH) node as PICKED, consuming the reservation. `closeShort` releases the
   * remaining reservation and records it as short (later backorder).
   */
  async pick(actor: Actor, warehouseId: string, id: string, key: string, input: z.infer<typeof PickInput>) {
    return this.runner.command(actor, warehouseId, 'wms.pick', key, 'outbound.pick', { id, ...input }, async (ctx) => {
      const o = await this.lockOrder(ctx, id);
      if (!['ALLOCATED', 'IN_PROGRESS'].includes(o.status)) throw new Conflict('Pedido não está em preparação', 'INVALID_STATE');
      const r = await row<{ id: string; position_id: string; outbound_line_id: string; qty_open: string; status: string; sku_id: string }>(
        ctx.tx,
        sql`SELECT r.id, r.position_id, r.outbound_line_id, r.qty_open::text, r.status, l.sku_id
            FROM reservations r JOIN outbound_lines l ON l.id = r.outbound_line_id
            WHERE r.id = ${input.reservationId} AND l.outbound_id = ${id} AND r.warehouse_id = ${warehouseId} FOR UPDATE OF r`,
      );
      if (!r || r.status !== 'ACTIVE') throw new NotFound('Reserva');
      // A scan counts packs of the scanned barcode's unit → base units.
      const qty = await scannedBaseQty(ctx, r.sku_id, input.barcode, input.qty);
      if (cmp(qty, r.qty_open) > 0) throw new Conflict(`Quantidade superior à reservada (${r.qty_open})`, 'QTY_EXCEEDS_RESERVATION');
      if (!isPositive(qty) && !input.closeShort) throw new Conflict('Quantidade nula', 'ZERO_QTY');
      await ctx.tx.execute(sql`SELECT id FROM outbound_lines WHERE id = ${r.outbound_line_id} FOR UPDATE`);
      const packing = await requireNodeKind(ctx, input.packingNodeId, ['DISPATCH']);
      let txnId: string | null = null;
      if (isPositive(qty)) {
        const pos = await lockPosition(ctx, r.position_id);
        txnId = await newTxn(ctx, 'PICK', { referenceType: 'outbound', referenceId: id, idempotencyKey: key });
        await relocate(ctx, txnId, pos, qty, { holder: packing, status: 'PICKED' }, { consumeReserved: qty });
        await ctx.tx.execute(sql`UPDATE outbound_lines SET qty_allocated = qty_allocated - ${qty}::numeric,
            qty_picked = qty_picked + ${qty}::numeric WHERE id = ${r.outbound_line_id}`);
      }
      let open = sub(r.qty_open, qty);
      let shortQty = '0';
      if (input.closeShort && isPositive(open)) {
        shortQty = open;
        await ctx.tx.execute(
          sql`UPDATE stock_positions SET qty_reserved = qty_reserved - ${open}::numeric, updated_at = now() WHERE id = ${r.position_id}`,
        );
        await ctx.tx.execute(sql`UPDATE outbound_lines SET qty_allocated = qty_allocated - ${open}::numeric,
            qty_short = qty_short + ${open}::numeric WHERE id = ${r.outbound_line_id}`);
        open = '0';
      }
      await ctx.tx.execute(sql`UPDATE reservations SET qty_open = ${open}::numeric, status = ${isPositive(open) ? 'ACTIVE' : 'CLOSED'},
          updated_at = now() WHERE id = ${r.id}`);
      await ctx.tx.execute(sql`UPDATE outbound_orders SET status = 'IN_PROGRESS' WHERE id = ${id}`);
      return { txnId, qtyPicked: qty, reservationOpen: open, shortRecorded: shortQty };
    });
  }

  /** Creates a PACKAGE container for this order at a DISPATCH (packing) node. */
  async createPackage(actor: Actor, warehouseId: string, id: string, key: string, input: z.infer<typeof CreatePackageInput>) {
    return this.runner.command(actor, warehouseId, 'wms.pack', key, 'outbound.package', { id, ...input }, async (ctx) => {
      const o = await this.lockOrder(ctx, id);
      if (!['ALLOCATED', 'IN_PROGRESS'].includes(o.status)) throw new Conflict('Pedido não está em preparação', 'INVALID_STATE');
      await requireNodeKind(ctx, input.nodeId, ['DISPATCH']);
      const c = await one<{ id: string }>(
        ctx.tx,
        sql`INSERT INTO containers (company_id, warehouse_id, code, kind, current_node_id, outbound_id)
            VALUES (${ctx.companyId}, ${warehouseId}, ${input.code}, 'PACKAGE', ${input.nodeId}, ${id}) RETURNING id`,
      );
      return { packageId: c.id };
    });
  }

  /** Packs picked units of a line into a package (barcode verified, traceable package lines). */
  async pack(actor: Actor, warehouseId: string, id: string, key: string, input: z.infer<typeof PackInput>) {
    return this.runner.command(actor, warehouseId, 'wms.pack', key, 'outbound.pack', { id, ...input }, async (ctx) => {
      await this.lockOrder(ctx, id);
      const pkg = await row<{ id: string; current_node_id: string; status: string }>(
        ctx.tx,
        sql`SELECT id, current_node_id, status FROM containers WHERE id = ${input.packageId} AND outbound_id = ${id}
            AND kind = 'PACKAGE' AND warehouse_id = ${warehouseId} FOR UPDATE`,
      );
      if (!pkg) throw new NotFound('Volume');
      if (pkg.status !== 'ACTIVE') throw new Conflict('Volume já expedido', 'INVALID_STATE');
      const line = await row<LineRow>(
        ctx.tx,
        sql`SELECT * FROM outbound_lines WHERE id = ${input.lineId} AND outbound_id = ${id} FOR UPDATE`,
      );
      if (!line) throw new NotFound('Linha');
      const qty = await scannedBaseQty(ctx, line.sku_id, input.barcode, input.qty);
      const packable = sub(line.qty_picked, line.qty_packed);
      if (cmp(qty, packable) > 0) throw new Conflict(`Só há ${packable} unidades separadas por embalar`, 'QTY_EXCEEDS_PICKED');
      const sources = await rows<PositionRow>(
        ctx.tx,
        sql`SELECT * FROM stock_positions WHERE warehouse_id = ${warehouseId} AND sku_id = ${line.sku_id}
            AND holder_node_id = ${pkg.current_node_id} AND stock_status = 'PICKED' AND qty_on_hand > 0 ORDER BY id FOR UPDATE`,
      );
      const txnId = await newTxn(ctx, 'PACK', { referenceType: 'outbound', referenceId: id, idempotencyKey: key });
      let remaining = toMilli(qty);
      for (const s of sources) {
        if (remaining <= 0n) break;
        const take = min(s.qty_on_hand, fromMilli(remaining));
        await relocate(ctx, txnId, s, take, { holder: { containerId: pkg.id, nodeKind: 'DISPATCH' }, status: 'PICKED' });
        remaining -= toMilli(take);
      }
      if (remaining > 0n) throw new InsufficientStock('Stock separado insuficiente na zona de embalagem do volume');
      await ctx.tx.execute(sql`INSERT INTO outbound_package_lines (company_id, warehouse_id, package_id, outbound_line_id, qty)
          VALUES (${ctx.companyId}, ${warehouseId}, ${pkg.id}, ${line.id}, ${qty}::numeric)`);
      await ctx.tx.execute(sql`UPDATE outbound_lines SET qty_packed = qty_packed + ${qty}::numeric WHERE id = ${line.id}`);
      return { txnId, qtyPacked: qty };
    });
  }

  /**
   * Un-pick: returns picked units of a line that are NOT in a package from a packing (DISPATCH)
   * node back to storage as AVAILABLE (posts UNPICK). Lots are preserved. The line's picked
   * quantity drops, so the order can be re-allocated, closed or cancelled afterwards.
   */
  async unpick(actor: Actor, warehouseId: string, id: string, key: string, input: z.infer<typeof UnpickInput>) {
    return this.runner.command(actor, warehouseId, 'wms.pick', key, 'outbound.unpick', { id, ...input }, async (ctx) => {
      const o = await this.lockOrder(ctx, id);
      if (o.status !== 'IN_PROGRESS') throw new Conflict('Pedido não está em preparação', 'INVALID_STATE');
      const line = await row<LineRow>(
        ctx.tx,
        sql`SELECT * FROM outbound_lines WHERE id = ${input.lineId} AND outbound_id = ${id} FOR UPDATE`,
      );
      if (!line) throw new NotFound('Linha');
      const loose = sub(line.qty_picked, line.qty_packed);
      if (cmp(input.qty, loose) > 0) throw new Conflict(`Só há ${loose} unidades separadas fora de volumes`, 'QTY_EXCEEDS_UNPACKED');
      await requireNodeKind(ctx, input.fromNodeId, ['DISPATCH']);
      const target = await resolveHolder(ctx, input.to, { allowedKinds: ALLOCATABLE_NODE_KINDS });
      const sources = await rows<PositionRow>(
        ctx.tx,
        sql`SELECT * FROM stock_positions WHERE warehouse_id = ${warehouseId} AND sku_id = ${line.sku_id}
            AND holder_node_id = ${input.fromNodeId} AND stock_status = 'PICKED' AND qty_on_hand > 0 ORDER BY id FOR UPDATE`,
      );
      const txnId = await newTxn(ctx, 'UNPICK', { referenceType: 'outbound', referenceId: id, note: input.reason, idempotencyKey: key });
      let remaining = toMilli(input.qty);
      for (const src of sources) {
        if (remaining <= 0n) break;
        const take = min(src.qty_on_hand, fromMilli(remaining));
        await relocate(ctx, txnId, src, take, { holder: target, status: 'AVAILABLE' });
        remaining -= toMilli(take);
      }
      if (remaining > 0n) throw new InsufficientStock('Não há unidades separadas suficientes nesta zona de embalagem');
      await ctx.tx.execute(sql`UPDATE outbound_lines SET qty_picked = qty_picked - ${input.qty}::numeric WHERE id = ${line.id}`);
      await emitEvent(ctx, 'wms.outbound.unpicked', 'outbound', id, { txnId, lineId: line.id, qty: input.qty });
      return { txnId };
    });
  }

  /**
   * Unpack: takes packed (not yet dispatched) units of a line out of a package back to the
   * package's packing node as PICKED (posts UNPACK). Package lines are never edited away:
   * `qty_unpacked` records what was removed.
   */
  async unpack(actor: Actor, warehouseId: string, id: string, key: string, input: z.infer<typeof UnpackInput>) {
    return this.runner.command(actor, warehouseId, 'wms.pack', key, 'outbound.unpack', { id, ...input }, async (ctx) => {
      const o = await this.lockOrder(ctx, id);
      if (o.status !== 'IN_PROGRESS') throw new Conflict('Pedido não está em preparação', 'INVALID_STATE');
      const pkg = await row<{ id: string; current_node_id: string; status: string }>(
        ctx.tx,
        sql`SELECT id, current_node_id, status FROM containers WHERE id = ${input.packageId} AND outbound_id = ${id}
            AND kind = 'PACKAGE' AND warehouse_id = ${warehouseId} FOR UPDATE`,
      );
      if (!pkg) throw new NotFound('Volume');
      if (pkg.status !== 'ACTIVE') throw new Conflict('Volume já expedido ou fechado', 'INVALID_STATE');
      const line = await row<LineRow>(
        ctx.tx,
        sql`SELECT * FROM outbound_lines WHERE id = ${input.lineId} AND outbound_id = ${id} FOR UPDATE`,
      );
      if (!line) throw new NotFound('Linha');
      const pls = await rows<{ id: string; left: string }>(
        ctx.tx,
        sql`SELECT id, (qty - qty_unpacked)::text AS left FROM outbound_package_lines
            WHERE package_id = ${pkg.id} AND outbound_line_id = ${line.id} AND qty > qty_unpacked ORDER BY created_at DESC, id FOR UPDATE`,
      );
      const inPkg = pls.reduce((a, p) => a + toMilli(p.left), 0n);
      if (toMilli(input.qty) > inPkg) throw new Conflict(`Só há ${fromMilli(inPkg)} unidades desta linha no volume`, 'QTY_EXCEEDS_PACKED');
      const contents = await rows<PositionRow>(
        ctx.tx,
        sql`SELECT * FROM stock_positions WHERE holder_container_id = ${pkg.id} AND sku_id = ${line.sku_id} AND qty_on_hand > 0 ORDER BY id FOR UPDATE`,
      );
      const txnId = await newTxn(ctx, 'UNPACK', { referenceType: 'outbound', referenceId: id, idempotencyKey: key });
      let remaining = toMilli(input.qty);
      for (const src of contents) {
        if (remaining <= 0n) break;
        const take = min(src.qty_on_hand, fromMilli(remaining));
        await relocate(ctx, txnId, src, take, { holder: { nodeId: pkg.current_node_id, nodeKind: 'DISPATCH' }, status: 'PICKED' });
        remaining -= toMilli(take);
      }
      if (remaining > 0n) throw new InsufficientStock('Conteúdo do volume inconsistente');
      let toRecord = toMilli(input.qty);
      for (const pl of pls) {
        if (toRecord <= 0n) break;
        const take = toMilli(pl.left) < toRecord ? toMilli(pl.left) : toRecord;
        await ctx.tx.execute(
          sql`UPDATE outbound_package_lines SET qty_unpacked = qty_unpacked + ${fromMilli(take)}::numeric WHERE id = ${pl.id}`,
        );
        toRecord -= take;
      }
      await ctx.tx.execute(sql`UPDATE outbound_lines SET qty_packed = qty_packed - ${input.qty}::numeric WHERE id = ${line.id}`);
      return { txnId };
    });
  }

  /**
   * Dispatches selected packages (partial dispatch allowed): their contents leave stock with a
   * DISPATCH ledger entry; packages become DISPATCHED. When every line is dispatched or short
   * the order closes automatically.
   */
  async dispatch(actor: Actor, warehouseId: string, id: string, key: string, input: z.infer<typeof DispatchInput>) {
    return this.runner.command(actor, warehouseId, 'wms.dispatch', key, 'outbound.dispatch', { id, ...input }, async (ctx) => {
      const o = await this.lockOrder(ctx, id);
      if (o.status !== 'IN_PROGRESS') throw new Conflict('Pedido não está em preparação', 'INVALID_STATE');
      const txnId = await newTxn(ctx, 'DISPATCH', {
        referenceType: 'outbound',
        referenceId: id,
        note: input.carrierRef,
        idempotencyKey: key,
      });
      for (const pkgId of [...new Set(input.packageIds)].sort()) {
        const pkg = await row<{ id: string; status: string }>(
          ctx.tx,
          sql`SELECT id, status FROM containers WHERE id = ${pkgId} AND outbound_id = ${id} AND kind = 'PACKAGE' FOR UPDATE`,
        );
        if (!pkg) throw new NotFound('Volume');
        if (pkg.status !== 'ACTIVE') throw new Conflict('Volume já expedido', 'ALREADY_DISPATCHED');
        const contents = await rows<PositionRow>(
          ctx.tx,
          sql`SELECT * FROM stock_positions WHERE holder_container_id = ${pkgId} AND qty_on_hand > 0 ORDER BY id FOR UPDATE`,
        );
        if (!contents.length) throw new Conflict('Volume vazio', 'EMPTY_PACKAGE');
        for (const p of contents) await applyDelta(ctx, txnId, p, `-${p.qty_on_hand}`);
        await ctx.tx.execute(sql`UPDATE containers SET status = 'DISPATCHED', updated_at = now() WHERE id = ${pkgId}`);
        await ctx.tx.execute(sql`UPDATE outbound_lines l SET qty_dispatched = l.qty_dispatched + x.q
            FROM (SELECT outbound_line_id, sum(qty - qty_unpacked) AS q FROM outbound_package_lines WHERE package_id = ${pkgId} GROUP BY outbound_line_id) x
            WHERE l.id = x.outbound_line_id`);
      }
      const done = await one<{ open: number }>(
        ctx.tx,
        sql`SELECT count(*)::int AS open FROM outbound_lines WHERE outbound_id = ${id}
            AND (qty_dispatched + qty_short < qty_requested OR qty_allocated > 0 OR qty_picked > qty_dispatched)`,
      );
      if (done.open === 0) await ctx.tx.execute(sql`UPDATE outbound_orders SET status = 'CLOSED', closed_at = now() WHERE id = ${id}`);
      await emitEvent(ctx, 'wms.outbound.dispatched', 'outbound', id, { txnId, packages: input.packageIds.length });
      return { txnId, orderStatus: done.open === 0 ? 'CLOSED' : 'IN_PROGRESS' };
    });
  }

  /**
   * Closes an order: releases open reservations; refuses when picked stock is still waiting
   * in packing (dispatch it or return it first). Optionally creates a DRAFT backorder for the
   * undelivered quantities.
   */
  async close(actor: Actor, warehouseId: string, id: string, key: string, input: z.infer<typeof CloseOutboundInput>) {
    return this.runner.command(actor, warehouseId, 'wms.outbound.manage', key, 'outbound.close', { id, ...input }, async (ctx) => {
      const o = await this.lockOrder(ctx, id);
      if (!['ALLOCATED', 'IN_PROGRESS'].includes(o.status)) throw new Conflict('Pedido não pode ser fechado', 'INVALID_STATE');
      const lines = await rows<LineRow>(ctx.tx, sql`SELECT * FROM outbound_lines WHERE outbound_id = ${id} ORDER BY line_no FOR UPDATE`);
      if (lines.some((l) => cmp(l.qty_picked, l.qty_dispatched) > 0)) {
        throw new Conflict('Existem unidades separadas por expedir', 'PICKED_NOT_DISPATCHED');
      }
      await this.releaseReservations(ctx, id);
      let backorderId: string | null = null;
      const remaining = lines
        .map((l) => ({ skuId: l.sku_id, qty: sub(l.qty_requested, l.qty_dispatched) }))
        .filter((l) => isPositive(l.qty));
      if (input.createBackorder && remaining.length) {
        backorderId = randomUUID();
        const number = await nextDocNumber(ctx, await warehouseCode(ctx), 'SAI');
        await ctx.tx
          .execute(sql`INSERT INTO outbound_orders (id, company_id, warehouse_id, number, status, external_ref, recipient_contact_enc, backorder_of, created_by)
            SELECT ${backorderId}, company_id, warehouse_id, ${number}, 'DRAFT', external_ref, NULL, id, ${actor.userId}
            FROM outbound_orders WHERE id = ${id}`);
        await this.writeLines(ctx, backorderId, remaining);
      }
      await this.closeEmptyPackages(ctx, id);
      await ctx.tx.execute(sql`UPDATE outbound_orders SET status = 'CLOSED', closed_at = now() WHERE id = ${id}`);
      await emitEvent(ctx, 'wms.outbound.closed', 'outbound', id, { backorderId });
      return { id, status: 'CLOSED', backorderId };
    });
  }

  /**
   * Cancels an order with nothing currently picked or dispatched (DRAFT/ALLOCATED, or
   * IN_PROGRESS after every picked unit was un-picked), releasing reservations and closing its
   * empty packages.
   */
  async cancel(actor: Actor, warehouseId: string, id: string, key: string) {
    return this.runner.command(actor, warehouseId, 'wms.outbound.manage', key, 'outbound.cancel', { id }, async (ctx) => {
      const o = await this.lockOrder(ctx, id);
      if (!['DRAFT', 'ALLOCATED', 'IN_PROGRESS'].includes(o.status)) throw new Conflict('Pedido já fechado', 'INVALID_STATE');
      const busy = await one<{ n: number }>(
        ctx.tx,
        sql`SELECT count(*)::int AS n FROM outbound_lines WHERE outbound_id = ${id} AND (qty_picked > 0 OR qty_dispatched > 0)`,
      );
      if (busy.n > 0) throw new Conflict('Existem unidades separadas ou expedidas; anule a separação ou feche o pedido', 'PICKED_EXISTS');
      await this.releaseReservations(ctx, id);
      await this.closeEmptyPackages(ctx, id);
      await ctx.tx.execute(sql`UPDATE outbound_orders SET status = 'CANCELLED', closed_at = now() WHERE id = ${id}`);
      return { id, status: 'CANCELLED' };
    });
  }

  /**
   * Internal dispatch note data. NOT a legally compliant Portuguese transport document
   * (documento de transporte / guia, DL 147/2003 with AT communication) — that requires the
   * future certified invoicing/transport module.
   */
  async dispatchNote(actor: Actor, warehouseId: string, id: string) {
    const view = await this.get(actor, warehouseId, id);
    return {
      ...view,
      disclaimer: 'Documento interno de expedição. NÃO é um documento de transporte válido para efeitos fiscais (DL 147/2003).',
    };
  }

  // ------------------------------------------------------------------ internals

  private async lockOrder(ctx: OpCtx, id: string) {
    const o = await row<{ id: string; status: string }>(
      ctx.tx,
      sql`SELECT id, status FROM outbound_orders WHERE id = ${id} AND warehouse_id = ${ctx.warehouseId} FOR UPDATE`,
    );
    if (!o) throw new NotFound('Pedido de saída');
    return o;
  }

  private async writeLines(ctx: OpCtx, outboundId: string, lines: Array<{ skuId: string; qty: string }>) {
    for (const l of lines) {
      await requireSku(ctx, l.skuId);
      await ctx.tx.execute(sql`INSERT INTO outbound_lines (company_id, warehouse_id, outbound_id, line_no, sku_id, qty_requested)
          VALUES (${ctx.companyId}, ${ctx.warehouseId}, ${outboundId},
            (SELECT coalesce(max(line_no), 0) + 1 FROM outbound_lines WHERE outbound_id = ${outboundId}), ${l.skuId}, ${l.qty}::numeric)`);
    }
  }

  /** Marks the order's still-ACTIVE packages CLOSED; refuses if any still holds stock. */
  private async closeEmptyPackages(ctx: OpCtx, outboundId: string) {
    const loaded = await one<{ n: number }>(
      ctx.tx,
      sql`SELECT count(*)::int AS n FROM containers c JOIN stock_positions p ON p.holder_container_id = c.id
          WHERE c.outbound_id = ${outboundId} AND c.status = 'ACTIVE' AND p.qty_on_hand > 0`,
    );
    if (loaded.n > 0) throw new Conflict('Existem volumes com conteúdo por expedir', 'PACKAGE_NOT_EMPTY');
    await ctx.tx.execute(
      sql`UPDATE containers SET status = 'CLOSED', updated_at = now() WHERE outbound_id = ${outboundId} AND status = 'ACTIVE'`,
    );
  }

  private async releaseReservations(ctx: OpCtx, outboundId: string) {
    const active = await rows<{ id: string; position_id: string; outbound_line_id: string; qty_open: string }>(
      ctx.tx,
      sql`SELECT r.id, r.position_id, r.outbound_line_id, r.qty_open::text FROM reservations r
          JOIN outbound_lines l ON l.id = r.outbound_line_id
          WHERE l.outbound_id = ${outboundId} AND r.status = 'ACTIVE' ORDER BY r.position_id FOR UPDATE OF r`,
    );
    for (const r of active) {
      await lockPosition(ctx, r.position_id);
      await ctx.tx.execute(
        sql`UPDATE stock_positions SET qty_reserved = qty_reserved - ${r.qty_open}::numeric, updated_at = now() WHERE id = ${r.position_id}`,
      );
      await ctx.tx.execute(
        sql`UPDATE outbound_lines SET qty_allocated = qty_allocated - ${r.qty_open}::numeric WHERE id = ${r.outbound_line_id}`,
      );
      await ctx.tx.execute(sql`UPDATE reservations SET qty_open = 0, status = 'CLOSED', updated_at = now() WHERE id = ${r.id}`);
    }
  }
}
