/**
 * @file Fastify-level hardening: security headers, no-store caching, per-IP rate limit,
 * request ids, restricted content types and log redaction settings.
 * @module platform/http
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/env.js';

/** Paths redacted from structured logs (never log secrets, cookies or tokens). */
export const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  'body.password',
  'body.token',
  'body.code',
  'body.recoveryCode',
];

/** Fastify logger options with redaction and minimal request serialisation. */
export function loggerOptions(cfg: AppConfig) {
  return {
    level: cfg.LOG_LEVEL,
    redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
    serializers: {
      // Only method, route path (no query string: may contain search terms) and id.
      req: (req: { method: string; url: string; id: string }) => ({ method: req.method, path: req.url.split('?')[0], id: req.id }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  };
}

/** Request id generator: server-generated UUID (client-supplied ids are ignored). */
export const genReqId = () => randomUUID();

/** Response statuses recorded as control-bypass signals. */
export const SIGNAL_STATUSES: ReadonlySet<number> = new Set([400, 413, 415, 429]);

/** Installs hooks on the Fastify instance. */
export function installHardening(
  app: FastifyInstance,
  cfg: AppConfig,
  onSecuritySignal: (req: FastifyRequest, statusCode: number) => Promise<void> = async () => undefined,
): void {
  // Simple fixed-window per-IP limiter for the whole API (auth endpoints also have DB throttles).
  const windowMs = 60_000;
  const limit = cfg.NODE_ENV === 'test' ? 100_000 : 600;
  const hits = new Map<string, { count: number; reset: number }>();
  app.addHook('onRequest', async (req, reply) => {
    const now = Date.now();
    const h = hits.get(req.ip);
    if (!h || h.reset < now) hits.set(req.ip, { count: 1, reset: now + windowMs });
    else if (++h.count > limit) {
      return reply
        .status(429)
        .header('Retry-After', String(Math.ceil((h.reset - now) / 1000)))
        .send({ error: { code: 'RATE_LIMITED', message: 'Demasiados pedidos' }, requestId: req.id });
    }
    if (hits.size > 50_000) hits.clear(); // bound memory under address-spoofing floods
    return undefined;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    // Control-bypass signals (ASVS 5.0 V16.3.3, ADR-0029): every 400/413/415/429 — whether it
    // came from validation, the JSON/content-type parsers, the auth throttle or the limiter above —
    // passes here before it is sent. The recorder is itself rate-limited; a failing audit write
    // must never change the response.
    if (SIGNAL_STATUSES.has(reply.statusCode)) {
      await onSecuritySignal(req, reply.statusCode).catch((e: unknown) => req.log.error({ err: e }, 'security signal write failed'));
    }
    reply.header('X-Request-Id', String(req.id));
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // API responses are data, never documents: forbid any active content.
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (cfg.NODE_ENV === 'production') reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    reply.removeHeader('X-Powered-By');
    return payload;
  });

  // Only JSON (default) and text/csv (SKU import) bodies are accepted; others get 415.
  app.addContentTypeParser('text/csv', { parseAs: 'string', bodyLimit: 1_000_000 }, (_req, body, done) => done(null, body));
}
