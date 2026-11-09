/**
 * @file `pnpm security:scan` — local security scanner aggregate (owning module: repository tooling).
 *
 * Runs ONLY tools available locally and clearly lists the checks that run exclusively in CI.
 * Exit code is non-zero when any blocking check fails.
 *
 * Local checks:
 *  1. Secret scan (high-signal regexes over all authored files; .env never scanned/packaged).
 *  2. SAST-lite: forbidden sinks (eval, new Function, innerHTML, dangerouslySetInnerHTML,
 *     child_process with shell input) in application code.
 *  3. Raw SQL review gate: every `sql.raw(` must be in the reviewed allowlist.
 *  4. Dependency audit: `pnpm audit` — HIGH/CRITICAL block; moderate/low are reported.
 *  5. SBOM (CycloneDX 1.7) generation → artifacts/sbom.cdx.json.
 *  6. License policy over the SBOM: copyleft (GPL/AGPL/SSPL) in production deps blocks.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { authoredFiles, scanSecrets } from './lib.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const results = [];
const record = (name, ok, detail = '', blocking = true) => results.push({ name, ok, detail, blocking });

const files = authoredFiles();

// 1. Secrets
const secrets = scanSecrets(files);
record('Secret scan', secrets.length === 0, secrets.join('\n'));

// 2. SAST-lite forbidden sinks in application code
const sinks = [
  [/\beval\s*\(/, 'eval('],
  [/new\s+Function\s*\(/, 'new Function('],
  [/\.innerHTML\s*=/, 'innerHTML assignment'],
  [/dangerouslySetInnerHTML\s*=/, 'dangerouslySetInnerHTML'],
  [/execSync\(|exec\(`/, 'shell exec with template'],
];
const sast = [];
for (const f of files.filter((x) => /apps\/(api|web)\/src\/.*\.(ts|tsx)$/.test(x) && !x.endsWith('.test.ts'))) {
  const text = readFileSync(f, 'utf8');
  for (const [re, label] of sinks) if (re.test(text)) sast.push(`${relative(ROOT, f)}: ${label}`);
}
record('SAST-lite forbidden sinks', sast.length === 0, sast.join('\n'));

// 3. Raw SQL review gate
const RAW_SQL_ALLOWLIST = new Map([
  ['apps/api/src/platform/crypto/field-crypto.ts', 'identifiers from ENCRYPTED_FIELDS constant'],
  ['apps/api/src/wms/returns.service.ts', 'column name from constant disposition map'],
  ['apps/api/src/db/cli/verify-restore.ts', 'identifiers from ENCRYPTED_FIELDS constant'],
]);
const raw = [];
for (const f of files.filter((x) => /\.(ts|tsx)$/.test(x))) {
  const rel = relative(ROOT, f).replace(/\\/g, '/');
  if (readFileSync(f, 'utf8').includes('sql.raw(') && !RAW_SQL_ALLOWLIST.has(rel) && !rel.endsWith('.test.ts')) raw.push(rel);
}
record(
  'Raw SQL review gate',
  raw.length === 0,
  raw.length ? `Unreviewed sql.raw in: ${raw.join(', ')}` : `Reviewed: ${[...RAW_SQL_ALLOWLIST.keys()].join(', ')}`,
);

// 4. Dependency audit
const audit = spawnSync('pnpm', ['audit', '--json'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
let counts;
try {
  counts = JSON.parse(audit.stdout).metadata?.vulnerabilities ?? {};
} catch {
  counts = { error: 'audit output not parseable (offline?)' };
}
const blocking = (counts.high ?? 0) + (counts.critical ?? 0);
record('Dependency audit (pnpm audit)', !counts.error && blocking === 0, JSON.stringify(counts));

// 5. SBOM
mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
const sbom = spawnSync('pnpm', ['sbom', '--sbom-format', 'cyclonedx', '--prod'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  shell: process.platform === 'win32',
});
let components = [];
if (sbom.status === 0) {
  writeFileSync(join(ROOT, 'artifacts/sbom.cdx.json'), sbom.stdout);
  components = JSON.parse(sbom.stdout).components ?? [];
}
record(
  'SBOM generation (CycloneDX)',
  sbom.status === 0,
  sbom.status === 0 ? `artifacts/sbom.cdx.json (${components.length} production components)` : sbom.stderr.slice(0, 300),
);

// 6. License policy
const licenseOf = (c) => (c.licenses ?? []).map((l) => l.license?.id ?? l.license?.name ?? l.expression ?? '').join(' OR ') || 'UNKNOWN';
const copyleft = components.filter((c) => /\b(A?GPL|SSPL|EUPL)/i.test(licenseOf(c)) && !/LGPL/.test(licenseOf(c)));
const unknown = components.filter((c) => licenseOf(c) === 'UNKNOWN');
record(
  'License policy (no GPL/AGPL/SSPL in production deps)',
  copyleft.length === 0,
  copyleft.map((c) => `${c.name}@${c.version}: ${licenseOf(c)}`).join('\n'),
);
record('Licenses unknown in SBOM (review)', true, unknown.map((c) => `${c.name}@${c.version}`).join(', ') || 'none', false);

// Report
console.log('\nAutoLemon local security scan\n');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : r.blocking ? 'FAIL' : 'WARN'}  ${r.name}`);
  if (r.detail) console.log(`      ${r.detail.split('\n').join('\n      ')}`);
}
console.log(`
CI-only checks (not executed locally; see .github/workflows/ci.yml and docs/security/CI-CD-SECURITY.md):
  - CodeQL SAST (javascript-typescript)        - gitleaks full-history secret scan
  - Trivy filesystem/IaC/container scanning     - container image build + vulnerability scan
  - OWASP ZAP baseline DAST (staging only)      - dependency review on pull requests
`);
const failed = results.filter((r) => !r.ok && r.blocking);
process.exit(failed.length ? 1 : 0);
