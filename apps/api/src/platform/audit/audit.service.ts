/**
 * @file Hash-chained, append-only security audit log.
 * @module platform/audit
 *
 * Each entry stores prev_hash and hash = SHA-256(prev_hash || canonicalJson(entry)). Chains are
 * per tenant (chain_key = company id) plus one pre-authentication chain (nil UUID) for events
 * such as failed logins for unknown accounts. A per-chain advisory transaction lock serialises
 * appends so sequence numbers are gap-free. Tampering with any stored entry (or deleting one)
 * breaks verification from that point on.
 *
 * Limits (documented in AUDIT_LOGGING.md): a database superuser could rewrite an entire chain
 * consistently. Production must ship entries/digests off-site to write-once storage.
 *
 * Redaction: `details` must never contain passwords, tokens, session ids, keys or full PII.
 * {@link redactDetails} enforces a key denylist as a safety net.
 */
import { sql } from 'drizzle-orm';
import type { Database, Tx } from '../../db/database.js';
import { asDate, row, rows } from '../../db/database.js';
import { canonicalJson, safeEqual, sha256 } from '../../common/crypto-util.js';

/** The nil UUID identifies the pre-authentication chain. */
export const PRE_AUTH_CHAIN = '00000000-0000-0000-0000-000000000000';

/** An audit event to record. */
export interface AuditEvent {
  companyId?: string | null;
  actorUserId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  warehouseId?: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  requestId?: string;
  clientIp?: string;
  details?: Record<string, string | number | boolean | null>;
}

/** Key fragments that always indicate secret/PII content. */
const SENSITIVE_SUBSTR = /pass|secret|token|cookie|session|otp|kek|dek|phone|contact|authorization/i;
/** Exact key names that are sensitive (too generic to match as substrings). */
const SENSITIVE_EXACT = /^(code|key|email|recoverycode)$/i;

/** Replaces values of keys that look sensitive with "[REDACTED]". Returns a new object. */
export function redactDetails(d: AuditEvent['details'] = {}): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(d)) {
    out[k] = SENSITIVE_SUBSTR.test(k) || SENSITIVE_EXACT.test(k) ? '[REDACTED]' : v;
  }
  return out;
}

const ZERO = Buffer.alloc(32);

/** Records and verifies audit entries. */
export class AuditService {
  constructor(private readonly database: Database) {}

  /**
   * Appends an entry inside the CALLER's transaction (use for success events of a command
   * so that the audit row commits or rolls back with the change it describes).
   */
  async recordInTx(tx: Tx, ev: AuditEvent): Promise<void> {
    const chainKey = ev.companyId ?? PRE_AUTH_CHAIN;
    // Serialise appends per chain; lock is released at transaction end.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'audit:' + chainKey}))`);
    const last = await row<{ seq: string; hash: Buffer }>(
      tx,
      sql`SELECT seq, hash FROM security_audit_log WHERE chain_key = ${chainKey} ORDER BY seq DESC LIMIT 1`,
    );
    const seq = last ? BigInt(last.seq) + 1n : 1n;
    const prev = last?.hash ?? ZERO;
    const occurredAt = new Date().toISOString();
    const entry = {
      chainKey,
      seq: seq.toString(),
      companyId: ev.companyId ?? null,
      occurredAt,
      actorUserId: ev.actorUserId ?? null,
      action: ev.action,
      resourceType: ev.resourceType ?? null,
      resourceId: ev.resourceId ?? null,
      warehouseId: ev.warehouseId ?? null,
      outcome: ev.outcome,
      requestId: ev.requestId ?? null,
      clientIp: ev.clientIp ?? null,
      details: redactDetails(ev.details),
    };
    const hash = sha256(Buffer.concat([prev, Buffer.from(canonicalJson(entry), 'utf8')]));
    await tx.execute(sql`
      INSERT INTO security_audit_log (chain_key, seq, company_id, occurred_at, actor_user_id, action,
        resource_type, resource_id, warehouse_id, outcome, request_id, client_ip, details, prev_hash, hash)
      VALUES (${chainKey}, ${entry.seq}, ${entry.companyId}, ${occurredAt}, ${entry.actorUserId}, ${entry.action},
        ${entry.resourceType}, ${entry.resourceId}, ${entry.warehouseId}, ${entry.outcome}, ${entry.requestId},
        ${entry.clientIp}, ${JSON.stringify(entry.details)}::jsonb, ${prev}, ${hash})`);
  }

  /**
   * Appends an entry in its OWN transaction. Use for denials/failures, which must be recorded
   * even though the business transaction is rolled back.
   */
  async record(ev: AuditEvent): Promise<void> {
    await this.database.systemTx((tx) => this.recordInTx(tx, ev));
  }

  /**
   * Recomputes a chain and reports the first broken sequence number, if any.
   * @returns `{ ok, checked, brokenAtSeq? }`
   */
  async verifyChain(chainKey: string): Promise<{ ok: boolean; checked: number; brokenAtSeq?: string }> {
    const entries = await this.database.systemTx((tx) =>
      rows<{
        chain_key: string;
        seq: string;
        company_id: string | null;
        occurred_at: Date | string;
        actor_user_id: string | null;
        action: string;
        resource_type: string | null;
        resource_id: string | null;
        warehouse_id: string | null;
        outcome: string;
        request_id: string | null;
        client_ip: string | null;
        details: Record<string, unknown>;
        prev_hash: Buffer;
        hash: Buffer;
      }>(tx, sql`SELECT * FROM security_audit_log WHERE chain_key = ${chainKey} ORDER BY seq`),
    );
    let prev: Buffer = ZERO;
    let expectedSeq = 1n;
    for (const e of entries) {
      const entry = {
        chainKey: e.chain_key,
        seq: e.seq,
        companyId: e.company_id,
        occurredAt: asDate(e.occurred_at)!.toISOString(),
        actorUserId: e.actor_user_id,
        action: e.action,
        resourceType: e.resource_type,
        resourceId: e.resource_id,
        warehouseId: e.warehouse_id,
        outcome: e.outcome,
        requestId: e.request_id,
        clientIp: e.client_ip,
        details: e.details,
      };
      const h = sha256(Buffer.concat([prev, Buffer.from(canonicalJson(entry), 'utf8')]));
      if (BigInt(e.seq) !== expectedSeq || !safeEqual(prev, e.prev_hash) || !safeEqual(h, e.hash)) {
        return { ok: false, checked: entries.length, brokenAtSeq: e.seq };
      }
      prev = e.hash;
      expectedSeq++;
    }
    return { ok: true, checked: entries.length };
  }
}
