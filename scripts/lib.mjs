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
      // Keys (*.pem) and digest files are local secrets/evidence, never authored content (ADR-0027).
      else if (
        e.name !== '.env' &&
        e.name !== 'invitations-dev.txt' &&
        !e.name.endsWith('.zip') &&
        !e.name.endsWith('.pem') &&
        !/^audit-digest-.*\.json$/.test(e.name)
      )
        out.push(p);
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

/** Longest a dependency-audit exception may run before it must be re-decided (days). */
export const AUDIT_EXCEPTION_MAX_DAYS = 90;

/**
 * Dependency-audit policy (docs/security/CI-CD-SECURITY.md):
 * - HIGH/CRITICAL in a production dependency always blocks — no exception possible;
 * - HIGH/CRITICAL only in development tooling blocks unless that exact advisory id has an
 *   unexpired exception (≤ AUDIT_EXCEPTION_MAX_DAYS) in docs/security/audit-exceptions.json;
 * - an expired or over-long exception blocks; an exception for an advisory no longer reported
 *   is a warning (remove it); moderate/low are reported only.
 * @param {{ advisories: Array<{ id: string, severity: string, module: string }>, prodIds: Set<string>,
 *   exceptions: Array<{ advisory: string, recorded: string, expires: string }>, today: string }} input
 * @returns {{ ok: boolean, blocking: string[], accepted: string[], warnings: string[] }}
 */
export function evaluateAudit({ advisories, prodIds, exceptions, today }) {
  const blocking = [];
  const accepted = [];
  const warnings = [];
  const day = (s) => Date.parse(`${s}T00:00:00Z`);
  for (const e of exceptions) {
    if (!(day(e.expires) >= day(today))) blocking.push(`exception ${e.advisory} expired on ${e.expires}`);
    if (!(day(e.expires) - day(e.recorded) <= AUDIT_EXCEPTION_MAX_DAYS * 86_400_000)) {
      blocking.push(`exception ${e.advisory} runs longer than ${AUDIT_EXCEPTION_MAX_DAYS} days`);
    }
    if (!advisories.some((a) => a.id === e.advisory)) warnings.push(`exception ${e.advisory} no longer needed — remove it`);
  }
  for (const a of advisories) {
    if (a.severity !== 'high' && a.severity !== 'critical') continue;
    const label = `${a.id} ${a.module} (${a.severity})`;
    if (prodIds.has(a.id)) {
      blocking.push(`${label} in a production dependency`);
      continue;
    }
    const ex = exceptions.find((e) => e.advisory === a.id);
    if (ex && day(ex.expires) >= day(today)) accepted.push(`${label}, dev-only, accepted until ${ex.expires}`);
    else blocking.push(`${label}, dev-only, no valid exception`);
  }
  return { ok: blocking.length === 0, blocking, accepted, warnings };
}
