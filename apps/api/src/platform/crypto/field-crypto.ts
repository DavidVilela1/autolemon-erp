/**
 * @file Application-level field encryption (AES-256-GCM, per-tenant envelope keys).
 * @module platform/crypto
 *
 * Envelope format (text, safe for a `text` column):
 *   alenc1.<keyVersion>.<base64url nonce(12)>.<base64url ciphertext||tag(16)>
 * Additional authenticated data binds every ciphertext to
 *   tenant + table + record id + field + key version,
 * so copying a ciphertext into another tenant, row or column makes decryption FAIL
 * (tamper/transplant detection). Decryption errors never fall back to plaintext.
 *
 * Nonces are 96-bit CSPRNG values. With random nonces, NIST SP 800-38D limits a single key to
 * 2^32 encryptions; per-tenant DEKs plus rotation keep usage far below that bound.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database, Tx } from '../../db/database.js';
import { row, rows } from '../../db/database.js';
import type { KeyProvider } from './key-provider.js';

/** Identifies where a ciphertext lives; becomes AAD. */
export interface FieldRef {
  companyId: string;
  table: string;
  recordId: string;
  field: string;
}

/** Thrown when a ciphertext cannot be authenticated/decrypted. Callers must fail closed. */
export class DecryptionError extends Error {
  constructor() {
    super('Encrypted field could not be authenticated');
  }
}

/**
 * Registry of every encrypted column (code-defined allowlist). Used by key rotation to
 * re-encrypt data; identifiers here are constants, never user input.
 */
export const ENCRYPTED_FIELDS = [
  { table: 'users', idColumn: 'id', column: 'phone_enc', field: 'phone' },
  { table: 'mfa_totp', idColumn: 'user_id', column: 'secret_enc', field: 'totp_secret' },
  { table: 'outbound_orders', idColumn: 'id', column: 'recipient_contact_enc', field: 'recipient_contact' },
] as const;

function aad(ref: FieldRef, version: number): Buffer {
  return Buffer.from(
    `autolemon|field|v1|company:${ref.companyId}|table:${ref.table}|record:${ref.recordId}|field:${ref.field}|key:${version}`,
    'utf8',
  );
}

/** Manages per-tenant DEKs (creation, caching, rotation) and encrypts/decrypts fields. */
export class FieldCrypto {
  private readonly cache = new Map<string, { key: Buffer; expires: number }>();
  private static readonly CACHE_MS = 5 * 60_000;

  constructor(
    private readonly database: Database,
    private readonly provider: KeyProvider,
  ) {}

