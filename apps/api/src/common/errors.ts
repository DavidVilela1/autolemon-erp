/**
 * @file Domain error hierarchy and PostgreSQL error translation.
 * @module platform/common
 *
 * Errors carry a stable machine `code` and a Portuguese user message. Internal details
 * (SQL, stack traces, constraint names, other tenants' identifiers) are never sent to clients.
 */

/** Base class for all expected (non-bug) failures. */
export class DomainError extends Error {
  /**
   * @param status HTTP status to return.
   * @param code Stable machine-readable code (UPPER_SNAKE).
   * @param message Safe, user-facing message (pt-PT).
   * @param details Optional safe details (e.g. validation issues), never secrets.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 400 — input failed validation. */
export class ValidationFailed extends DomainError {
  constructor(details: unknown, message = 'Dados inválidos') {
    super(400, 'VALIDATION_FAILED', message, details);
  }
}
/** 401 — no valid session. */
export class Unauthenticated extends DomainError {
  constructor(message = 'Sessão inválida ou expirada') {
    super(401, 'UNAUTHENTICATED', message);
  }
}
/** 403 — authenticated but not allowed. Audited as DENIED by the exception filter. */
export class Forbidden extends DomainError {
  constructor(
    readonly reason: string,
    message = 'Operação não autorizada',
  ) {
    super(403, 'FORBIDDEN', message);
  }
}
/** 403 — a recent step-up MFA verification is required. */
export class StepUpRequired extends DomainError {
  constructor(readonly action: string) {
    super(403, 'STEP_UP_REQUIRED', 'Confirme a sua identidade com um código MFA para continuar');
  }
}
/**
 * 404 — resource does not exist OR is outside the caller's tenant/warehouse scope. Both
 * cases deliberately look identical to prevent enumeration (IDOR/BOLA defence).
 */
export class NotFound extends DomainError {
  /**
   * @param what Resource label for the message.
   * @param auditReason When set, the denial is written to the security audit log as DENIED
   *   (used for scope violations such as cross-warehouse access attempts).
   */
  constructor(
    what = 'Recurso',
    readonly auditReason?: string,
  ) {
    super(404, 'NOT_FOUND', `${what} não encontrado`);
  }
}
/** 409 — state conflict (wrong document status, duplicate, stale count, etc.). */
export class Conflict extends DomainError {
  constructor(message: string, code = 'CONFLICT', details?: unknown) {
    super(409, code, message, details);
  }
}
/** 409 — not enough free stock for the requested operation. */
export class InsufficientStock extends DomainError {
  constructor(message = 'Stock disponível insuficiente') {
    super(409, 'INSUFFICIENT_STOCK', message);
  }
}
/** 429 — throttled. */
export class RateLimited extends DomainError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, 'RATE_LIMITED', 'Demasiadas tentativas. Tente novamente mais tarde.');
  }
}

/** Shape of errors thrown by node-postgres. */
interface PgError {
  code?: string;
  constraint?: string;
}

/**
 * Translates PostgreSQL errors into safe domain errors.
 * - 23505 unique violation → 409 (duplicate code/number).
 * - 23514 check violation / custom trigger errors → 409 business rule violation.
 * - 23503 FK violation → 404: a reference to a row that does not exist *for this tenant*
 *   (composite FKs make cross-tenant references fail here) must look like "not found".
 * - 42501 insufficient privilege (RLS WITH CHECK, append-only triggers) → 404/403.
 * Returns undefined for anything else (treated as an internal error).
 */
export function translatePgError(err: unknown): DomainError | undefined {
  const e = err as PgError;
  switch (e?.code) {
    case '23505':
      return new Conflict('Já existe um registo com este código ou número', 'DUPLICATE');
    case '23514':
      return new Conflict('A operação viola uma regra de integridade do armazém', 'RULE_VIOLATION');
    case '23503':
      return new NotFound('Referência');
    case '42501':
      return new NotFound('Recurso');
    case '22P02':
      return new ValidationFailed(undefined, 'Formato de identificador inválido');
    default:
      return undefined;
  }
}
