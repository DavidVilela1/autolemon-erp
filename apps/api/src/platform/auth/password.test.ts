/**
 * @file Unit tests: Argon2id hashing (salted, PHC, rehash detection) and password screening.
 * @module platform/auth
 */
import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, screenPassword, verifyPassword } from './password.js';

const P = { memoryKib: 19456, iterations: 2 };

describe('Argon2id', () => {
  it('produces salted PHC strings that verify, and different hashes for the same password', async () => {
    const a = await hashPassword('uma frase longa e única 42', P);
    const b = await hashPassword('uma frase longa e única 42', P);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'uma frase longa e única 42')).toBe(true);
    expect(await verifyPassword(a, 'uma frase longa e única 43')).toBe(false);
    expect(await verifyPassword('garbage', 'x')).toBe(false);
  });
  it('flags hashes weaker than the configured parameters', async () => {
    const h = await hashPassword('outra frase longa 99', P);
    expect(needsRehash(h, P)).toBe(false);
    expect(needsRehash(h, { memoryKib: 65536, iterations: 3 })).toBe(true);
    expect(needsRehash('$2b$10$bcrypt', P)).toBe(true);
  });
});

describe('password screening (NIST 800-63B style)', () => {
  const ctx = { email: 'joana.silva@oficina.pt' };
  it.each([
    ['short', 'curta'],
    ['common', 'password1234'],
    ['common-with-suffix', 'qwertyuiop!!'],
    ['contains email', 'joana.silva-2026!'],
    ['repetitive', 'aaaaaaaaaaaaaa'],
    ['app name', 'my-autolemon-pass'],
  ])('rejects %s', (_l, pw) => expect(screenPassword(pw, ctx)).toBeDefined());
  it('accepts long unique passphrases without composition rules', () => {
    expect(screenPassword('cavalo correto bateria agrafo', ctx)).toBeUndefined();
  });
});
