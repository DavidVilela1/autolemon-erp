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
import { hash, verify } from '@node-rs/argon2';
import { isBreached } from './breached-corpus.js';
import { COMMON_PASSWORDS } from './common-passwords.js';

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
 * NIST SP 800-63B-4 style screening: rejects passwords that are on the local common/breached
 * list, are built from the account's own identifiers, or are trivially repetitive.
 * An online k-anonymity breach check (e.g. HIBP range API) is NOT enabled because the
 * runtime has no Internet egress by design; see SECURITY_OPEN_ITEMS.md (SEC-OPEN-004).
 * @returns a pt-PT reason string when rejected, otherwise undefined.
 */
export function screenPassword(password: string, context: { email: string; displayName?: string }): string | undefined {
  const p = password.normalize('NFC');
  const lower = p.toLowerCase();
  if (p.length < 12) return 'A palavra-passe deve ter pelo menos 12 caracteres';
  if (p.length > 128) return 'A palavra-passe não pode exceder 128 caracteres';
  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(lower.replace(/[0-9!@#$%^&*.]+$/, '')) || isBreached(p)) {
    return 'Esta palavra-passe é demasiado comum ou consta de listas de fugas de dados';
  }
  const local = context.email.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && lower.includes(local)) return 'A palavra-passe não pode conter o seu e-mail';
  if (/^(.)\1+$/.test(p) || /^(.{1,3})\1{3,}$/.test(p)) return 'A palavra-passe é demasiado repetitiva';
  if (lower.includes('autolemon')) return 'A palavra-passe não pode conter o nome da aplicação';
  return undefined;
}
