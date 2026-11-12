/**
 * @file Authentication endpoints (/api/auth/*).
 * @module platform/http
 *
 * Cookie: opaque token, HttpOnly + Secure + SameSite=Strict. The CSRF token is returned in
 * JSON bodies (never in a cookie or URL) and kept by the SPA in memory only.
 */
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  AcceptInvitationInput,
  ChangePasswordInput,
  ConfirmEnrollmentInput,
  LoginInput,
  MfaVerifyInput,
  PasskeyAssertInput,
  PasskeyRegisterInput,
  ResetPasswordInput,
  StepUpInput,
} from '@autolemon/contracts';
import { Forbidden, Unauthenticated } from '../common/errors.js';
import { SERVICES, type Services } from '../composition.js';
import { AuthService } from '../platform/auth/auth.service.js';
import {
  AccountSecurity,
  actorOf,
  type AppRequest,
  clearSessionCookie,
  clientInfo,
  parse,
  Public,
  sessionToken,
  setSessionCookie,
  uuidParam,
} from './http-util.js';
import type { SessionRow } from '../platform/auth/auth.service.js';

/** Authentication routes. */
@Controller('api/auth')
export class AuthController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  /** Step 1: password. Returns a pending-MFA CSRF token; sets the pending session cookie. */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Req() req: AppRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() body: unknown) {
    const input = parse(LoginInput, body);
    const issued = await this.s.auth.login(input.email, input.password, clientInfo(req));
    setSessionCookie(reply, this.s.cfg, issued.token);
    return { mfaRequired: true, csrfToken: issued.csrfToken };
  }

  /** Step 2: TOTP or recovery code. Rotates the session and returns the new CSRF token. */
  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  async verify(@Req() req: AppRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() body: unknown) {
    const input = parse(MfaVerifyInput, body);
    const token = await this.pendingToken(req);
    const issued = await this.s.auth.verifyMfa(token, input, clientInfo(req));
    setSessionCookie(reply, this.s.cfg, issued.token);
    return { authenticated: true, csrfToken: issued.csrfToken };
  }

  /** Step 2 (passkey): WebAuthn authentication options for the pending session. */
  @Public()
  @Post('mfa/passkey/options')
  @HttpCode(200)
  async passkeyLoginOptions(@Req() req: AppRequest) {
    const session = await this.pendingSession(req);
    return this.s.passkeys.loginOptions(session);
  }

  /** Step 2 (passkey): verify the assertion, rotate the session. */
  @Public()
  @Post('mfa/passkey/verify')
  @HttpCode(200)
  async passkeyLogin(@Req() req: AppRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body() body: unknown) {
    const input = parse(PasskeyAssertInput, body);
    const session = await this.pendingSession(req);
    const issued = await this.s.passkeys.login(session, input.response, clientInfo(req));
    setSessionCookie(reply, this.s.cfg, issued.token);
    return { authenticated: true, csrfToken: issued.csrfToken };
  }

  /** Current session: user profile, permissions, warehouses and a CSRF token for this session. */
  @AccountSecurity()
  @Get('session')
  async session(@Req() req: AppRequest) {
    const actor = actorOf(req);
    const warehouses = await this.s.admin.warehouses(actor);
    return {
      user: {
        id: actor.userId,
        displayName: actor.displayName,
        role: actor.role,
        warehouseId: actor.warehouseId,
        permissions: [...actor.permissions].sort(),
      },
      warehouses,
      csrfToken: this.s.auth.csrfFor(actor.sessionId),
      stepUpValidUntil: actor.stepUpAt ? new Date(actor.stepUpAt.getTime() + this.s.cfg.STEP_UP_MINUTES * 60_000).toISOString() : null,
      security: {
        passkeys: await this.s.auth.activePasskeyCount(actor.userId),
        mustRegisterPasskey: !!actor.mustRegisterPasskey,
        adminPasskeyPolicy: this.s.cfg.ADMIN_PASSKEY_REQUIRED,
      },
    };
  }

  /** Step-up verification for high-risk actions. */
  @AccountSecurity()
  @Post('step-up')
  @HttpCode(200)
  async stepUp(@Req() req: AppRequest, @Body() body: unknown) {
    const input = parse(StepUpInput, body);
    await this.s.auth.stepUp(actorOf(req), input.code);
    return { stepUp: true, validMinutes: this.s.cfg.STEP_UP_MINUTES };
  }

  /** Step-up with a passkey: options. */
  @AccountSecurity()
  @Post('step-up/passkey/options')
  @HttpCode(200)
  stepUpPasskeyOptions(@Req() req: AppRequest) {
    return this.s.passkeys.stepUpOptions(actorOf(req));
  }

  /** Step-up with a passkey: verify. */
  @AccountSecurity()
  @Post('step-up/passkey')
  @HttpCode(200)
  async stepUpPasskey(@Req() req: AppRequest, @Body() body: unknown) {
    await this.s.passkeys.stepUp(actorOf(req), parse(PasskeyAssertInput, body).response);
    return { stepUp: true, validMinutes: this.s.cfg.STEP_UP_MINUTES };
  }

  /** Own passkeys. */
  @AccountSecurity()
  @Get('passkeys')
  passkeys(@Req() req: AppRequest) {
    return this.s.passkeys.list(actorOf(req));
  }

  /** Passkey registration options (step-up required). */
  @AccountSecurity()
  @Post('passkeys/register/options')
  @HttpCode(200)
  passkeyRegisterOptions(@Req() req: AppRequest) {
    return this.s.passkeys.registrationOptions(actorOf(req));
  }

  /** Register a passkey (step-up required). */
  @AccountSecurity()
  @Post('passkeys/register')
  passkeyRegister(@Req() req: AppRequest, @Body() body: unknown) {
    const input = parse(PasskeyRegisterInput, body);
    return this.s.passkeys.register(actorOf(req), input.response, input.name);
  }

  /** Revoke one of my passkeys (step-up required). */
  @AccountSecurity()
  @Post('passkeys/:id/revoke')
  @HttpCode(200)
  passkeyRevoke(@Req() req: AppRequest, @Param('id') id: string) {
    return this.s.passkeys.revoke(actorOf(req), uuidParam(id));
  }

  /** Change my password (current password required; other sessions revoked). */
  @AccountSecurity()
  @Post('password/change')
  @HttpCode(200)
  changePassword(@Req() req: AppRequest, @Body() body: unknown) {
    const input = parse(ChangePasswordInput, body);
    return this.s.account.changePassword(actorOf(req), input.currentPassword, input.newPassword);
  }

  /** My active sessions. */
  @AccountSecurity()
  @Get('sessions')
  sessions(@Req() req: AppRequest) {
    return this.s.account.sessions(actorOf(req));
  }

  /** Revoke one of my sessions. */
  @AccountSecurity()
  @Post('sessions/:id/revoke')
  @HttpCode(200)
  revokeSession(@Req() req: AppRequest, @Param('id') id: string) {
    return this.s.account.revokeSession(actorOf(req), uuidParam(id));
  }

  /** Sign out all my other sessions. */
  @AccountSecurity()
  @Post('sessions/revoke-others')
  @HttpCode(200)
  revokeOthers(@Req() req: AppRequest) {
    return this.s.account.revokeOtherSessions(actorOf(req));
  }

  /** Regenerate my recovery codes (step-up required; shown once). */
  @AccountSecurity()
  @Post('recovery-codes/regenerate')
  @HttpCode(200)
  regenerateRecovery(@Req() req: AppRequest) {
    return this.s.account.regenerateRecoveryCodes(actorOf(req));
  }

  /** Logout: revokes the server session and clears the cookie. */
  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: AppRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const token = sessionToken(req, this.s.cfg);
    if (token) await this.s.auth.logout(token, clientInfo(req));
    clearSessionCookie(reply, this.s.cfg);
    // ASVS 5.0 V14.3.1: ask the browser to drop cached responses and any client storage of
    // this origin as well (the SPA also resets its in-memory state).
    void reply.header('Clear-Site-Data', '"cache", "storage"');
    return { loggedOut: true };
  }

  /** Invitation / MFA-reset step 1: password + new TOTP secret (shown once). */
  @Public()
  @Post('enrollment/start')
  @HttpCode(200)
  async enrollmentStart(@Req() req: AppRequest, @Body() body: unknown) {
    const input = parse(AcceptInvitationInput, body);
    return this.s.auth.startEnrollment(input.token, input.password, clientInfo(req));
  }

  /** Invitation / MFA-reset step 2: confirm TOTP; returns recovery codes once. */
  @Public()
  @Post('enrollment/confirm')
  @HttpCode(200)
  async enrollmentConfirm(@Req() req: AppRequest, @Body() body: unknown) {
    const input = parse(ConfirmEnrollmentInput, body);
    return this.s.auth.confirmEnrollment(input.token, input.code, clientInfo(req));
  }

  /** Completes an administrator-issued password reset. */
  @Public()
  @Post('password/reset')
  @HttpCode(200)
  async passwordReset(@Req() req: AppRequest, @Body() body: unknown) {
    const input = parse(ResetPasswordInput, body);
    await this.s.auth.resetPassword(input.token, input.password, clientInfo(req));
    return { reset: true };
  }

  /** Returns the raw token of a MFA_PENDING session after verifying its CSRF token. */
  private async pendingToken(req: AppRequest): Promise<string> {
    const token = sessionToken(req, this.s.cfg);
    if (!token) throw new Unauthenticated();
    const csrfHash = await this.s.auth.pendingCsrfHash(token);
    if (!csrfHash) throw new Unauthenticated();
    const presented = req.headers['x-csrf-token'];
    if (!AuthService.csrfMatches(csrfHash, Array.isArray(presented) ? presented[0] : presented)) {
      throw new Forbidden('csrf_token_invalid', 'Pedido rejeitado (proteção CSRF)');
    }
    return token;
  }

  /** Loads the MFA_PENDING session (CSRF-checked). */
  private async pendingSession(req: AppRequest): Promise<SessionRow> {
    const session = await this.s.auth.sessionByToken(await this.pendingToken(req));
    if (!session || session.state !== 'MFA_PENDING') throw new Unauthenticated();
    return session;
  }
}
