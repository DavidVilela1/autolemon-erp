/**
 * @file Small cryptographic utilities built ONLY on node:crypto primitives.
 * @module platform/common
 *
 * No new cryptography is invented here: random token generation (CSPRNG), SHA-256 hashing of
 * high-entropy secrets, constant-time comparison and canonical JSON for hash chains.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit URL-safe random token (43 chars). Used for sessions, CSRF and one-time links. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 digest of a UTF-8 string. Suitable ONLY for high-entropy random secrets, not passwords. */
export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time equality for two buffers (false on length mismatch). */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Deterministic JSON serialisation with sorted object keys, used to hash audit entries so
 * verification is independent of JSONB key ordering.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

/** RFC 4648 base32 alphabet (used by TOTP secrets and recovery codes). */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Encodes bytes as unpadded RFC 4648 base32. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes unpadded RFC 4648 base32 (case-insensitive). Throws on invalid characters. */
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
