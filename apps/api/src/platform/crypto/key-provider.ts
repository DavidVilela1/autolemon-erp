/**
 * @file Key-encryption-key (KEK) provider abstraction for envelope encryption.
 * @module platform/crypto
 *
 * Data-encryption keys (DEKs) are generated per tenant and stored only WRAPPED (encrypted)
 * by a KEK. In production the KEK must live in a managed KMS/HSM/secrets vault and wrapping
 * happens there; the application never sees KEK bytes. {@link LocalDevKeyProvider} keeps
 * KEKs in process memory from an environment variable and is EXPLICITLY UNSAFE FOR
 * PRODUCTION: it is refused by configuration validation when NODE_ENV=production.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Context bound into the wrap as AAD so a wrapped DEK cannot be swapped between tenants/versions. */
export interface WrapContext {
  companyId: string;
  version: number;
}

/** Abstraction implemented by local-dev and (future) KMS providers. */
export interface KeyProvider {
  /** Identifier of the KEK used for new wraps. */
  readonly activeKekId: string;
  /** Wraps (encrypts) a DEK with the active KEK. */
  wrap(dek: Buffer, ctx: WrapContext): Promise<{ kekId: string; wrapped: Buffer }>;
  /** Unwraps a DEK; throws (fail closed) on unknown KEK, wrong context or tampering. */
  unwrap(kekId: string, wrapped: Buffer, ctx: WrapContext): Promise<Buffer>;
  /** True only for providers acceptable in production. */
  readonly productionSafe: boolean;
}

function wrapAad(kekId: string, ctx: WrapContext): Buffer {
  return Buffer.from(`autolemon|dek|v1|kek:${kekId}|company:${ctx.companyId}|version:${ctx.version}`, 'utf8');
}

/**
 * Development keyring provider. Keyring format: "kekId:base64(32 bytes)[,kekId:base64]".
 * The FIRST entry is the active KEK; the others remain available for unwrap during rotation.
 * Wrap format: nonce(12) || ciphertext(32) || tag(16), AES-256-GCM.
 */
export class LocalDevKeyProvider implements KeyProvider {
  readonly productionSafe = false;
  readonly activeKekId: string;
  private readonly keks = new Map<string, Buffer>();

  /** @param keyring keyring string; never logged. */
  constructor(keyring: string) {
    for (const entry of keyring
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const sep = entry.indexOf(':');
      const id = entry.slice(0, sep);
      const key = Buffer.from(entry.slice(sep + 1), 'base64');
      if (sep < 1 || !/^[a-z0-9-]{3,40}$/.test(id) || key.length !== 32) {
        throw new Error('LOCAL_DEV_KEKS entry malformed (expected kekId:base64-32-bytes)');
      }
      this.keks.set(id, key);
    }
    const first = this.keks.keys().next();
    if (first.done) throw new Error('LOCAL_DEV_KEKS is empty');
    this.activeKekId = first.value;
  }

  async wrap(dek: Buffer, ctx: WrapContext): Promise<{ kekId: string; wrapped: Buffer }> {
    const kek = this.keks.get(this.activeKekId)!;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', kek, nonce);
    cipher.setAAD(wrapAad(this.activeKekId, ctx));
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    return { kekId: this.activeKekId, wrapped: Buffer.concat([nonce, ct, cipher.getAuthTag()]) };
  }

  async unwrap(kekId: string, wrapped: Buffer, ctx: WrapContext): Promise<Buffer> {
    const kek = this.keks.get(kekId);
    if (!kek) throw new Error(`KEK ${kekId} not available in keyring`);
    if (wrapped.length !== 12 + 32 + 16) throw new Error('wrapped DEK has invalid length');
    const decipher = createDecipheriv('aes-256-gcm', kek, wrapped.subarray(0, 12));
    decipher.setAAD(wrapAad(kekId, ctx));
    decipher.setAuthTag(wrapped.subarray(44));
    return Buffer.concat([decipher.update(wrapped.subarray(12, 44)), decipher.final()]);
  }
}

/**
 * Placeholder for a managed KMS provider (AWS KMS, GCP KMS, Azure Key Vault, HashiCorp
 * Vault Transit). NOT IMPLEMENTED / NOT DEPLOYED in v0.5 — selecting it fails closed.
 */
export class ExternalKmsProvider implements KeyProvider {
  readonly productionSafe = true;
  readonly activeKekId = 'external-kms-unconfigured';
  async wrap(): Promise<{ kekId: string; wrapped: Buffer }> {
    throw new Error('External KMS provider is not configured (NOT DEPLOYED in v0.5)');
  }
  async unwrap(): Promise<Buffer> {
    throw new Error('External KMS provider is not configured (NOT DEPLOYED in v0.5)');
  }
}
