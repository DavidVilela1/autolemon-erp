/**
 * @file Loads .env and generates missing development secrets (owning module: repository tooling).
 *
 * Replaces `__GENERATE__` placeholders in .env with fresh CSPRNG values (dev KEK keyring and
 * CSRF secret) so no key material ever lives in the repository or the release archive.
 * Refuses to generate anything when NODE_ENV=production.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Repository root (scripts/..). */
export const ROOT = resolve(import.meta.dirname, '..');

/**
 * Parses a dotenv file (KEY=VALUE, # comments). Values are taken literally (no expansion).
 * @param {string} file
 * @returns {Record<string,string>}
 */
export function parseEnvFile(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Ensures .env exists with generated dev secrets and loads it into process.env (existing
 * environment variables win, so CI can inject its own values).
 * @returns {Record<string,string>} merged environment
 */
export function ensureDevEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) {
    throw new Error('.env not found. Run: cp .env.example .env  (PowerShell: Copy-Item .env.example .env)');
  }
  let text = readFileSync(envPath, 'utf8');
  if (text.includes('__GENERATE__')) {
    if ((process.env.NODE_ENV ?? parseEnvFile(envPath).NODE_ENV) === 'production') {
      throw new Error('Refusing to generate secrets for NODE_ENV=production');
    }
    text = text
      .replace('LOCAL_DEV_KEKS=__GENERATE__', `LOCAL_DEV_KEKS=dev-kek-${Date.now().toString(36)}:${randomBytes(32).toString('base64')}`)
      .replace('CSRF_SECRET=__GENERATE__', `CSRF_SECRET=${randomBytes(32).toString('base64')}`);
    writeFileSync(envPath, text, { mode: 0o600 });
    console.log('[dev-env] Generated development-only secrets in .env (never commit this file).');
  }
  const parsed = parseEnvFile(envPath);
  for (const [k, v] of Object.entries(parsed)) if (process.env[k] === undefined) process.env[k] = v;
  return { ...parsed, ...process.env };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureDevEnv();
  console.log('[dev-env] .env ready');
}
