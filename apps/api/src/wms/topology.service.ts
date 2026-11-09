/**
 * @file Warehouse topology: fixed storage nodes and movable containers.
 * @module wms
 *
 * Supported nesting (enforced here for clear errors AND by a database trigger):
 *   ZONE (root) > AISLE > RACK > SHELF > BIN; LOCATION under ZONE/AISLE/RACK/SHELF;
 *   STAGING / INSPECTION / QUARANTINE / DISPATCH at root or under a ZONE;
 *   containers (BOX/TOTE/PALLET/PACKAGE) sit on a stock-holding fixed node only.
 * Unsupported: containers inside containers, re-parenting fixed nodes (prevents cycles by
 * construction), stock on ZONE/AISLE/RACK.
 */
import { sql } from 'drizzle-orm';
import type { NodeKind } from '@autolemon/contracts';
import type { z } from 'zod';
import type { CreateContainerInput, CreateNodeInput, MoveContainerInput } from '@autolemon/contracts';
import { Conflict, NotFound } from '../common/errors.js';
import { one, row, rows } from '../db/database.js';
import type { Actor } from '../platform/authz/actor.js';
import { emitEvent, newTxn, resolveHolder } from './inventory/engine.js';
import type { WmsRunner } from './runner.js';

/** Allowed parent kinds per child kind (null = root). Mirrors wms_node_parent_allowed(). */
export const NESTING_RULES: Record<NodeKind, ReadonlyArray<NodeKind | null>> = {
  ZONE: [null],
  AISLE: ['ZONE'],
  RACK: ['ZONE', 'AISLE'],
  SHELF: ['RACK'],
  BIN: ['RACK', 'SHELF'],
  LOCATION: ['ZONE', 'AISLE', 'RACK', 'SHELF'],
  STAGING: [null, 'ZONE'],
  INSPECTION: [null, 'ZONE'],
  QUARANTINE: [null, 'ZONE'],
  DISPATCH: [null, 'ZONE'],
};

/** Whether a node kind may hold stock, and whether that is configurable. */
export function holdsStockFor(kind: NodeKind, requested?: boolean): boolean {
  if (kind === 'ZONE' || kind === 'AISLE' || kind === 'RACK') {
    if (requested) throw new Conflict(`${kind} não pode armazenar stock diretamente`, 'NESTING_UNSUPPORTED');
    return false;
  }
  if (kind === 'SHELF') return requested ?? true;
  return true;
}

/** Returns a pt-PT error when `child` may not be nested under `parent`. */
export function nestingError(child: NodeKind, parent: NodeKind | null): string | undefined {
  return NESTING_RULES[child].includes(parent) ? undefined : `Não é suportado colocar ${child} dentro de ${parent ?? '(raiz)'}`;
}

/** Topology use cases. */
export class TopologyService {
  constructor(private readonly runner: WmsRunner) {}

  /** Lists all fixed nodes of a warehouse (tree order by path). */
  async listNodes(actor: Actor, warehouseId: string) {
    return this.runner.read(actor, warehouseId, 'wms.view', (ctx) =>
      rows(
        ctx.tx,
        sql`SELECT id, parent_id AS "parentId", kind, code, name, holds_stock AS "holdsStock", depth, path, active
            FROM storage_nodes WHERE warehouse_id = ${warehouseId} ORDER BY path`,
      ),
    );
  }

  /** Creates a fixed node after validating nesting and computing its materialised path. */
  async createNode(actor: Actor, warehouseId: string, key: string, input: z.infer<typeof CreateNodeInput>) {
    return this.runner.command(actor, warehouseId, 'wms.topology.manage', key, 'node.create', input, async (ctx) => {
      let parent: { id: string; kind: NodeKind; depth: number; path: string } | undefined;
      if (input.parentId) {
        parent = await row(
          ctx.tx,
          sql`SELECT id, kind, depth, path FROM storage_nodes WHERE id = ${input.parentId} AND warehouse_id = ${warehouseId}`,
        );
        if (!parent) throw new NotFound('Nó pai');
      }
      const err = nestingError(input.kind, parent?.kind ?? null);
      if (err) throw new Conflict(err, 'NESTING_UNSUPPORTED');
      const holds = holdsStockFor(input.kind, input.holdsStock);
      const path = parent ? `${parent.path}/${input.code}` : input.code;
      const created = await one<{ id: string }>(
        ctx.tx,
        sql`INSERT INTO storage_nodes (company_id, warehouse_id, parent_id, kind, code, name, holds_stock, depth, path)
            VALUES (${ctx.companyId}, ${warehouseId}, ${parent?.id ?? null}, ${input.kind}, ${input.code}, ${input.name},
              ${holds}, ${parent ? parent.depth + 1 : 0}, ${path})
            RETURNING id`,
      );
      return { id: created.id, path };
    });
  }

