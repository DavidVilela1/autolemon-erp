/**
 * @file Company administration: warehouses, users, permissions, MFA/password resets, PII
 * access, key rotation and audit log access. ADMIN-only, default deny.
 * @module platform/admin
 *
 * High-risk operations (role/warehouse changes, MFA/password resets, PII reads, key rotation)
 * require a recent step-up MFA and are written to the hash-chained security audit log.
 * One-time tokens are returned to the administrator ONCE (no e-mail delivery in v0.5).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { ADMIN_ONLY_PERMISSIONS, type CreateUserInput, type CreateWarehouseInput, type Permission } from '@autolemon/contracts';
import { Conflict, NotFound } from '../../common/errors.js';
import type { Database, Tx } from '../../db/database.js';
import { one, row, rows } from '../../db/database.js';
import { type Actor, requirePermission, requireStepUp } from '../authz/actor.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { FieldCrypto } from '../crypto/field-crypto.js';

/** Administration use cases. */
export class AdminService {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly crypto: FieldCrypto,
    private readonly stepUpMinutes: number,
  ) {}

  /** Warehouses visible to the caller: admins → all of the company; staff → only their own. */
  async warehouses(actor: Actor) {
    return this.database.systemTx((tx) =>
      rows(
        tx,
        sql`SELECT id, code, name, active FROM warehouses WHERE company_id = ${actor.companyId}
            AND (${actor.role === 'ADMIN'} OR id = ${actor.warehouseId}) ORDER BY code`,
      ),
    );
  }

  /** Creates a warehouse (admin.users). */
  async createWarehouse(actor: Actor, input: z.infer<typeof CreateWarehouseInput>) {
    requirePermission(actor, 'admin.users');
    return this.database.systemTx(async (tx) => {
      const w = await one<{ id: string }>(
        tx,
        sql`INSERT INTO warehouses (company_id, code, name) VALUES (${actor.companyId}, ${input.code}, ${input.name}) RETURNING id`,
      );
      await this.auditTx(tx, actor, 'admin.warehouse.create', 'warehouse', w.id, { code: input.code });
      return { id: w.id };
    });
  }

  /** Lists users of the company (no secrets, PII masked). */
  async users(actor: Actor) {
    requirePermission(actor, 'admin.users');
    return this.database.systemTx((tx) =>
      rows(
        tx,
        sql`SELECT u.id, u.email, u.display_name AS "displayName", u.role, u.status, u.warehouse_id AS "warehouseId",
              u.mfa_enrolled_at IS NOT NULL AS "mfaEnrolled", (u.phone_enc IS NOT NULL) AS "hasPhone",
              coalesce((SELECT array_agg(permission ORDER BY permission) FROM user_permissions p WHERE p.user_id = u.id), '{}') AS permissions
            FROM users u WHERE u.company_id = ${actor.companyId} ORDER BY u.email`,
      ),
    );
  }

  /**
   * Creates a user in INVITED state and returns a one-time invitation token (72 h). Staff must
   * be assigned to one warehouse of the company; admin-only permissions cannot be granted.
   */
  async createUser(actor: Actor, input: z.infer<typeof CreateUserInput>) {
    requirePermission(actor, 'admin.users');
    if (input.role === 'ADMIN') requireStepUp(actor, 'users.role.change', this.stepUpMinutes);
    const perms = this.sanitisePermissions(input.role, input.permissions);
    const id = randomUUID();
    const phoneEnc = input.phone
      ? await this.crypto.encrypt({ companyId: actor.companyId, table: 'users', recordId: id, field: 'phone' }, input.phone)
      : null;
    return this.database.systemTx(async (tx) => {
      if (input.warehouseId) await this.requireOwnWarehouse(tx, actor, input.warehouseId);
      await tx.execute(sql`INSERT INTO users (id, company_id, email, display_name, role, status, warehouse_id, phone_enc)
          VALUES (${id}, ${actor.companyId}, ${input.email}, ${input.displayName}, ${input.role}, 'INVITED',
            ${input.role === 'ADMIN' ? null : input.warehouseId}, ${phoneEnc})`);
      await this.writePermissions(tx, actor, id, perms);
      const token = await this.auth.issueToken(tx, id, actor.companyId, 'INVITATION', actor.userId);
      await this.auditTx(tx, actor, 'admin.user.create', 'user', id, { role: input.role, permissionCodes: perms.join(',') });
      return { id, invitationToken: token, expiresInHours: 72 };
    });
  }

  /** Replaces a staff member's permission set. */
  async updatePermissions(actor: Actor, userId: string, permissions: Permission[]) {
    requirePermission(actor, 'admin.users');
    return this.database.systemTx(async (tx) => {
      const u = await this.requireUser(tx, actor, userId);
      if (u.role === 'ADMIN') throw new Conflict('Administradores têm todas as permissões', 'ADMIN_PERMISSIONS_FIXED');
      const perms = this.sanitisePermissions('STAFF', permissions);
      await tx.execute(sql`DELETE FROM user_permissions WHERE user_id = ${userId}`);
      await this.writePermissions(tx, actor, userId, perms);
      await this.auth.revokeAllSessionsInTx(tx, userId, 'privilege_change');
      await this.auditTx(tx, actor, 'admin.user.permissions', 'user', userId, { permissionCodes: perms.join(',') });
      return { id: userId, permissions: perms };
    });
  }

  /** Re-assigns a staff member to another warehouse (step-up; sessions revoked). */
  async changeWarehouse(actor: Actor, userId: string, warehouseId: string) {
    requirePermission(actor, 'admin.users');
    requireStepUp(actor, 'users.warehouse.change', this.stepUpMinutes);
    return this.database.systemTx(async (tx) => {
      const u = await this.requireUser(tx, actor, userId);
      if (u.role !== 'STAFF') throw new Conflict('Só funcionários têm armazém atribuído', 'NOT_STAFF');
      await this.requireOwnWarehouse(tx, actor, warehouseId);
      await tx.execute(sql`UPDATE users SET warehouse_id = ${warehouseId}, updated_at = now() WHERE id = ${userId}`);
      await this.auth.revokeAllSessionsInTx(tx, userId, 'warehouse_change');
      await this.auditTx(tx, actor, 'admin.user.warehouse', 'user', userId, { warehouseId });
      return { id: userId, warehouseId };
    });
  }

  /** Disables a user and revokes all their sessions. */
  async deactivate(actor: Actor, userId: string) {
    requirePermission(actor, 'admin.users');
    if (userId === actor.userId) throw new Conflict('Não pode desativar a sua própria conta', 'SELF_DEACTIVATION');
    return this.database.systemTx(async (tx) => {
      await this.requireUser(tx, actor, userId);
      await tx.execute(sql`UPDATE users SET status = 'DISABLED', updated_at = now() WHERE id = ${userId}`);
      await this.auth.revokeAllSessionsInTx(tx, userId, 'deactivated');
      await this.auditTx(tx, actor, 'admin.user.deactivate', 'user', userId, {});
      return { id: userId, status: 'DISABLED' };
    });
  }

  /**
   * MFA reset (lost authenticator): removes the factor and recovery codes, revokes sessions and
   * returns a one-time MFA_RESET token (24 h) that the user redeems with their password.
   */
  async resetMfa(actor: Actor, userId: string) {
    requirePermission(actor, 'admin.security');
    requireStepUp(actor, 'users.mfa.reset', this.stepUpMinutes);
    return this.database.systemTx(async (tx) => {
      await this.requireUser(tx, actor, userId);
      await tx.execute(sql`UPDATE users SET mfa_enrolled_at = NULL, updated_at = now() WHERE id = ${userId}`);
      await tx.execute(sql`UPDATE mfa_totp SET confirmed_at = NULL WHERE user_id = ${userId}`);
      await tx.execute(sql`UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = ${userId} AND used_at IS NULL`);
      await this.auth.revokeAllSessionsInTx(tx, userId, 'mfa_reset');
      const token = await this.auth.issueToken(tx, userId, actor.companyId, 'MFA_RESET', actor.userId);
      await this.auditTx(tx, actor, 'admin.user.mfa_reset', 'user', userId, { alert: true });
      return { id: userId, mfaResetToken: token, expiresInHours: 24 };
    });
  }

  /** Issues a one-time password reset token (60 min). */
  async issuePasswordReset(actor: Actor, userId: string) {
    requirePermission(actor, 'admin.security');
    requireStepUp(actor, 'users.password.reset', this.stepUpMinutes);
    return this.database.systemTx(async (tx) => {
      await this.requireUser(tx, actor, userId);
      const token = await this.auth.issueToken(tx, userId, actor.companyId, 'PASSWORD_RESET', actor.userId);
      await this.auditTx(tx, actor, 'admin.user.password_reset_issued', 'user', userId, {});
      return { id: userId, passwordResetToken: token, expiresInMinutes: 60 };
    });
  }

  /**
   * Decrypts a user's phone number. Explicit authorization (pii.read), recent step-up and a
   * security audit entry are required for this high-risk read.
   */
  async readPii(actor: Actor, userId: string) {
    requirePermission(actor, 'pii.read');
    requireStepUp(actor, 'pii.read', this.stepUpMinutes);
    const u = await this.database.systemTx((tx) => this.requireUser(tx, actor, userId));
    const phone = u.phone_enc
      ? await this.crypto.decrypt({ companyId: actor.companyId, table: 'users', recordId: userId, field: 'phone' }, u.phone_enc)
      : null;
    await this.audit.record({
      companyId: actor.companyId,
      actorUserId: actor.userId,
      action: 'admin.pii.read',
      resourceType: 'user',
      resourceId: userId,
      outcome: 'SUCCESS',
      requestId: actor.requestId,
      clientIp: actor.clientIp,
      details: { field: 'phone' },
    });
    return { id: userId, phone };
  }

  /** Rotates the tenant data-encryption key and re-encrypts all encrypted fields. */
  async rotateKeys(actor: Actor) {
    requirePermission(actor, 'admin.security');
    requireStepUp(actor, 'keys.rotate', this.stepUpMinutes);
    const r = await this.crypto.rotateTenantKey(actor.companyId);
    await this.audit.record({
      companyId: actor.companyId,
      actorUserId: actor.userId,
      action: 'admin.keys.rotate',
      outcome: 'SUCCESS',
      requestId: actor.requestId,
      clientIp: actor.clientIp,
      details: { newVersion: r.newVersion, reencrypted: r.reencrypted },
    });
    return r;
  }

  /** Recent security audit entries of the company (admin.audit.read). */
  async auditLog(actor: Actor, limit = 200) {
    requirePermission(actor, 'admin.audit.read');
    return this.database.systemTx((tx) =>
      rows(
        tx,
        sql`SELECT a.seq::text, a.occurred_at AS "occurredAt", a.action, a.outcome, a.resource_type AS "resourceType",
              a.resource_id AS "resourceId", a.warehouse_id AS "warehouseId", u.display_name AS actor, a.client_ip AS "clientIp",
              a.request_id AS "requestId", a.details
            FROM security_audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
            WHERE a.company_id = ${actor.companyId} ORDER BY a.seq DESC LIMIT ${Math.min(Math.max(limit, 1), 1000)}`,
      ),
    );
  }

  /** Verifies the company's audit hash chain. */
  async verifyAudit(actor: Actor) {
    requirePermission(actor, 'admin.audit.read');
    return this.audit.verifyChain(actor.companyId);
  }

  /** Admin-only warehouse context switch (audited). Enforcement remains per request. */
  async switchWarehouse(actor: Actor, warehouseId: string) {
    if (actor.role !== 'ADMIN') throw new NotFound('Armazém', 'warehouse_switch_by_staff');
    return this.database.systemTx(async (tx) => {
      await this.requireOwnWarehouse(tx, actor, warehouseId);
      await tx.execute(sql`UPDATE sessions SET active_warehouse_id = ${warehouseId} WHERE id = ${actor.sessionId}`);
      await this.auditTx(tx, actor, 'admin.warehouse.switch', 'warehouse', warehouseId, {});
      return { warehouseId };
    });
  }

  // ------------------------------------------------------------------ internals

  private sanitisePermissions(role: string, perms: Permission[]): Permission[] {
    if (role === 'ADMIN') return [];
    const bad = perms.filter((p) => ADMIN_ONLY_PERMISSIONS.includes(p));
    if (bad.length) throw new Conflict(`Permissões reservadas a administradores: ${bad.join(', ')}`, 'ADMIN_ONLY_PERMISSION');
    return [...new Set(perms)].sort();
  }

  private async writePermissions(tx: Tx, actor: Actor, userId: string, perms: Permission[]) {
    for (const p of perms) {
      await tx.execute(sql`INSERT INTO user_permissions (user_id, company_id, permission, granted_by)
          VALUES (${userId}, ${actor.companyId}, ${p}, ${actor.userId})`);
    }
  }

  private async requireUser(tx: Tx, actor: Actor, userId: string) {
    const u = await row<{ id: string; role: string; phone_enc: string | null }>(
      tx,
      sql`SELECT id, role, phone_enc FROM users WHERE id = ${userId} AND company_id = ${actor.companyId}`,
    );
    if (!u) throw new NotFound('Utilizador', 'cross_tenant_user');
    return u;
  }

  private async requireOwnWarehouse(tx: Tx, actor: Actor, warehouseId: string) {
    const w = await row(tx, sql`SELECT id FROM warehouses WHERE id = ${warehouseId} AND company_id = ${actor.companyId} AND active`);
    if (!w) throw new NotFound('Armazém', 'warehouse_scope');
  }

  private async auditTx(
    tx: Tx,
    actor: Actor,
    action: string,
    type: string,
    id: string,
    details: Record<string, string | number | boolean | null>,
  ) {
    await this.audit.recordInTx(tx, {
      companyId: actor.companyId,
      actorUserId: actor.userId,
      action,
      resourceType: type,
      resourceId: id,
      outcome: 'SUCCESS',
      requestId: actor.requestId,
      clientIp: actor.clientIp,
      details,
    });
  }
}
