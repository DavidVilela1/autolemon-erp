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

describe('breached-password corpus (offline, SHA-1, binary search)', () => {
  it('rejects passwords present in the corpus and accepts others; refuses malformed files', async () => {
    const { createHash } = await import('node:crypto');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { BreachedPasswordCorpus, configureBreachedCorpus } = await import('./breached-corpus.js');
    const breached = ['correct horse battery staple', 'Lisboa-Porto-2026!', 'armazem central norte'];
    const filler = Array.from({ length: 500 }, (_, i) => `filler-password-${i}`);
    const lines = [...breached, ...filler].map((p) => createHash('sha1').update(p).digest('hex').toUpperCase()).sort();
    const dir = mkdtempSync(join(tmpdir(), 'corpus-'));
    const file = join(dir, 'corpus.txt');
    writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
    const c = configureBreachedCorpus(file)!;
    expect(c.size).toBe(503);
    for (const p of breached) expect(screenPassword(p, { email: 'x@example.test' })).toMatch(/fugas de dados/);
    expect(screenPassword('uma frase nova e longa 81', { email: 'x@example.test' })).toBeUndefined();
    configureBreachedCorpus(undefined);
    expect(screenPassword('Lisboa-Porto-2026!', { email: 'x@example.test' })).toBeUndefined();
    writeFileSync(join(dir, 'bad.txt'), 'ABC\n');
    expect(() => new BreachedPasswordCorpus(join(dir, 'bad.txt'))).toThrow(/41-byte/);
    writeFileSync(
      join(dir, 'unsorted.txt'),
      [...lines]
        .reverse()
        .map((l) => `${l}\n`)
        .join(''),
    );
    expect(() => new BreachedPasswordCorpus(join(dir, 'unsorted.txt'))).toThrow(/not sorted/);
  });
});
