/**
 * @file Authenticated actor model and object-level authorization helpers (default deny).
 * @module platform/authz
 *
 * Route guards only establish WHO is calling. Every service method then calls these helpers
 * to decide WHAT the caller may do on WHICH object:
 *  - {@link requirePermission}: action-level check against the permission set.
 *  - {@link warehouseScope}: object-level tenant + warehouse check. Staff can only ever act
 *    on their assigned warehouse; admins on any active warehouse of THEIR company.
 *  - {@link requireStepUp}: recent MFA re-verification for high-risk actions.
 * Failures throw Forbidden/NotFound/StepUpRequired which the exception filter audits.
 */
import { sql } from 'drizzle-orm';
import type { Permission, Role, StepUpAction } from '@autolemon/contracts';
import { Forbidden, NotFound, StepUpRequired } from '../../common/errors.js';
import type { Database, TenantScope } from '../../db/database.js';
import { row } from '../../db/database.js';

/** The authenticated principal attached to every protected request. */
export interface Actor {
  userId: string;
  companyId: string;
  role: Role;
  displayName: string;
  /** Assigned warehouse (always set for STAFF; null for ADMIN). */
  warehouseId: string | null;
  permissions: ReadonlySet<Permission>;
  sessionId: string;
  stepUpAt: Date | null;
  requestId: string;
  clientIp: string;
}

/** Throws Forbidden unless the actor holds `perm`. */
export function requirePermission(actor: Actor, perm: Permission): void {
  if (!actor.permissions.has(perm)) throw new Forbidden(`missing_permission:${perm}`);
}

/** True when the actor holds `perm` (for field-level masking decisions). */
export function hasPermission(actor: Actor, perm: Permission): boolean {
  return actor.permissions.has(perm);
}

/** Throws StepUpRequired unless a step-up verification happened within `minutes`. */
export function requireStepUp(actor: Actor, action: StepUpAction, minutes: number): void {
  if (!actor.stepUpAt || Date.now() - actor.stepUpAt.getTime() > minutes * 60_000) {
    throw new StepUpRequired(action);
  }
}

/** RLS scope for company-level operations: admins see all warehouses, staff only theirs. */
export function companyScope(actor: Actor): TenantScope {
  return { companyId: actor.companyId, whScope: actor.role === 'ADMIN' ? '*' : actor.warehouseId! };
}

/**
 * Object-level warehouse authorization. Returns the RLS scope pinned to that single
 * warehouse. A warehouse the caller may not access yields 404 (indistinguishable from a
 * non-existent one) to prevent cross-warehouse/tenant enumeration.
 */
export async function warehouseScope(database: Database, actor: Actor, warehouseId: string): Promise<TenantScope> {
  if (actor.role !== 'ADMIN') {
    if (actor.warehouseId !== warehouseId) throw new NotFound('Armazém', 'warehouse_scope');
    return { companyId: actor.companyId, whScope: warehouseId };
  }
  const wh = await database.systemTx((tx) =>
    row<{ id: string }>(tx, sql`SELECT id FROM warehouses WHERE id = ${warehouseId} AND company_id = ${actor.companyId} AND active`),
  );
  if (!wh) throw new NotFound('Armazém', 'warehouse_scope');
  return { companyId: actor.companyId, whScope: warehouseId };
}
