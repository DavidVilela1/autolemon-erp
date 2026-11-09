/**
 * @file `pnpm restore:smoke` — restore the latest encrypted local backup into a DISPOSABLE
 * database and verify it (owning module: operations tooling).
 *
 * Safety: always restores into a freshly created `autolemon_restore_smoke_<random>` database and
 * drops it afterwards; it never writes to the source database. Verification:
 *  - ciphertext checksum (manifest) → authenticated decryption (GCM tag) → plaintext checksum;
 *  - schema_migrations matches the migration files of this build;
 *  - inventory ledger reconciles with balances, reservations reconcile;
 *  - security audit hash chains verify for every tenant;
 *  - encrypted fields (TOTP seeds, PII) decrypt with the CURRENT key provider (key access).
 * If no backup exists, one is created first with `pnpm backup:local`.
 * Measured duration is printed as evidence for the RTO log (docs/security/BACKUP_AND_DR.md).
 */
import { spawnSync } from 'node:child_process';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { backupKey, pgToolMode, runPgTool } from './backup-local.mjs';
import { ensureDevEnv, ROOT } from './dev-env.mjs';

const t0 = Date.now();
ensureDevEnv();
const owner = process.env.DATABASE_URL;
if (!owner) throw new Error('DATABASE_URL required');
const dir = join(ROOT, 'backups');
const latest = () =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.manifest.json'))
        .sort()
        .pop()
    : undefined;
let manifestFile = process.argv[2] ?? latest();
if (!manifestFile) {
  console.log('[restore] no backup found; creating one with backup:local');
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/backup-local.mjs')], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(1);
  manifestFile = latest();
}
const manifest = JSON.parse(readFileSync(join(dir, manifestFile), 'utf8'));
const ct = readFileSync(join(dir, `${manifest.name}.dump.enc`));
if (createHash('sha256').update(ct).digest('hex') !== manifest.ciphertextSha256) throw new Error('ciphertext checksum mismatch');
const key = backupKey();
const decipher = createDecipheriv('aes-256-gcm', key, ct.subarray(0, 12));
decipher.setAAD(Buffer.from(`autolemon-backup|${manifest.name}`));
decipher.setAuthTag(ct.subarray(ct.length - 16));
const dump = Buffer.concat([decipher.update(ct.subarray(12, ct.length - 16)), decipher.final()]);
if (createHash('sha256').update(dump).digest('hex') !== manifest.plaintextSha256) throw new Error('plaintext checksum mismatch');
console.log(`[restore] ${manifest.name}: checksums OK, GCM authentication OK`);

const target = `autolemon_restore_smoke_${randomBytes(4).toString('hex')}`;
const admin = new pg.Client({ connectionString: owner });
await admin.connect();
await admin.query(`CREATE DATABASE ${target}`); // generated name [a-z0-9_]
await admin.end();
const targetUrl = (() => {
  const u = new URL(owner);
  u.pathname = `/${target}`;
  return u.toString();
})();
let ok;
try {
  const mode = await pgToolMode(owner);
  runPgTool(mode, 'pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '-d', target], owner, dump);
  const v = spawnSync(
    resolve(ROOT, 'node_modules/.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx'),
    ['--tsconfig', 'apps/api/tsconfig.json', 'apps/api/src/db/cli/verify-restore.ts'],
    {
      cwd: ROOT,
      env: { ...process.env, SKIP_DOTENV: '1', RESTORE_DATABASE_URL: targetUrl },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );
  ok = v.status === 0;
} finally {
  const c = new pg.Client({ connectionString: owner });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`);
  await c.end();
  console.log(`[restore] disposable database ${target} dropped`);
}
console.log(`[restore] ${ok ? 'PASSED' : 'FAILED'} in ${((Date.now() - t0) / 1000).toFixed(1)} s (measured; not an RTO claim)`);
process.exit(ok ? 0 : 1);
