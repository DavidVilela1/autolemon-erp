/**
 * @file Authentication flows: password + mandatory MFA, sessions, step-up, enrolment, resets.
 * @module platform/auth
 *
 * Session model (opaque, server-managed):
 *  1. POST /auth/login verifies the password and creates a MFA_PENDING session (5 min).
 *  2. POST /auth/mfa/verify verifies TOTP (or a single-use recovery code). The pending session
 *     is revoked and a NEW session token is issued (rotation on privilege change).
 *  3. Every request presents the cookie token; only SHA-256(token) is stored. Idle and absolute
 *     timeouts are enforced server-side on every request.
 *  4. Writes additionally require the per-session CSRF token header (synchronizer token).
 * Accounts without a confirmed MFA factor cannot log in at all: the only way to enrol is a
 * one-time invitation / MFA-reset token issued by an administrator (prevents a password-only
 * attacker from enrolling their own authenticator).
 */
import { createHmac, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ADMIN_ONLY_PERMISSIONS, PERMISSIONS, type Permission, type Role } from '@autolemon/contracts';
import type { AppConfig } from '../../config/env.js';
import type { Database, Tx } from '../../db/database.js';
import { asDate, row, rows } from '../../db/database.js';
import { Conflict, DomainError, NotFound, Unauthenticated, ValidationFailed } from '../../common/errors.js';
import { randomToken, safeEqual, sha256 } from '../../common/crypto-util.js';
import type { AuditService } from '../audit/audit.service.js';
import type { FieldCrypto } from '../crypto/field-crypto.js';
import type { Actor } from '../authz/actor.js';
import { hashPassword, needsRehash, screenPassword, verifyPassword } from './password.js';
import type { ThrottleService } from './throttle.service.js';
import { newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from './totp.js';

/** Request metadata used for auditing and throttling (never secrets). */
export interface ClientInfo {
  ip: string;
  userAgent: string;
  requestId: string;
}

/** Tokens returned to the HTTP layer (cookie value + CSRF header value). */
export interface IssuedSession {
  token: string;
  csrfToken: string;
}

/** Session row as stored (timestamps normalised to Date). */
export interface SessionRow {
  id: string;
  user_id: string;
  company_id: string;
  csrf_hash: Buffer;
  state: 'MFA_PENDING' | 'ACTIVE';
  mfa_attempts: number;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  last_seen_at: Date;
  step_up_at: Date | null;
  revoked_at: Date | null;
}

/** User row (internal; never returned to clients as-is). */
export interface UserRow {
  id: string;
  company_id: string;
  email: string;
  display_name: string;
  role: Role;
  status: 'INVITED' | 'ACTIVE' | 'DISABLED';
  warehouse_id: string | null;
  password_hash: string | null;
  mfa_enrolled_at: Date | null;
}

const MFA_PENDING_MINUTES = 5;
const MAX_MFA_ATTEMPTS = 5;

/** Error raised when policy demands a passkey instead of TOTP. */
export class PasskeyRequired extends DomainError {
  constructor() {
    super(403, 'PASSKEY_REQUIRED', 'Esta conta exige uma chave de acesso (passkey) como segundo fator');
  }
}

/** Implements all authentication use cases. Pure service: no HTTP types. */
export class AuthService {
  private dummyHash: Promise<string>;

  constructor(
    private readonly database: Database,
    private readonly cfg: AppConfig,
    private readonly audit: AuditService,
    private readonly crypto: FieldCrypto,
    private readonly throttle: ThrottleService,
  ) {
    // Equalises timing for unknown accounts: always one Argon2 verification per login.
    this.dummyHash = hashPassword(randomToken(), this.argon());
  }

  private argon() {
    return { memoryKib: this.cfg.ARGON2_MEMORY_KIB, iterations: this.cfg.ARGON2_ITERATIONS };
  }

  // ------------------------------------------------------------------ login

  /**
   * Step 1 of login. Identical error for unknown e-mail, wrong password, disabled account and
   * missing MFA enrolment (anti-enumeration). Throttled per e-mail and per IP.
   */
  async login(email: string, password: string, client: ClientInfo): Promise<IssuedSession> {
    const emailKey = `login:${email}`;
    const ipKey = `ip:${client.ip}`;
    await this.throttle.assertAllowed([emailKey, ipKey]);
    const user = await this.database.systemTx((tx) => row<UserRow>(tx, sql`SELECT * FROM users WHERE email = ${email}`));
    const ok = await verifyPassword(user?.password_hash ?? (await this.dummyHash), password);
    const usable = !!user && ok && user.status === 'ACTIVE' && !!user.mfa_enrolled_at;
    if (!usable) {
      await this.throttle.recordFailure(emailKey, 5);
      await this.throttle.recordFailure(ipKey, 50);
      await this.audit.record({
        companyId: user?.company_id ?? null,
        actorUserId: user?.id ?? null,
        action: 'auth.login',
        outcome: 'FAILURE',
        requestId: client.requestId,
        clientIp: client.ip,
        details: { reason: !user ? 'unknown_account' : !ok ? 'bad_password' : 'account_not_usable' },
      });
      throw new Unauthenticated('Credenciais inválidas');
    }
    await this.throttle.clear(emailKey);
    if (needsRehash(user.password_hash!, this.argon())) {
      const upgraded = await hashPassword(password, this.argon());
      await this.database.systemTx((tx) =>
        tx.execute(sql`UPDATE users SET password_hash = ${upgraded}, updated_at = now() WHERE id = ${user.id}`),
      );
    }
    return this.database.systemTx(async (tx) => {
      const s = await this.createSession(tx, user, 'MFA_PENDING', client);
      await this.audit.recordInTx(tx, {
        companyId: user.company_id,
        actorUserId: user.id,
        action: 'auth.password_verified',
        outcome: 'SUCCESS',
        requestId: client.requestId,
        clientIp: client.ip,
      });
      return s;
    });
  }

  /**
   * Step 2: verify TOTP or a recovery code for a MFA_PENDING session, then ROTATE the session.
   * After MAX_MFA_ATTEMPTS failures the pending session is revoked.
   */
  async verifyMfa(token: string, factor: { code?: string; recoveryCode?: string }, client: ClientInfo): Promise<IssuedSession> {
    const session = await this.loadSession(token);
    if (!session || session.state !== 'MFA_PENDING') throw new Unauthenticated();
    await this.throttle.assertAllowed([`mfa:${session.user_id}`]);
    const user = await this.userById(session.user_id);
    if (!user || user.status !== 'ACTIVE') throw new Unauthenticated();
    // Admin passkey policy: once an administrator has a passkey, TOTP is no longer accepted as
    // the login factor (recovery codes stay available as the audited break-glass path).
    if (factor.code && (await this.passkeyPolicyApplies(user)) && (await this.activePasskeyCount(user.id)) > 0) {
      throw new PasskeyRequired();
    }

    let ok = false;
    let usedRecovery = false;
    if (factor.code) ok = await this.consumeTotp(user, factor.code);
    else if (factor.recoveryCode) {
      ok = await this.consumeRecoveryCode(user, factor.recoveryCode);
      usedRecovery = ok;
    }
    if (!ok) {
      await this.recordMfaFailure(session, user, client, factor.code ? 'totp' : 'recovery');
      throw new Unauthenticated('Código MFA inválido');
    }
    return this.completeMfa(session.id, user, client, usedRecovery ? 'recovery' : 'totp');
  }

  /**
   * Records a failed second-factor attempt: per-user throttle, per-session attempt counter
   * (revoking the pending session after MAX_MFA_ATTEMPTS) and a FAILURE audit entry.
   */
  async recordMfaFailure(session: SessionRow, user: UserRow, client: ClientInfo, method: 'totp' | 'recovery' | 'passkey'): Promise<void> {
    await this.throttle.recordFailure(`mfa:${user.id}`, 10);
    const attempts = await this.database.systemTx(async (tx) => {
      const r = await row<{ mfa_attempts: number }>(
        tx,
        sql`UPDATE sessions SET mfa_attempts = mfa_attempts + 1 WHERE id = ${session.id} RETURNING mfa_attempts`,
      );
      if ((r?.mfa_attempts ?? 0) >= MAX_MFA_ATTEMPTS) {
        await tx.execute(sql`UPDATE sessions SET revoked_at = now(), revoke_reason = 'mfa_attempts' WHERE id = ${session.id}`);
      }
      return r?.mfa_attempts ?? 0;
    });
    await this.audit.record({
      companyId: user.company_id,
      actorUserId: user.id,
      action: 'auth.mfa_verify',
      outcome: 'FAILURE',
      requestId: client.requestId,
      clientIp: client.ip,
      details: { attempts, method },
    });
  }

  /**
   * Successful second factor: revokes the MFA_PENDING session and issues a NEW active session
   * (rotation on privilege change). Recovery-code use is audited as an alert.
   */
  async completeMfa(
    pendingSessionId: string,
    user: UserRow,
    client: ClientInfo,
    method: 'totp' | 'recovery' | 'passkey',
  ): Promise<IssuedSession> {
    await this.throttle.clear(`mfa:${user.id}`);
    return this.database.systemTx(async (tx) => {
      const revoked = await row<{ id: string }>(
        tx,
        sql`UPDATE sessions SET revoked_at = now(), revoke_reason = 'rotated' WHERE id = ${pendingSessionId} AND revoked_at IS NULL RETURNING id`,
      );
      // A pending session can be upgraded only once (concurrent double submit loses).
      if (!revoked) throw new Unauthenticated();
      const issued = await this.createSession(tx, user, 'ACTIVE', client);
      let remaining: number | null = null;
      if (method === 'recovery') {
        const r = await row<{ n: string }>(
          tx,
          sql`SELECT count(*)::text AS n FROM mfa_recovery_codes WHERE user_id = ${user.id} AND used_at IS NULL`,
        );
        remaining = Number(r?.n ?? 0);
      }
      await this.audit.recordInTx(tx, {
        companyId: user.company_id,
        actorUserId: user.id,
        action: method === 'recovery' ? 'auth.login.recovery_code_used' : 'auth.login',
        outcome: 'SUCCESS',
        requestId: client.requestId,
        clientIp: client.ip,
        // Recovery-code use is an alerting signal (possible lost/stolen authenticator).
        details: method === 'recovery' ? { remainingRecoveryCodes: remaining, alert: true } : { method },
      });
      return issued;
    });
  }

  /** True when the admin passkey policy applies to this user. */
  async passkeyPolicyApplies(user: Pick<UserRow, 'role'>): Promise<boolean> {
    return user.role === 'ADMIN' && this.cfg.ADMIN_PASSKEY_REQUIRED;
  }

  /** Number of non-revoked passkeys of a user. */
  async activePasskeyCount(userId: string): Promise<number> {
    const r = await this.database.systemTx((tx) =>
      row<{ n: number }>(tx, sql`SELECT count(*)::int AS n FROM webauthn_credentials WHERE user_id = ${userId} AND revoked_at IS NULL`),
    );
    return r?.n ?? 0;
  }

  /** Loads a user row by id. */
  async userById(userId: string): Promise<UserRow | undefined> {
    return this.database.systemTx((tx) => row<UserRow>(tx, sql`SELECT * FROM users WHERE id = ${userId}`));
  }

  /** Resolves a live (non-expired, non-revoked) session by its raw token. */
  async sessionByToken(token: string): Promise<SessionRow | undefined> {
    return this.loadSession(token);
  }

  /** Stamps the session with a successful step-up verification (audited). */
  async markStepUp(actor: Actor, method: 'totp' | 'passkey'): Promise<void> {
    await this.database.systemTx(async (tx) => {
      await tx.execute(sql`UPDATE sessions SET step_up_at = now() WHERE id = ${actor.sessionId}`);
      await this.audit.recordInTx(tx, {
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'auth.step_up',
        outcome: 'SUCCESS',
        requestId: actor.requestId,
        clientIp: actor.clientIp,
        details: { method },
      });
    });
  }

  /**
   * Resolves a session token to an Actor (ACTIVE sessions only). Enforces revocation, idle and
   * absolute expiry and user status; slides the idle window (at most once per minute).
   */
  async authenticate(token: string, client: ClientInfo): Promise<{ actor: Actor; csrfHash: Buffer }> {
    const s = await this.loadSession(token);
    if (!s || s.state !== 'ACTIVE') throw new Unauthenticated();
    const user = await this.database.systemTx((tx) => row<UserRow>(tx, sql`SELECT * FROM users WHERE id = ${s.user_id}`));
    if (!user || user.status !== 'ACTIVE' || !user.mfa_enrolled_at) throw new Unauthenticated();
    if (Date.now() - s.last_seen_at.getTime() > 60_000) {
      const idle = this.cfg.SESSION_IDLE_MINUTES;
      await this.database.systemTx((tx) =>
        tx.execute(sql`UPDATE sessions SET last_seen_at = now(),
          idle_expires_at = LEAST(now() + make_interval(mins => ${idle}), absolute_expires_at) WHERE id = ${s.id}`),
      );
    }
    const permissions = await this.effectivePermissions(user);
    const mustRegisterPasskey = (await this.passkeyPolicyApplies(user)) && (await this.activePasskeyCount(user.id)) === 0;
    return {
      csrfHash: s.csrf_hash,
      actor: {
        userId: user.id,
        companyId: user.company_id,
        role: user.role,
        displayName: user.display_name,
        warehouseId: user.role === 'ADMIN' ? null : user.warehouse_id,
        permissions,
        sessionId: s.id,
        stepUpAt: s.step_up_at,
        requestId: client.requestId,
        clientIp: client.ip,
        mustRegisterPasskey,
      },
    };
  }

  /** Constant-time CSRF token check against the session's stored hash. */
  static csrfMatches(csrfHash: Buffer, presented: string | undefined): boolean {
    if (!presented || presented.length > 100) return false;
    return safeEqual(csrfHash, sha256(presented));
  }

  /** Returns the MFA_PENDING session's CSRF hash (needed to protect /auth/mfa/verify). */
  async pendingCsrfHash(token: string): Promise<Buffer | undefined> {
    const s = await this.loadSession(token);
    return s && s.state === 'MFA_PENDING' ? s.csrf_hash : undefined;
  }

  /**
   * Step-up with TOTP. Under the admin passkey policy, administrators who already own a passkey
   * must step up with the passkey instead (phishing resistance for the most sensitive actions).
   */
  async stepUp(actor: Actor, code: string): Promise<void> {
    await this.throttle.assertAllowed([`mfa:${actor.userId}`]);
    const user = await this.userById(actor.userId);
    if (user && (await this.passkeyPolicyApplies(user)) && (await this.activePasskeyCount(user.id)) > 0) {
      throw new PasskeyRequired();
    }
    if (!user || !(await this.consumeTotp(user, code))) {
      await this.throttle.recordFailure(`mfa:${actor.userId}`, 10);
      await this.audit.record({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'auth.step_up',
        outcome: 'FAILURE',
        requestId: actor.requestId,
        clientIp: actor.clientIp,
      });
      throw new Unauthenticated('Código MFA inválido');
    }
    await this.markStepUp(actor, 'totp');
  }

  /** Revokes the session presented by the token (logout). Idempotent. */
  async logout(token: string, client: ClientInfo): Promise<void> {
    const s = await this.loadSession(token, true);
    if (!s) return;
    await this.database.systemTx(async (tx) => {
      await tx.execute(sql`UPDATE sessions SET revoked_at = now(), revoke_reason = 'logout' WHERE id = ${s.id} AND revoked_at IS NULL`);
      await this.audit.recordInTx(tx, {
        companyId: s.company_id,
        actorUserId: s.user_id,
        action: 'auth.logout',
        outcome: 'SUCCESS',
        requestId: client.requestId,
        clientIp: client.ip,
      });
    });
  }

  // ------------------------------------------------------------------ enrolment & resets

  /**
   * Starts enrolment with an INVITATION (sets the password) or MFA_RESET token (requires the
   * current password). Generates a pending TOTP secret (encrypted at rest) and returns it ONCE.
   * The token is not consumed until {@link confirmEnrollment} succeeds.
   */
  async startEnrollment(token: string, password: string, client: ClientInfo): Promise<{ secret: string; otpauthUri: string }> {
    await this.throttle.assertAllowed([`ott:${client.ip}`]);
    const t = await this.findToken(token, ['INVITATION', 'MFA_RESET'], client);
    const user = await this.database.systemTx((tx) => row<UserRow>(tx, sql`SELECT * FROM users WHERE id = ${t.user_id}`));
    if (!user || user.status === 'DISABLED') throw new NotFound('Convite');
    if (t.purpose === 'INVITATION') {
      const reason = screenPassword(password, { email: user.email, displayName: user.display_name });
      if (reason) throw new ValidationFailed([{ path: 'password', message: reason }], reason);
    } else if (!user.password_hash || !(await verifyPassword(user.password_hash, password))) {
      await this.throttle.recordFailure(`ott:${client.ip}`, 10);
      throw new Unauthenticated('Credenciais inválidas');
    }
    const secret = newTotpSecret();
    const enc = await this.crypto.encrypt(
      { companyId: user.company_id, table: 'mfa_totp', recordId: user.id, field: 'totp_secret' },
      secret,
    );
    const pwHash = t.purpose === 'INVITATION' ? await hashPassword(password, this.argon()) : null;
    await this.database.systemTx(async (tx) => {
      if (pwHash) {
        await tx.execute(
          sql`UPDATE users SET password_hash = ${pwHash}, password_changed_at = now(), updated_at = now() WHERE id = ${user.id}`,
        );
      }
      await tx.execute(sql`INSERT INTO mfa_totp (user_id, company_id, secret_enc, confirmed_at, last_used_step)
        VALUES (${user.id}, ${user.company_id}, ${enc}, NULL, 0)
        ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, confirmed_at = NULL, last_used_step = 0, created_at = now()`);
    });
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  }

  /**
   * Confirms the pending TOTP with a valid code, activates the account, consumes the token,
   * replaces recovery codes and revokes all existing sessions. Returns recovery codes ONCE.
   */
  async confirmEnrollment(token: string, code: string, client: ClientInfo): Promise<{ recoveryCodes: string[] }> {
    await this.throttle.assertAllowed([`ott:${client.ip}`]);
    const t = await this.findToken(token, ['INVITATION', 'MFA_RESET'], client);
    const user = await this.database.systemTx((tx) => row<UserRow>(tx, sql`SELECT * FROM users WHERE id = ${t.user_id}`));
    if (!user || !user.password_hash) throw new Conflict('Defina primeiro a palavra-passe', 'ENROLLMENT_NOT_STARTED');
    const pending = await this.database.systemTx((tx) =>
      row<{ secret_enc: string; confirmed_at: Date | null }>(
        tx,
        sql`SELECT secret_enc, confirmed_at FROM mfa_totp WHERE user_id = ${user.id}`,
      ),
    );
    if (!pending || pending.confirmed_at) throw new Conflict('Inscrição MFA não iniciada', 'ENROLLMENT_NOT_STARTED');
    const secret = await this.crypto.decrypt(
      { companyId: user.company_id, table: 'mfa_totp', recordId: user.id, field: 'totp_secret' },
      pending.secret_enc,
    );
    const step = verifyTotp(secret, code, 0n);
    if (step === undefined) {
      await this.throttle.recordFailure(`ott:${client.ip}`, 10);
      throw new Unauthenticated('Código MFA inválido');
    }
    const codes = newRecoveryCodes();
    await this.database.systemTx(async (tx) => {
      const used = await row<{ id: string }>(
        tx,
        sql`UPDATE one_time_tokens SET used_at = now() WHERE id = ${t.id} AND used_at IS NULL RETURNING id`,
      );
      if (!used) throw new NotFound('Convite');
      await tx.execute(sql`UPDATE mfa_totp SET confirmed_at = now(), last_used_step = ${step.toString()} WHERE user_id = ${user.id}`);
      await tx.execute(sql`UPDATE users SET status = 'ACTIVE', mfa_enrolled_at = now(), updated_at = now() WHERE id = ${user.id}`);
      await tx.execute(sql`UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = ${user.id} AND used_at IS NULL`);
      for (const c of codes) {
        await tx.execute(
          sql`INSERT INTO mfa_recovery_codes (user_id, company_id, code_hash) VALUES (${user.id}, ${user.company_id}, ${sha256(c)})`,
        );
      }
      await this.revokeAllSessionsInTx(tx, user.id, 'mfa_enrolled');
      await this.audit.recordInTx(tx, {
        companyId: user.company_id,
        actorUserId: user.id,
        action: t.purpose === 'INVITATION' ? 'auth.enrollment.completed' : 'auth.mfa_reset.completed',
        outcome: 'SUCCESS',
        requestId: client.requestId,
        clientIp: client.ip,
        // A new authenticator is an alerting signal for the account owner/admin.
        details: { alert: t.purpose !== 'INVITATION' },
      });
    });
    return { recoveryCodes: codes };
  }

  /** Completes an administrator-issued password reset. Revokes every session of the user. */
  async resetPassword(token: string, password: string, client: ClientInfo): Promise<void> {
    await this.throttle.assertAllowed([`ott:${client.ip}`]);
    const t = await this.findToken(token, ['PASSWORD_RESET'], client);
    const user = await this.database.systemTx((tx) => row<UserRow>(tx, sql`SELECT * FROM users WHERE id = ${t.user_id}`));
    if (!user || user.status === 'DISABLED') throw new NotFound('Pedido');
    const reason = screenPassword(password, { email: user.email });
    if (reason) throw new ValidationFailed([{ path: 'password', message: reason }], reason);
    const h = await hashPassword(password, this.argon());
    await this.database.systemTx(async (tx) => {
      const used = await row<{ id: string }>(
        tx,
        sql`UPDATE one_time_tokens SET used_at = now() WHERE id = ${t.id} AND used_at IS NULL RETURNING id`,
      );
      if (!used) throw new NotFound('Pedido');
      await tx.execute(sql`UPDATE users SET password_hash = ${h}, password_changed_at = now(), updated_at = now() WHERE id = ${user.id}`);
      await this.revokeAllSessionsInTx(tx, user.id, 'password_reset');
      await this.audit.recordInTx(tx, {
        companyId: user.company_id,
        actorUserId: user.id,
        action: 'auth.password_reset.completed',
        outcome: 'SUCCESS',
        requestId: client.requestId,
        clientIp: client.ip,
      });
    });
  }

  /**
   * Issues a one-time token (raw value returned ONCE to the administrator, hash stored).
   * @param ttlMinutes lifetime; invitations 72 h, MFA reset 24 h, password reset 60 min.
   */
  async issueToken(
    tx: Tx,
    userId: string,
    companyId: string,
    purpose: 'INVITATION' | 'MFA_RESET' | 'PASSWORD_RESET',
    createdBy: string | null,
  ): Promise<string> {
    const ttl = purpose === 'INVITATION' ? 72 * 60 : purpose === 'MFA_RESET' ? 24 * 60 : 60;
    const raw = randomToken();
    // Only one live token per purpose: older unused tokens are invalidated.
    await tx.execute(
      sql`UPDATE one_time_tokens SET used_at = now() WHERE user_id = ${userId} AND purpose = ${purpose} AND used_at IS NULL`,
    );
    await tx.execute(sql`INSERT INTO one_time_tokens (user_id, company_id, purpose, token_hash, expires_at, created_by)
      VALUES (${userId}, ${companyId}, ${purpose}, ${sha256(raw)}, now() + make_interval(mins => ${ttl}), ${createdBy})`);
    return raw;
  }

  /** Revokes all live sessions of a user inside the caller's transaction. */
  async revokeAllSessionsInTx(tx: Tx, userId: string, reason: string): Promise<void> {
    await tx.execute(
      sql`UPDATE sessions SET revoked_at = now(), revoke_reason = ${reason} WHERE user_id = ${userId} AND revoked_at IS NULL`,
    );
  }

  // ------------------------------------------------------------------ internals

  /**
   * CSRF synchronizer token derived from the session id with a server secret (HMAC-SHA256), so
   * it can be re-issued by GET /auth/session after a page reload without storing it anywhere in
   * the browser. Only its SHA-256 is persisted (csrf_hash) for constant-time verification.
   */
  csrfFor(sessionId: string): string {
    return createHmac('sha256', Buffer.from(this.cfg.CSRF_SECRET, 'base64')).update(`csrf:${sessionId}`).digest('base64url');
  }

  private async createSession(tx: Tx, user: UserRow, state: 'MFA_PENDING' | 'ACTIVE', client: ClientInfo): Promise<IssuedSession> {
    const token = randomToken();
    const sessionId = randomUUID();
    const csrfToken = this.csrfFor(sessionId);
    const idleMin = state === 'MFA_PENDING' ? MFA_PENDING_MINUTES : this.cfg.SESSION_IDLE_MINUTES;
    const absMin = state === 'MFA_PENDING' ? MFA_PENDING_MINUTES : this.cfg.SESSION_ABSOLUTE_HOURS * 60;
    await tx.execute(sql`INSERT INTO sessions (id, user_id, company_id, token_hash, csrf_hash, state, idle_expires_at,
        absolute_expires_at, mfa_verified_at, client_ip, user_agent)
      VALUES (${sessionId}, ${user.id}, ${user.company_id}, ${sha256(token)}, ${sha256(csrfToken)}, ${state},
        now() + make_interval(mins => ${idleMin}), now() + make_interval(mins => ${absMin}),
        ${state === 'ACTIVE' ? sql`now()` : null}, ${client.ip}, ${client.userAgent.slice(0, 300)})`);
    return { token, csrfToken };
  }

  private async loadSession(token: string, includeExpired = false): Promise<SessionRow | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const raw = await this.database.systemTx((tx) => row<SessionRow>(tx, sql`SELECT * FROM sessions WHERE token_hash = ${sha256(token)}`));
    if (!raw) return undefined;
    const s: SessionRow = {
      ...raw,
      idle_expires_at: asDate(raw.idle_expires_at)!,
      absolute_expires_at: asDate(raw.absolute_expires_at)!,
      last_seen_at: asDate(raw.last_seen_at)!,
      step_up_at: asDate(raw.step_up_at),
      revoked_at: asDate(raw.revoked_at),
    };
    if (includeExpired) return s.revoked_at ? undefined : s;
    const now = Date.now();
    if (s.revoked_at || s.idle_expires_at.getTime() < now || s.absolute_expires_at.getTime() < now) return undefined;
    return s;
  }

  private async findToken(raw: string, purposes: string[], client: ClientInfo) {
    const t = await this.database.systemTx((tx) =>
      row<{ id: string; user_id: string; company_id: string; purpose: string; expires_at: Date; used_at: Date | null }>(
        tx,
        sql`SELECT * FROM one_time_tokens WHERE token_hash = ${sha256(raw)}`,
      ),
    );
    if (!t || t.used_at || asDate(t.expires_at)!.getTime() < Date.now() || !purposes.includes(t.purpose)) {
      await this.throttle.recordFailure(`ott:${client.ip}`, 10);
      throw new NotFound('Convite ou pedido');
    }
    return t;
  }

  /** Verifies a TOTP code and atomically advances last_used_step (replay protection). */
  private async consumeTotp(user: UserRow, code: string): Promise<boolean> {
    const rec = await this.database.systemTx((tx) =>
      row<{ secret_enc: string; last_used_step: string; confirmed_at: Date | null }>(
        tx,
        sql`SELECT secret_enc, last_used_step, confirmed_at FROM mfa_totp WHERE user_id = ${user.id}`,
      ),
    );
    if (!rec?.confirmed_at) return false;
    const secret = await this.crypto.decrypt(
      { companyId: user.company_id, table: 'mfa_totp', recordId: user.id, field: 'totp_secret' },
      rec.secret_enc,
    );
    const step = verifyTotp(secret, code, BigInt(rec.last_used_step));
    if (step === undefined) return false;
    // Conditional update: a concurrent request presenting the same code loses the race.
    const updated = await this.database.systemTx((tx) =>
      row<{ user_id: string }>(
        tx,
        sql`UPDATE mfa_totp SET last_used_step = ${step.toString()} WHERE user_id = ${user.id} AND last_used_step < ${step.toString()} RETURNING user_id`,
      ),
    );
    return !!updated;
  }

  private async consumeRecoveryCode(user: UserRow, code: string): Promise<boolean> {
    const r = await this.database.systemTx((tx) =>
      row<{ id: string }>(
        tx,
        sql`UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = ${user.id} AND code_hash = ${sha256(code)} AND used_at IS NULL RETURNING id`,
      ),
    );
    return !!r;
  }

  private async effectivePermissions(user: UserRow): Promise<ReadonlySet<Permission>> {
    if (user.role === 'ADMIN') return new Set(PERMISSIONS);
    const granted = await this.database.systemTx((tx) =>
      rows<{ permission: string }>(tx, sql`SELECT permission FROM user_permissions WHERE user_id = ${user.id}`),
    );
    // Defence in depth: admin-only permissions are ignored for staff even if present in DB.
    return new Set(
      granted
        .map((g) => g.permission as Permission)
        .filter((p) => (PERMISSIONS as readonly string[]).includes(p) && !ADMIN_ONLY_PERMISSIONS.includes(p)),
    );
  }
}
