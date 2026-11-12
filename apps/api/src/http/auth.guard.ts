/**
 * @file Global authentication + CSRF guard (applies to every route; opt-out via @Public()).
 * @module platform/http
 *
 * For every state-changing request (POST/PUT/PATCH/DELETE), including public ones:
 *  - the Origin header, when present, must equal WEB_ORIGIN; cross-site Fetch Metadata
 *    (Sec-Fetch-Site: cross-site) is rejected;
 *  - the custom header `X-Requested-With: autolemon` must be present (forces a CORS preflight
 *    that this API never approves, blocking simple cross-site form posts).
 * For protected routes additionally:
 *  - a valid ACTIVE session cookie is resolved to an Actor (idle/absolute expiry, revocation);
 *  - writes must carry the session's CSRF token in `X-CSRF-Token` (synchronizer token).
 * Coarse, route-level authorization runs here too, BEFORE any body parsing (so an
 * unauthorized caller learns nothing, not even validation errors):
 *  - /api/admin/** requires the ADMIN role (admin-only permissions cannot be granted to staff);
 *  - routes with a `:wh` parameter refuse staff scoped to another warehouse (404, as the
 *    services do). Fine-grained authorization (permissions, object ownership, company
 *    membership of the warehouse) remains in the services.
 */
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError, Forbidden, NotFound, Unauthenticated } from '../common/errors.js';
import { SERVICES, type Services } from '../composition.js';
import { AuthService } from '../platform/auth/auth.service.js';
import { ACCOUNT_SECURITY_ROUTE, type AppRequest, clientInfo, PUBLIC_ROUTE, sessionToken } from './http-util.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Global guard. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SERVICES) private readonly s: Services,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()]);
    const mutating = !SAFE_METHODS.has(req.method);
    // Fetch Metadata resource isolation for EVERY API request, reads included (ASVS 5.0
    // V3.5.3 alternative): a browser request started by another site is refused before any
    // handler runs, so cross-site GETs (e.g. a CSV export URL in an <img>/<a>) never execute.
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new Forbidden('cross_site_fetch', 'Pedido entre sites não permitido');
    if (mutating) this.checkRequestOrigin(req);
    if (isPublic) return true;

    const token = sessionToken(req, this.s.cfg);
    if (!token) throw new Unauthenticated();
    const { actor, csrfHash } = await this.s.auth.authenticate(token, clientInfo(req));
    if (mutating) {
      const presented = req.headers['x-csrf-token'];
      if (!AuthService.csrfMatches(csrfHash, Array.isArray(presented) ? presented[0] : presented)) {
        // Attach actor so the exception filter can attribute the denied attempt.
        req.actor = actor;
        throw new Forbidden('csrf_token_invalid', 'Pedido rejeitado (proteção CSRF)');
      }
    }
    req.actor = actor;
    // Admin passkey policy: an administrator without a passkey may only reach account-security
    // routes (to register one); everything else is refused until then.
    if (actor.mustRegisterPasskey) {
      const allowed = this.reflector.getAllAndOverride<boolean>(ACCOUNT_SECURITY_ROUTE, [context.getHandler(), context.getClass()]);
      if (!allowed) {
        throw new DomainError(403, 'PASSKEY_REGISTRATION_REQUIRED', 'Registe uma chave de acesso (passkey) para continuar');
      }
    }
    const path = (req.url ?? '').split('?')[0]!;
    if (path.startsWith('/api/admin/') && actor.role !== 'ADMIN') throw new Forbidden('admin_route');
    const wh = (req.params as Record<string, string> | undefined)?.wh;
    if (wh !== undefined && actor.role !== 'ADMIN' && wh !== actor.warehouseId) throw new NotFound('Armazém', 'warehouse_scope');
    return true;
  }

  /** Origin / Fetch-Metadata / custom-header checks for state-changing requests. */
  private checkRequestOrigin(req: AppRequest): void {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== this.s.cfg.WEB_ORIGIN) throw new Forbidden('origin_mismatch', 'Origem do pedido não permitida');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new Forbidden('cross_site_fetch', 'Pedido entre sites não permitido');
    if (req.headers['x-requested-with'] !== 'autolemon') throw new Forbidden('missing_custom_header', 'Cabeçalho obrigatório em falta');
  }
}
