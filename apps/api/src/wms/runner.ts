/**
 * @file Uniform execution of WMS reads and idempotent commands with authorization.
 * @module wms
 *
 * Every WMS service method runs through {@link WmsRunner} so the same sequence is applied
 * without exception:
 *   1. action-level permission check (default deny),
 *   2. object-level warehouse scope check (staff: own warehouse only; admin: own company),
 *   3. transaction with transaction-local RLS context pinned to that warehouse,
 *   4. (commands) idempotency: the key + request hash are recorded in command_log inside the
 *      same transaction, so a duplicate or retried command returns the first result instead
 *      of moving stock twice; reusing a key with a different payload is rejected (409).
 */
import { sql } from 'drizzle-orm';
import type { Permission } from '@autolemon/contracts';
import type { Database } from '../db/database.js';
import { row } from '../db/database.js';
import { Conflict } from '../common/errors.js';
import { canonicalJson, safeEqual, sha256 } from '../common/crypto-util.js';
import { type Actor, requirePermission, warehouseScope } from '../platform/authz/actor.js';
import type { OpCtx } from './inventory/engine.js';

/** Result wrapper for commands (replayed=true when served from the idempotency log). */
export type CommandResult<T> = T & { replayed?: boolean };

/** Executes WMS operations with the authorization/idempotency envelope. */
export class WmsRunner {
  constructor(readonly database: Database) {}

  /** Read-only operation inside a single warehouse. */
  async read<T>(actor: Actor, warehouseId: string, perm: Permission, fn: (ctx: OpCtx) => Promise<T>): Promise<T> {
    requirePermission(actor, perm);
    const scope = await warehouseScope(this.database, actor, warehouseId);
    return this.database.tenantTx(scope, (tx) => fn({ tx, actor, companyId: actor.companyId, warehouseId }));
  }

  /**
   * Mutating, idempotent command inside a single warehouse.
   * @param key client-supplied Idempotency-Key (validated by the controller).
   * @param name stable command name, part of the request fingerprint.
   * @param payload validated input (fingerprinted with canonical JSON).
   */
  async command<T extends object>(
    actor: Actor,
    warehouseId: string,
    perm: Permission,
    key: string,
    name: string,
    payload: unknown,
    fn: (ctx: OpCtx) => Promise<T>,
  ): Promise<CommandResult<T>> {
    requirePermission(actor, perm);
    const scope = await warehouseScope(this.database, actor, warehouseId);
    return this.database.tenantTx(scope, async (tx) => {
      const fingerprint = sha256(canonicalJson({ name, warehouseId, payload }));
      // Insert-first: a concurrent duplicate blocks on the PK until we commit/rollback.
      const inserted = await row<{ k: string }>(
        tx,
        sql`INSERT INTO command_log (company_id, idempotency_key, user_id, command, request_hash, response)
            VALUES (${actor.companyId}, ${key}, ${actor.userId}, ${name}, ${fingerprint}, '{}'::jsonb)
            ON CONFLICT (company_id, idempotency_key) DO NOTHING RETURNING idempotency_key AS k`,
      );
      if (!inserted) {
        const prior = await row<{ user_id: string; request_hash: Buffer; response: T }>(
          tx,
          sql`SELECT user_id, request_hash, response FROM command_log WHERE company_id = ${actor.companyId} AND idempotency_key = ${key}`,
        );
        if (!prior || prior.user_id !== actor.userId || !safeEqual(prior.request_hash, fingerprint)) {
          throw new Conflict('Chave de idempotência reutilizada com outro pedido', 'IDEMPOTENCY_KEY_REUSED');
        }
        return { ...prior.response, replayed: true };
      }
      const result = await fn({ tx, actor, companyId: actor.companyId, warehouseId });
      await tx.execute(
        sql`UPDATE command_log SET response = ${JSON.stringify(result)}::jsonb
            WHERE company_id = ${actor.companyId} AND idempotency_key = ${key}`,
      );
      return result;
    });
  }
}
