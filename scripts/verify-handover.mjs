/**
 * @file `pnpm verify:handover` — handover completeness and archive integrity checks
 * (owning module: repository tooling).
 *
 * Checks: required docs/files exist and are non-trivial; no template placeholders remain in the
 * READMEs; versions are consistent; lockfile + pinned pnpm; no secrets in authored files; when
 * the release archive exists: SHA-256 matches, root folder is `autolemon-erp/`, and no
 * forbidden paths (.env, keys, backups, node_modules, dist, .git) are inside.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authoredFiles, scanSecrets } from './lib.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const problems = [];
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const REQUIRED = [
  'README.md',
  'README-LOCAL-TESTING.md',
  'CHANGELOG.md',
  'pnpm-lock.yaml',
  '.env.example',
  'docker-compose.yml',
  'Dockerfile',
  '.github/workflows/ci.yml',
  'docs/PROJECT_STATE.md',
  'docs/NEXT_TASKS.md',
  'docs/HANDOVER.md',
  'docs/ARCHITECTURE.md',
  'docs/DATABASE.md',
  'docs/WMS_STATE_MACHINES.md',
  'docs/API.md',
  'docs/api/openapi.json',
  'docs/EXTENDING_AUTOLEMON.md',
  'docs/DEPENDENCIES.md',
  'docs/OPERATIONS.md',
  'docs/DESIGN_SYSTEM.md',
  'docs/security/THREAT_MODEL.md',
  'docs/security/DATA_CLASSIFICATION.md',
  'docs/security/AUTH_AND_RBAC.md',
  'docs/security/ENCRYPTION_AND_KEYS.md',
  'docs/security/AUDIT_LOGGING.md',
  'docs/security/NETWORK_AND_ZTNA.md',
  'docs/security/CI-CD-SECURITY.md',
  'docs/security/BACKUP_AND_DR.md',
  'docs/security/SECURITY_TEST_MATRIX.md',
  'docs/security/SECURITY_OPEN_ITEMS.md',
  'docs/security/ASVS_L2_ASSESSMENT.md',
];
for (const f of REQUIRED) {
  const p = join(ROOT, f);
  if (!existsSync(p)) problems.push(`missing ${f}`);
  else if (statSync(p).size < 200) problems.push(`${f} looks empty (${statSync(p).size} bytes)`);
}
for (const f of ['README.md', 'README-LOCAL-TESTING.md']) {
  if (!existsSync(join(ROOT, f))) continue;
  const t = readFileSync(join(ROOT, f), 'utf8');
  for (const bad of ['<PINNED_VERSION>', 'vX.Y.Z', 'X.Y.Z.zip', 'adjust to actual ZIP root'])
    if (t.includes(bad)) problems.push(`${f} still contains placeholder "${bad}"`);
  if (!t.includes(`AutoLemon-ERP-v${pkg.version}-WMS.zip`)) problems.push(`${f} does not reference AutoLemon-ERP-v${pkg.version}-WMS.zip`);
  if (!t.includes(pkg.packageManager.split('@')[1])) problems.push(`${f} does not mention pinned pnpm ${pkg.packageManager}`);
}
for (const p of ['apps/api/package.json', 'apps/web/package.json', 'packages/contracts/package.json']) {
  if (JSON.parse(readFileSync(join(ROOT, p), 'utf8')).version !== pkg.version) problems.push(`${p} version differs from ${pkg.version}`);
}
if (!/^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager ?? '')) problems.push('packageManager must pin an exact pnpm version');
if (existsSync(join(ROOT, 'docs/DEPENDENCIES.md')) && !readFileSync(join(ROOT, 'docs/DEPENDENCIES.md'), 'utf8').includes('2026-11-09'))
  problems.push('DEPENDENCIES.md lacks the verification date');
const leaks = scanSecrets(authoredFiles(ROOT));
if (leaks.length) problems.push(...leaks.map((l) => `secret: ${l}`));

const zip = join(ROOT, 'artifacts', `AutoLemon-ERP-v${pkg.version}-WMS.zip`);
if (existsSync(zip)) {
  const expected = readFileSync(`${zip}.sha256`, 'utf8').split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(zip)).digest('hex');
  if (expected !== actual) problems.push('archive SHA-256 mismatch');
  const list = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  if (!list.every((e) => e.startsWith('autolemon-erp/'))) problems.push('archive root is not autolemon-erp/');
  const forbidden = list.filter(
    (e) =>
      /(^|\/)(\.env|\.local\/|backups\/|node_modules\/|dist\/|\.git\/|test-results\/|playwright-report\/|invitations-dev\.txt|[^/]*\.pem$|audit-digest-[^/]*\.json$)/.test(
        e,
      ) && !e.endsWith('.env.example'),
  );
  if (forbidden.length) problems.push(`forbidden paths in archive: ${forbidden.slice(0, 5).join(', ')}`);
  for (const must of [
    'autolemon-erp/pnpm-lock.yaml',
    'autolemon-erp/README-LOCAL-TESTING.md',
    'autolemon-erp/docs/PROJECT_STATE.md',
    'autolemon-erp/docs/HANDOVER.md',
  ]) {
    if (!list.includes(must)) problems.push(`archive lacks ${must}`);
  }
  console.log(`Archive checked: ${list.length} entries, sha256 ${actual}`);
} else {
  console.log('No release archive yet (run pnpm release:zip) — archive checks skipped.');
}
if (problems.length) {
  console.error(`Handover verification FAILED:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log('Handover verification passed.');
