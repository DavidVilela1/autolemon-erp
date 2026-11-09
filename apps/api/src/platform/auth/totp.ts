/**
 * @file RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s step) with replay protection support.
 * @module platform/auth
 *
 * Implemented directly on node:crypto HMAC (a protocol, not a new primitive) and verified
 * against the RFC 6238 Appendix B test vectors in totp.test.ts. TOTP is a documented
 * FALLBACK factor: it is not phishing-resistant (see AUTH_AND_RBAC.md, WebAuthn status).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { base32Encode, base32Decode } from '../../common/crypto-util.js';

/** Step length in seconds. */
export const TOTP_STEP = 30;

/** Generates a new 160-bit secret, base32-encoded. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Computes the HOTP value (RFC 4226) for a counter. */
export function hotp(secret: Buffer, counter: bigint, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const mac = createHmac('sha1', secret).update(msg).digest();
  // Dynamic truncation (RFC 4226 §5.3).
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

/** Current time step for a unix time in ms. */
export function timeStep(nowMs: number): bigint {
  return BigInt(Math.floor(nowMs / 1000 / TOTP_STEP));
}

/** Generates the code for "now" (used by tests and the dev seed helper only). */
export function totpNow(secretB32: string, nowMs = Date.now()): string {
  return hotp(base32Decode(secretB32), timeStep(nowMs));
}

/**
 * Verifies a code within ±1 step of clock drift.
 * @param lastUsedStep the highest step previously accepted for this user; codes at or below it
 *   are rejected to prevent replay of an intercepted code within its validity window.
 * @returns the accepted step, or undefined when invalid/replayed.
 */
export function verifyTotp(secretB32: string, code: string, lastUsedStep: bigint, nowMs = Date.now()): bigint | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const secret = base32Decode(secretB32);
  const now = timeStep(nowMs);
  let accepted: bigint | undefined;
  for (const step of [now - 1n, now, now + 1n]) {
    const expected = Buffer.from(hotp(secret, step));
    // Compare all candidates in constant time (no early exit on match).
    if (timingSafeEqual(expected, Buffer.from(code)) && step > lastUsedStep) accepted = step;
  }
  return accepted;
}

/** Builds an otpauth:// URI for authenticator apps (label/issuer are URI-encoded). */
export function otpauthUri(secretB32: string, accountLabel: string, issuer = 'AutoLemon ERP'): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP}`;
}

/** Generates `n` human-friendly recovery codes (80 bits each): XXXX-XXXX-XXXX-XXXX. */
export function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const s = base32Encode(randomBytes(10)).slice(0, 16);
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
  });
}
