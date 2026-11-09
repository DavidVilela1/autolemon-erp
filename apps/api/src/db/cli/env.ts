/**
 * @file Shared loader for database CLI tools: reads .env (generating dev secrets) when present.
 * @module platform/db
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Loads .env via scripts/dev-env.mjs unless SKIP_DOTENV=1 (CI/test harness inject env). */
export async function loadToolEnv(): Promise<void> {
  if (process.env.SKIP_DOTENV === '1') return;
  const root = resolve(import.meta.dirname, '../../../../..');
  if (!existsSync(resolve(root, '.env'))) {
    throw new Error('.env not found at repository root. Run: cp .env.example .env');
  }
  const mod = (await import(pathToFileURL(resolve(root, 'scripts/dev-env.mjs')).href)) as { ensureDevEnv: () => void };
  mod.ensureDevEnv();
}

/** Returns a required environment variable or exits with a clear message. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(2);
  }
  return v;
}
