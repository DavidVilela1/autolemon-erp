/**
 * @file HTTP helpers shared by controllers: strict parsing, actor access, idempotency keys,
 * session cookie handling.
 * @module platform/http
 */
import { SetMetadata } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { IdempotencyKey, Uuid } from '@autolemon/contracts';
import type { AppConfig } from '../config/env.js';
import { Unauthenticated, ValidationFailed } from '../common/errors.js';
import type { Actor } from '../platform/authz/actor.js';
import type { ClientInfo } from '../platform/auth/auth.service.js';

/** Metadata key marking routes that do not require an ACTIVE session. */
export const PUBLIC_ROUTE = 'autolemon:public';
/** Marks a controller method as public (login, enrolment, health). */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

/** Metadata key marking account-security routes usable before a mandatory passkey exists. */
export const ACCOUNT_SECURITY_ROUTE = 'autolemon:account-security';
/** Marks a route as reachable while the admin passkey policy blocks everything else. */
export const AccountSecurity = () => SetMetadata(ACCOUNT_SECURITY_ROUTE, true);

/** Fastify request augmented with the authenticated actor. */
/**
 * Fastify request with the resolved actor and, after an error, its domain error code (used by the
 * security-signal hook, ADR-0029).
 */
export type AppRequest = FastifyRequest & { actor?: Actor; errorCode?: string };

/**
 * Validates untrusted input with a Zod schema. Issues are reported by path and message only;
 * submitted values are never echoed back (avoids reflecting attacker content).
 */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw new ValidationFailed(r.error.issues.slice(0, 50).map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

/** Validates a UUID route parameter. */
export function uuidParam(value: unknown): string {
  return parse(Uuid, value);
}

/** Returns the authenticated actor (set by AuthGuard) or throws. */
export function actorOf(req: AppRequest): Actor {
  if (!req.actor) throw new Unauthenticated();
  return req.actor;
}

/** Reads and validates the mandatory Idempotency-Key header of WMS commands. */
export function idemKey(req: FastifyRequest): string {
  const raw = req.headers['idempotency-key'];
  return parse(IdempotencyKey, Array.isArray(raw) ? raw[0] : raw);
}

/** Request metadata for auditing (IP derived per TRUST_PROXY configuration). */
export function clientInfo(req: FastifyRequest): ClientInfo {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: typeof ua === 'string' ? ua.slice(0, 300) : '', requestId: String(req.id) };
}

/** Session cookie name: __Host- prefix when Secure (binds cookie to host, path=/). */
export function cookieName(cfg: AppConfig): string {
  return cfg.COOKIE_SECURE ? '__Host-al_sid' : 'al_sid';
}

/** Sets the session cookie (HttpOnly, Secure, SameSite=Strict, Path=/, session-scoped). */
export function setSessionCookie(reply: FastifyReply, cfg: AppConfig, token: string): void {
  reply.setCookie(cookieName(cfg), token, {
    httpOnly: true,
    secure: cfg.COOKIE_SECURE,
    sameSite: 'strict',
    path: '/',
  });
}

/** Clears the session cookie. */
export function clearSessionCookie(reply: FastifyReply, cfg: AppConfig): void {
  reply.clearCookie(cookieName(cfg), { path: '/', httpOnly: true, secure: cfg.COOKIE_SECURE, sameSite: 'strict' });
}

/** Reads the session token from the cookie, or undefined. */
export function sessionToken(req: FastifyRequest, cfg: AppConfig): string | undefined {
  const v = req.cookies?.[cookieName(cfg)];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
