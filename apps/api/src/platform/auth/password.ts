/**
 * @file Password hashing (Argon2id) and password policy screening.
 * @module platform/auth
 *
 * Argon2id via @node-rs/argon2 (maintained Rust binding, prebuilt binaries). The library
 * generates a 16-byte CSPRNG salt per hash and returns a PHC string that embeds algorithm,
 * version, parameters and salt, so parameters can be raised later and old hashes re-hashed on
 * next successful login ({@link needsRehash}).
 *
 * Default parameters m=19456 KiB, t=2, p=1 are the OWASP Password Storage Cheat Sheet minimum
 * for Argon2id; see docs/security/AUTH_AND_RBAC.md for the measured benchmark.
 */
import { createHash } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { isBreached } from './breached-corpus.js';
import { COMMON_PASSWORDS } from './common-passwords.js';
import { POLICY_COMMON_PASSWORD_HASHES } from './policy-common-passwords.js';

/** Argon2id numeric algorithm id (const enum value 2 in @node-rs/argon2). */
const ARGON2ID = 2;

/** Argon2 cost parameters. */
export interface Argon2Params {
  memoryKib: number;
  iterations: number;
}

/** Hashes a password with Argon2id and a fresh random salt. */
export async function hashPassword(password: string, p: Argon2Params): Promise<string> {
  return hash(password.normalize('NFC'), {
    algorithm: ARGON2ID,
    memoryCost: p.memoryKib,
    timeCost: p.iterations,
    parallelism: 1,
    outputLen: 32,
  });
}

/** Verifies a password against a PHC hash. Returns false (never throws) on malformed hashes. */
export async function verifyPassword(phc: string, password: string): Promise<boolean> {
  try {
    return await verify(phc, password.normalize('NFC'));
  } catch {
    return false;
  }
}

/** True when the stored hash uses weaker parameters than currently configured. */
export function needsRehash(phc: string, p: Argon2Params): boolean {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(phc);
  if (!m) return true;
  return Number(m[1]) < p.memoryKib || Number(m[2]) < p.iterations;
}

/**
 * Documented context-specific words (ASVS 5.0 V6.1.2 / V6.2.11; listed in AUTH_AND_RBAC.md):
 * product, domain and role words an attacker would try first against this application. The
 * company's code and name and the parts of the user's e-mail and display name are added per
 * account at check time.
 */
export const CONTEXT_WORDS: readonly string[] = [
  'autolemon',
  'lemon',
  'limao',
  'armazem',
  'warehouse',
  'stock',
  'inventario',
  'pecas',
  'autopecas',
  'admin',
  'administrador',
  'operador',
  'password',
  'palavrapasse',
  'senha',
  'portugal',
  'lisboa',
  'porto',
];

/** Account context for password screening. */
export interface PasswordContext {
  email: string;
  displayName?: string;
  companyCode?: string;
  companyName?: string;
}

/** Lower case, accents removed, letters and digits only ("Armazém-1!" → "armazem1"). */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * NIST SP 800-63B-4 style screening: rejects passwords that are on the local common/breached
 * list, are built from the account's own identifiers or from documented context words
 * ({@link CONTEXT_WORDS} + company code/name + display name), or are trivially repetitive.
 * An online k-anonymity breach check (e.g. HIBP range API) is NOT enabled because the
 * runtime has no Internet egress by design; see SECURITY_OPEN_ITEMS.md (SEC-OPEN-004).
 * @returns a pt-PT reason string when rejected, otherwise undefined.
 */
export function screenPassword(password: string, context: PasswordContext): string | undefined {
  const p = password.normalize('NFC');
  const lower = p.toLowerCase();
  if (p.length < 12) return 'A palavra-passe deve ter pelo menos 12 caracteres';
  if (p.length > 128) return 'A palavra-passe não pode exceder 128 caracteres';
  if (
    COMMON_PASSWORDS.has(lower) ||
    COMMON_PASSWORDS.has(lower.replace(/[0-9!@#$%^&*.]+$/, '')) ||
    isPolicyCommon(lower) ||
    isBreached(p)
  ) {
    return 'Esta palavra-passe é demasiado comum ou consta de listas de fugas de dados';
  }
  const local = context.email.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && lower.includes(local)) return 'A palavra-passe não pode conter o seu e-mail';
  if (/^(.)\1+$/.test(p) || /^(.{1,3})\1{3,}$/.test(p)) return 'A palavra-passe é demasiado repetitiva';
  if (lower.includes('autolemon')) return 'A palavra-passe não pode conter o nome da aplicação';
  // A password made mostly of guessable context words plus a few digits/symbols
  // ("Armazem2026!!", "PortoAdmin#1") is rejected; a passphrase that merely contains one
  // ("o meu armazem tem caixas azuis") is not. Rule: after removing every context word, at
  // least 8 letters/digits must remain.
  const words = [
    ...CONTEXT_WORDS,
    ...[context.companyCode, context.companyName, context.displayName, local]
      .flatMap((w) => (w ?? '').split(/[\s._@/-]+/))
      .map(fold)
      .filter((w) => w.length >= 3),
  ].sort((a, b) => b.length - a.length);
  let rest = fold(p);
  for (const w of words) rest = rest.split(w).join('');
  if (rest.length < 8) return 'A palavra-passe assenta em palavras previsíveis (empresa, armazém, nome, função). Use uma frase sua.';
  return undefined;
}

/** True when the lower-cased password is one of the top common passwords that fit the policy. */
function isPolicyCommon(lower: string): boolean {
  return POLICY_COMMON_PASSWORD_HASHES.has(createHash('sha256').update(lower, 'utf8').digest('hex').slice(0, 16));
}
