/**
 * @file Authentication endpoints (/api/auth/*).
 * @module platform/http
 *
 * Cookie: opaque token, HttpOnly + Secure + SameSite=Strict. The CSRF token is returned in
 * JSON bodies (never in a cookie or URL) and kept by the SPA in memory only.
 */
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  AcceptInvitationInput,
  ConfirmEnrollmentInput,
  LoginInput,
  MfaVerifyInput,
  ResetPasswordInput,
  StepUpInput,
} from '@autolemon/contracts';
import { Forbidden, Unauthenticated } from '../common/errors.js';
import { SERVICES, type Services } from '../composition.js';
import { AuthService } from '../platform/auth/auth.service.js';
import { actorOf, type AppRequest, clearSessionCookie, clientInfo, parse, Public, sessionToken, setSessionCookie } from './http-util.js';

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
    const token = sessionToken(req, this.s.cfg);
    if (!token) throw new Unauthenticated();
    const csrfHash = await this.s.auth.pendingCsrfHash(token);
    if (!csrfHash) throw new Unauthenticated();
    const presented = req.headers['x-csrf-token'];
    if (!AuthService.csrfMatches(csrfHash, Array.isArray(presented) ? presented[0] : presented)) {
      throw new Forbidden('csrf_token_invalid', 'Pedido rejeitado (proteção CSRF)');
    }
    const issued = await this.s.auth.verifyMfa(token, input, clientInfo(req));
    setSessionCookie(reply, this.s.cfg, issued.token);
    return { authenticated: true, csrfToken: issued.csrfToken };
  }

  /** Current session: user profile, permissions, warehouses and a CSRF token for this session. */
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
    };
  }

  /** Step-up verification for high-risk actions. */
  @Post('step-up')
  @HttpCode(200)
  async stepUp(@Req() req: AppRequest, @Body() body: unknown) {
    const input = parse(StepUpInput, body);
    await this.s.auth.stepUp(actorOf(req), input.code);
    return { stepUp: true, validMinutes: this.s.cfg.STEP_UP_MINUTES };
  }

  /** Logout: revokes the server session and clears the cookie. */
  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: AppRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const token = sessionToken(req, this.s.cfg);
    if (token) await this.s.auth.logout(token, clientInfo(req));
    clearSessionCookie(reply, this.s.cfg);
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
}
