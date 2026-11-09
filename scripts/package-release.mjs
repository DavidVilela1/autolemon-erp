/**
 * @file `pnpm release:zip` — builds the versioned handover archive (owning module: tooling).
 *
 * Output (artifacts/): AutoLemon-ERP-v<version>-WMS.zip with root folder `autolemon-erp/`,
 * `<zip>.sha256` (sha256sum format) and `<name>.manifest.json` (every file + SHA-256).
 * Excludes .env, .local (keys), backups, node_modules, dist, .git, test outputs and artifacts.
 * Aborts if the staged copy fails the secret scan. Requires the `zip` CLI.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { authoredFiles, EXCLUDED_DIRS, scanSecrets } from './lib.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const name = `AutoLemon-ERP-v${version}-WMS`;
const stage = mkdtempSync(join(tmpdir(), 'autolemon-release-'));
const rootDir = join(stage, 'autolemon-erp');
const files = authoredFiles(ROOT).filter((f) => !/\.log$/.test(f));
for (const f of files) {
  const dest = join(rootDir, relative(ROOT, f));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(f, dest);
}
if (existsSync(join(ROOT, 'artifacts/sbom.cdx.json'))) {
  mkdirSync(join(rootDir, 'docs/sbom'), { recursive: true });
  copyFileSync(join(ROOT, 'artifacts/sbom.cdx.json'), join(rootDir, 'docs/sbom/sbom.cdx.json'));
}
const leaks = scanSecrets(authoredFiles(rootDir), rootDir);
if (leaks.length || existsSync(join(rootDir, '.env'))) {
  console.error(`Refusing to package: ${leaks.join(', ') || '.env present'}`);
  process.exit(1);
}
const manifestFiles = authoredFiles(rootDir)
  .map((f) => ({
    path: `autolemon-erp/${relative(rootDir, f).replace(/\\/g, '/')}`,
    sha256: createHash('sha256').update(readFileSync(f)).digest('hex'),
  }))
  .sort((a, b) => a.path.localeCompare(b.path));
mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
const zipPath = join(ROOT, 'artifacts', `${name}.zip`);
rmSync(zipPath, { force: true });
const z = spawnSync('zip', ['-q', '-r', '-X', zipPath, 'autolemon-erp'], { cwd: stage });
if (z.status !== 0) throw new Error(`zip failed: ${z.stderr}`);
const hash = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
writeFileSync(`${zipPath}.sha256`, `${hash}  ${name}.zip\n`);
writeFileSync(
  join(ROOT, 'artifacts', `${name}.manifest.json`),
  JSON.stringify(
    {
      archive: `${name}.zip`,
      version,
      sha256: hash,
      createdAt: new Date().toISOString(),
      root: 'autolemon-erp/',
      excluded: [...EXCLUDED_DIRS, '.env'],
      fileCount: manifestFiles.length,
      files: manifestFiles,
    },
    null,
    2,
  ),
);
rmSync(stage, { recursive: true, force: true });
console.log(`artifacts/${name}.zip  (${manifestFiles.length} files)\nSHA-256 ${hash}`);
