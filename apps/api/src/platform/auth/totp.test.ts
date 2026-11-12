/**
 * @file Unit tests: RFC 6238 / RFC 4226 vectors, drift window, replay rejection, recovery codes.
 * @module platform/auth
 */
import { describe, expect, it } from 'vitest';
import { base32Encode } from '../../common/crypto-util.js';
import { hotp, newRecoveryCodes, otpauthUri, timeStep, totpNow, verifyTotp } from './totp.js';

const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('TOTP', () => {
  it('matches RFC 4226 Appendix D HOTP values', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((v, i) => expect(hotp(RFC_SECRET, BigInt(i))).toBe(v));
  });

  it('matches RFC 6238 Appendix B (SHA-1, 8 digits)', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [t, code] of vectors) expect(hotp(RFC_SECRET, timeStep(t * 1000), 8)).toBe(code);
  });

  it('accepts ±1 step drift, rejects replays and malformed codes', () => {
    const secret = base32Encode(RFC_SECRET);
    const now = 1_700_000_000_000;
    const code = totpNow(secret, now);
    const step = verifyTotp(secret, code, 0n, now)!;
    expect(step).toBe(timeStep(now));
    expect(verifyTotp(secret, code, step, now)).toBeUndefined(); // replay
    expect(verifyTotp(secret, totpNow(secret, now - 30_000), 0n, now)).toBeDefined();
    expect(verifyTotp(secret, totpNow(secret, now - 90_000), 0n, now)).toBeUndefined();
    expect(verifyTotp(secret, '12345', 0n, now)).toBeUndefined();
    expect(verifyTotp(secret, 'abcdef', 0n, now)).toBeUndefined();
  });

  it('generates distinct, well-formed recovery codes and an encoded otpauth URI', () => {
    const codes = newRecoveryCodes(10);
    expect(new Set(codes).size).toBe(10);
    // 6 × 4 base32 characters = 120 bits ≥ 112 (ASVS 5.0 V6.5.2)
    codes.forEach((c) => expect(c).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}$/));
    expect(otpauthUri('ABC', 'a b@x.pt')).toContain('AutoLemon%20ERP%3Aa%20b%40x.pt');
  });
});
