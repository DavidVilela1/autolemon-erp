/**
 * @file Shared helpers for repository tooling scripts: authored-file listing and secret scanning
 * (owning module: repository tooling).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** Directory names never packaged or scanned as authored content. */
export const EXCLUDED_DIRS = [
  'node_modules',
  'dist',
  'artifacts',
  '.git',
  'playwright-report',
  'test-results',
  'backups',
  '.local',
  'coverage',
];

/** Files authored in this repository (excludes deps, builds, artifacts, local secrets). */
export function authoredFiles(root = ROOT) {
  const skip = new Set(EXCLUDED_DIRS);
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name !== '.env' && !e.name.endsWith('.zip')) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Secret patterns (high signal). Placeholders in .env.example are allowed by design. */
export const SECRET_PATTERNS = [
  ['private key', /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['dev keyring value', /LOCAL_DEV_KEKS=[a-z0-9-]+:[A-Za-z0-9+/]{43}=/],
  ['CSRF secret value', /CSRF_SECRET=[A-Za-z0-9+/]{43}=/],
  ['postgres URL with non-placeholder password', /postgres(?:ql)?:\/\/[^:\s]+:(?!dev_only_|ci_only_|p@|x@|\$\{)[^@\s]{8,}@/],
];

/** Scans files for secrets; returns findings. */
export function scanSecrets(files, root = ROOT) {
  const findings = [];
  for (const f of files) {
    if (statSync(f).size > 2_000_000) continue;
    const rel = relative(root, f).replace(/\\/g, '/');
    if (rel === 'scripts/lib.mjs' || rel === 'pnpm-lock.yaml') continue;
    const text = readFileSync(f, 'utf8');
    for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) findings.push(`${rel}: ${name}`);
  }
  return findings;
}
