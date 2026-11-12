/**
 * @file Self-service account security: password change, own sessions, recovery codes.
 * @module platform/auth
 *
 * ASVS V6/V7: users can change their password (current password required, other sessions
 * revoked), see and terminate their own sessions, and regenerate recovery codes (step-up).
 * Every operation is limited to the caller's own account and audited.
 */
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../../config/env.js';
import { Conflict, NotFound, Unauthenticated, ValidationFailed } from '../../common/errors.js';
import { sha256 } from '../../common/crypto-util.js';
import type { Database } from '../../db/database.js';
import { row, rows } from '../../db/database.js';
import type { AuditService } from '../audit/audit.service.js';
import { type Actor, requireStepUp } from '../authz/actor.js';
import type { AuthService } from './auth.service.js';
import { hashPassword, screenPassword, verifyPassword } from './password.js';
import type { ThrottleService } from './throttle.service.js';
import { newRecoveryCodes } from './totp.js';

/** Account self-service use cases. */
export class AccountService {
  constructor(
    private readonly database: Database,
    private readonly cfg: AppConfig,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly throttle: ThrottleService,
  ) {}

  /**
   * Changes the caller's password. Requires the current password (throttled), applies the
   * password policy, refuses reuse of the same password and revokes all OTHER sessions.
   */
  async changePassword(
    actor: Actor,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ changed: true; otherSessionsRevoked: number }> {
    const key = `pwchange:${actor.userId}`;
    await this.throttle.assertAllowed([key]);
    const user = await this.auth.userById(actor.userId);
    if (!user?.password_hash) throw new Unauthenticated();
    if (!(await verifyPassword(user.password_hash, currentPassword))) {
      await this.throttle.recordFailure(key, 5);
      await this.audit.record({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'auth.password_change',
        outcome: 'FAILURE',
        requestId: actor.requestId,
        clientIp: actor.clientIp,
      });
      throw new Unauthenticated('Palavra-passe atual incorreta');
    }
    const reason = screenPassword(newPassword, await this.auth.passwordContext(user));
    if (reason) throw new ValidationFailed([{ path: 'newPassword', message: reason }], reason);
    if (await verifyPassword(user.password_hash, newPassword)) {
      throw new ValidationFailed([{ path: 'newPassword', message: 'A nova palavra-passe tem de ser diferente da atual' }]);
    }
    const h = await hashPassword(newPassword, { memoryKib: this.cfg.ARGON2_MEMORY_KIB, iterations: this.cfg.ARGON2_ITERATIONS });
    await this.throttle.clear(key);
    return this.database.systemTx(async (tx) => {
      await tx.execute(
        sql`UPDATE users SET password_hash = ${h}, password_changed_at = now(), updated_at = now() WHERE id = ${actor.userId}`,
      );
      const revoked = await rows(
        tx,
        sql`UPDATE sessions SET revoked_at = now(), revoke_reason = 'password_change'
            WHERE user_id = ${actor.userId} AND revoked_at IS NULL AND id <> ${actor.sessionId} RETURNING id`,
      );
      await this.audit.recordInTx(tx, {
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'auth.password_change',
        outcome: 'SUCCESS',
        requestId: actor.requestId,
        clientIp: actor.clientIp,
        details: { otherSessionsRevoked: revoked.length },
      });
      return { changed: true as const, otherSessionsRevoked: revoked.length };
    });
  }

  /** Lists the caller's live sessions (no token material). */
  async sessions(actor: Actor) {
    return this.database.systemTx((tx) =>
      rows(
        tx,
        sql`SELECT id, created_at AS "createdAt", last_seen_at AS "lastSeenAt", client_ip AS "clientIp", user_agent AS "userAgent",
              (id = ${actor.sessionId}) AS current
            FROM sessions WHERE user_id = ${actor.userId} AND state = 'ACTIVE' AND revoked_at IS NULL
              AND idle_expires_at > now() AND absolute_expires_at > now()
            ORDER BY last_seen_at DESC`,
      ),
    );
  }

  /** Revokes one of the caller's sessions (404 for anybody else's). */
  async revokeSession(actor: Actor, sessionId: string) {
    // ASVS 5.0 V7.5.2: ending ANOTHER session needs a fresh factor, so a stolen session cannot
    // lock the real user out. Ending the current one is a logout and needs nothing more.
    if (sessionId !== actor.sessionId) requireStepUp(actor, 'account.sessions.revoke', this.cfg.STEP_UP_MINUTES);
    return this.database.systemTx(async (tx) => {
      const r = await row<{ id: string }>(
        tx,
        sql`UPDATE sessions SET revoked_at = now(), revoke_reason = 'user_revoked'
            WHERE id = ${sessionId} AND user_id = ${actor.userId} AND revoked_at IS NULL RETURNING id`,
      );
      if (!r) throw new NotFound('Sessão', 'session_scope');
      await this.audit.recordInTx(tx, {
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'auth.session.revoke',
        resourceType: 'session',
        resourceId: sessionId,
        outcome: 'SUCCESS',
        requestId: actor.requestId,
        clientIp: actor.clientIp,
      });
      return { id: sessionId, revoked: true };
    });
  }

  /** Revokes every other session of the caller ("sign out other devices"). */
  async revokeOtherSessions(actor: Actor) {
    requireStepUp(actor, 'account.sessions.revoke', this.cfg.STEP_UP_MINUTES);
    return this.database.systemTx(async (tx) => {
      const r = await rows(
        tx,
        sql`UPDATE sessions SET revoked_at = now(), revoke_reason = 'user_revoked_others'
            WHERE user_id = ${actor.userId} AND revoked_at IS NULL AND id <> ${actor.sessionId} RETURNING id`,
      );
      await this.audit.recordInTx(tx, {
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'auth.session.revoke_others',
        outcome: 'SUCCESS',
        requestId: actor.requestId,
        clientIp: actor.clientIp,
        details: { revoked: r.length },
      });
      return { revoked: r.length };
    });
  }

  /** Replaces the caller's recovery codes (step-up). Returns the new codes ONCE. */
  async regenerateRecoveryCodes(actor: Actor): Promise<{ recoveryCodes: string[] }> {
    requireStepUp(actor, 'account.mfa.change', this.cfg.STEP_UP_MINUTES);
    const user = await this.auth.userById(actor.userId);
    if (!user?.mfa_enrolled_at) throw new Conflict('MFA não ativo', 'MFA_NOT_ENROLLED');
    const codes = newRecoveryCodes();
    await this.database.systemTx(async (tx) => {
      await tx.execute(sql`UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = ${actor.userId} AND used_at IS NULL`);
      for (const c of codes) {
        await tx.execute(
          sql`INSERT INTO mfa_recovery_codes (user_id, company_id, code_hash) VALUES (${actor.userId}, ${actor.companyId}, ${sha256(c)})`,
        );
      }
      await this.audit.recordInTx(tx, {
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'auth.recovery_codes.regenerate',
        outcome: 'SUCCESS',
        requestId: actor.requestId,
        clientIp: actor.clientIp,
        details: { alert: true },
      });
    });
    return { recoveryCodes: codes };
  }
}