  /** Lists containers with current location. */
  async listContainers(actor: Actor, warehouseId: string) {
    return this.runner.read(actor, warehouseId, 'wms.view', (ctx) =>
      rows(
        ctx.tx,
        sql`SELECT c.id, c.code, c.kind, c.status, c.current_node_id AS "nodeId", n.path AS "nodePath", c.outbound_id AS "outboundId",
              (SELECT coalesce(sum(qty_on_hand), 0.000)::text FROM stock_positions p WHERE p.holder_container_id = c.id) AS "qtyTotal"
            FROM containers c JOIN storage_nodes n ON n.id = c.current_node_id
            WHERE c.warehouse_id = ${warehouseId} ORDER BY c.code`,
      ),
    );
  }

  /** Creates a movable container on a stock-holding node. */
  async createContainer(actor: Actor, warehouseId: string, key: string, input: z.infer<typeof CreateContainerInput>) {
    return this.runner.command(actor, warehouseId, 'wms.topology.manage', key, 'container.create', input, async (ctx) => {
      await resolveHolder(ctx, { nodeId: input.nodeId });
      const c = await one<{ id: string }>(
        ctx.tx,
        sql`INSERT INTO containers (company_id, warehouse_id, code, kind, current_node_id)
            VALUES (${ctx.companyId}, ${warehouseId}, ${input.code}, ${input.kind}, ${input.nodeId}) RETURNING id`,
      );
      return { id: c.id };
    });
  }

  /**
   * Moves a whole container. Its stock positions are untouched (they reference the container,
   * not the node), so contents move without redistribution; history is appended to
   * container_movements with a CONTAINER_MOVE transaction for auditability.
   */
  async moveContainer(actor: Actor, warehouseId: string, containerId: string, key: string, input: z.infer<typeof MoveContainerInput>) {
    return this.runner.command(actor, warehouseId, 'wms.putaway', key, 'container.move', { containerId, ...input }, async (ctx) => {
      const c = await row<{ id: string; current_node_id: string; status: string; kind: string }>(
        ctx.tx,
        sql`SELECT id, current_node_id, status, kind FROM containers WHERE id = ${containerId} AND warehouse_id = ${warehouseId} FOR UPDATE`,
      );
      if (!c) throw new NotFound('Caixa');
      if (c.status !== 'ACTIVE') throw new Conflict('Só caixas ativas podem ser movidas', 'CONTAINER_NOT_ACTIVE');
      if (c.current_node_id === input.toNodeId) throw new Conflict('A caixa já está nessa localização', 'SAME_POSITION');
      await resolveHolder(ctx, { nodeId: input.toNodeId });
      const txnId = await newTxn(ctx, 'CONTAINER_MOVE', { referenceType: 'container', referenceId: containerId, note: input.reason });
      await ctx.tx.execute(sql`UPDATE containers SET current_node_id = ${input.toNodeId}, updated_at = now() WHERE id = ${containerId}`);
      await ctx.tx.execute(
        sql`INSERT INTO container_movements (company_id, warehouse_id, container_id, from_node_id, to_node_id, txn_id, actor_user_id, reason)
            VALUES (${ctx.companyId}, ${warehouseId}, ${containerId}, ${c.current_node_id}, ${input.toNodeId}, ${txnId}, ${actor.userId}, ${input.reason ?? null})`,
      );
      await emitEvent(ctx, 'wms.container.moved', 'container', containerId, { from: c.current_node_id, to: input.toNodeId, txnId });
      return { txnId, containerId, fromNodeId: c.current_node_id, toNodeId: input.toNodeId };
    });
  }

  /** Movement history of a container. */
  async containerHistory(actor: Actor, warehouseId: string, containerId: string) {
    return this.runner.read(actor, warehouseId, 'wms.view', (ctx) =>
      rows(
        ctx.tx,
        sql`SELECT m.moved_at AS "movedAt", f.path AS "from", t.path AS "to", m.reason, u.display_name AS "actor", m.txn_id AS "txnId"
            FROM container_movements m
            JOIN storage_nodes f ON f.id = m.from_node_id JOIN storage_nodes t ON t.id = m.to_node_id
            JOIN users u ON u.id = m.actor_user_id
            WHERE m.container_id = ${containerId} AND m.warehouse_id = ${warehouseId} ORDER BY m.id`,
      ),
    );
  }
}
