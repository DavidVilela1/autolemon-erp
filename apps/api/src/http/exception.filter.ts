/**
 * @file Global exception filter: consistent JSON errors, no stack traces or internals to
 * clients, structured server-side logging, and auditing of authorization denials.
 * @module platform/http
 */
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { DomainError, Forbidden, NotFound, RateLimited, StepUpRequired, translatePgError } from '../common/errors.js';
import { SERVICES, type Services } from '../composition.js';
import { pgCause } from '../db/database.js';
import { DecryptionError } from '../platform/crypto/field-crypto.js';
import type { AppRequest } from './http-util.js';

/** Maps every thrown value to a safe HTTP response. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<AppRequest>();
    const reply = ctx.getResponse<FastifyReply>();
    const requestId = String(req.id);

    let err: DomainError | undefined = exception instanceof DomainError ? exception : translatePgError(pgCause(exception));
    if (!err && exception instanceof DecryptionError) {
      // Fail closed: tampered/unauthorised ciphertext never yields plaintext.
      err = new DomainError(500, 'DECRYPTION_FAILED', 'Não foi possível validar dados protegidos');
    }
    if (!err && exception instanceof HttpException) {
      const status = exception.getStatus();
      err = new DomainError(
        status,
        status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR',
        status === 404 ? 'Recurso não encontrado' : 'Pedido inválido',
      );
    }
    if (!err) {
      req.log.error({ err: exception, requestId }, 'unhandled error');
      err = new DomainError(500, 'INTERNAL', 'Erro interno. Indique o código do pedido ao suporte.');
    }

    // Authorization failures and scope violations are security-relevant: audit them.
    const auditReason = err instanceof Forbidden ? err.reason : err instanceof NotFound && err.auditReason ? err.auditReason : undefined;
    if (auditReason) {
      await this.s.audit
        .record({
          companyId: req.actor?.companyId ?? null,
          actorUserId: req.actor?.userId ?? null,
          action: 'authz.denied',
          resourceType: 'route',
          resourceId: `${req.method} ${req.routeOptions?.url ?? ''}`.slice(0, 80),
          outcome: 'DENIED',
          requestId,
          clientIp: req.ip,
          details: { reason: auditReason.slice(0, 100) },
        })
        .catch((e: unknown) => req.log.error({ err: e }, 'audit write failed'));
    }
    req.errorCode = err.code; // read by the security-signal hook in hardening.ts (ADR-0029)
    if (err instanceof RateLimited) void reply.header('Retry-After', String(err.retryAfterSeconds));
    const body: Record<string, unknown> = { error: { code: err.code, message: err.message }, requestId };
    if (err.details !== undefined) (body.error as Record<string, unknown>).details = err.details;
    if (err instanceof StepUpRequired) (body.error as Record<string, unknown>).action = err.action;
    // Errors are always JSON, even on routes that normally return CSV.
    reply.removeHeader('Content-Disposition');
    void reply.status(err.status).header('Content-Type', 'application/json; charset=utf-8').send(body);
  }
}