  /** Encrypts `plaintext` with the tenant's ACTIVE DEK (creating version 1 on first use). */
  async encrypt(ref: FieldRef, plaintext: string): Promise<string> {
    const { version, key } = await this.activeKey(ref.companyId);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(ref, version));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return `alenc1.${version}.${nonce.toString('base64url')}.${ct.toString('base64url')}`;
  }

  /**
   * Decrypts an envelope. Throws {@link DecryptionError} for malformed input, unknown key
   * version, wrong tenant/record/field (AAD mismatch) or any bit-level tampering.
   */
  async decrypt(ref: FieldRef, envelope: string): Promise<string> {
    const m = /^alenc1\.(\d{1,6})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,})$/.exec(envelope);
    if (!m) throw new DecryptionError();
    const version = Number(m[1]);
    try {
      const key = await this.keyVersion(ref.companyId, version);
      const nonce = Buffer.from(m[2]!, 'base64url');
      const data = Buffer.from(m[3]!, 'base64url');
      if (nonce.length !== 12 || data.length < 16) throw new DecryptionError();
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(aad(ref, version));
      decipher.setAuthTag(data.subarray(data.length - 16));
      return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8');
    } catch {
      throw new DecryptionError();
    }
  }

  /** Returns the key version embedded in an envelope (for rotation bookkeeping). */
  static envelopeVersion(envelope: string): number | undefined {
    const m = /^alenc1\.(\d{1,6})\./.exec(envelope);
    return m ? Number(m[1]) : undefined;
  }

  /**
   * DEK rotation: retires the active DEK, creates version+1 and re-encrypts every registered
   * encrypted field of the tenant with the new key. Old versions stay available for decrypt
   * (backups) until an operator destroys them per the retention policy.
   * @returns number of re-encrypted values.
   */
  async rotateTenantKey(companyId: string): Promise<{ newVersion: number; reencrypted: number }> {
    const newVersion = await this.database.systemTx(async (tx) => {
      const cur = await row<{ version: number }>(
        tx,
        sql`SELECT version FROM tenant_data_keys WHERE company_id = ${companyId} AND status = 'ACTIVE' FOR UPDATE`,
      );
      const next = (cur?.version ?? 0) + 1;
      await tx.execute(sql`UPDATE tenant_data_keys SET status = 'RETIRED' WHERE company_id = ${companyId} AND status = 'ACTIVE'`);
      await this.insertKey(tx, companyId, next);
      return next;
    });
    this.cache.clear();
    let count = 0;
    for (const f of ENCRYPTED_FIELDS) {
      // Identifiers come from the ENCRYPTED_FIELDS constant (reviewed raw SQL).
      const items = await this.database.tenantTx({ companyId, whScope: '*' }, (tx) =>
        rows<{ id: string; v: string }>(
          tx,
          sql`SELECT ${sql.raw(f.idColumn)}::text AS id, ${sql.raw(f.column)} AS v FROM ${sql.raw(f.table)}
              WHERE company_id = ${companyId} AND ${sql.raw(f.column)} IS NOT NULL`,
        ),
      );
      for (const it of items) {
        if (FieldCrypto.envelopeVersion(it.v) === newVersion) continue;
        const ref = { companyId, table: f.table, recordId: it.id, field: f.field };
        const plain = await this.decrypt(ref, it.v);
        const enc = await this.encrypt(ref, plain);
        await this.database.tenantTx({ companyId, whScope: '*' }, (tx) =>
          tx.execute(
            sql`UPDATE ${sql.raw(f.table)} SET ${sql.raw(f.column)} = ${enc}
                WHERE ${sql.raw(f.idColumn)} = ${it.id} AND company_id = ${companyId} AND ${sql.raw(f.column)} = ${it.v}`,
          ),
        );
        count++;
      }
    }
    return { newVersion, reencrypted: count };
  }

  /**
   * KEK rotation (rewrap): unwraps every DEK with its recorded KEK and wraps it with the
   * provider's ACTIVE KEK. Field ciphertexts are untouched (DEKs do not change).
   * @param companyIds optional subset of tenants (staged rotation); default: all tenants.
   */
  async rewrapAllDeks(companyIds?: string[]): Promise<number> {
    const keys = await this.database.systemTx((tx) =>
      rows<{ id: string; company_id: string; version: number; kek_id: string; wrapped_dek: Buffer }>(
        tx,
        companyIds
          ? sql`SELECT id, company_id, version, kek_id, wrapped_dek FROM tenant_data_keys
                WHERE company_id IN (${sql.join(
                  companyIds.map((c) => sql`${c}`),
                  sql`, `,
                )})`
          : sql`SELECT id, company_id, version, kek_id, wrapped_dek FROM tenant_data_keys`,
      ),
    );
    let n = 0;
    for (const k of keys) {
      if (k.kek_id === this.provider.activeKekId) continue;
      const ctx = { companyId: k.company_id, version: k.version };
      const dek = await this.provider.unwrap(k.kek_id, k.wrapped_dek, ctx);
      const { kekId, wrapped } = await this.provider.wrap(dek, ctx);
      await this.database.systemTx((tx) =>
        tx.execute(sql`UPDATE tenant_data_keys SET kek_id = ${kekId}, wrapped_dek = ${wrapped} WHERE id = ${k.id}`),
      );
      n++;
    }
    this.cache.clear();
    return n;
  }

  private async insertKey(tx: Tx, companyId: string, version: number): Promise<Buffer> {
    const dek = randomBytes(32);
    const { kekId, wrapped } = await this.provider.wrap(dek, { companyId, version });
    await tx.execute(
      sql`INSERT INTO tenant_data_keys (company_id, version, kek_id, wrapped_dek, status)
          VALUES (${companyId}, ${version}, ${kekId}, ${wrapped}, 'ACTIVE')`,
    );
    return dek;
  }

  private async activeKey(companyId: string): Promise<{ version: number; key: Buffer }> {
    const found = await this.database.systemTx((tx) =>
      row<{ version: number }>(tx, sql`SELECT version FROM tenant_data_keys WHERE company_id = ${companyId} AND status = 'ACTIVE'`),
    );
    if (found) return { version: found.version, key: await this.keyVersion(companyId, found.version) };
    // First use for this tenant: create version 1. A concurrent creator loses on the
    // partial unique index; we then simply read the winner's key.
    try {
      const dek = await this.database.systemTx((tx) => this.insertKey(tx, companyId, 1));
      this.cache.set(`${companyId}:1`, { key: dek, expires: Date.now() + FieldCrypto.CACHE_MS });
      return { version: 1, key: dek };
    } catch {
      return this.activeKey(companyId);
    }
  }

  private async keyVersion(companyId: string, version: number): Promise<Buffer> {
    const cacheKey = `${companyId}:${version}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.key;
    const rec = await this.database.systemTx((tx) =>
      row<{ kek_id: string; wrapped_dek: Buffer }>(
        tx,
        sql`SELECT kek_id, wrapped_dek FROM tenant_data_keys WHERE company_id = ${companyId} AND version = ${version}`,
      ),
    );
    if (!rec) throw new DecryptionError();
    const key = await this.provider.unwrap(rec.kek_id, rec.wrapped_dek, { companyId, version });
    this.cache.set(cacheKey, { key, expires: Date.now() + FieldCrypto.CACHE_MS });
    return key;
  }
}
