/**
 * @file `pnpm backup:local` — encrypted LOCAL demo backup (owning module: operations tooling).
 *
 * 1. pg_dump (custom format) of DATABASE_URL — using the local client when its major version is
 *    ≥ the server's, otherwise `docker compose exec postgres pg_dump` (no data leaves the host).
 * 2. Encrypts the dump with AES-256-GCM using a backup key stored in `.local/backup.key`
 *    (generated on first run, mode 0600, excluded from git and release archives). The key is
 *    deliberately NOT stored next to the backups (`backups/`).
 * 3. Writes a manifest with SHA-256 of plaintext and ciphertext, schema version, timestamps.
 * Never sends anything over the network. This is a DEVELOPMENT demonstration of the production
 * procedure in docs/security/BACKUP_AND_DR.md; it is not an off-site backup.
 */
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { ensureDevEnv, ROOT } from './dev-env.mjs';

/** Loads or creates the local backup key (32 bytes). */
export function backupKey() {
  const dir = join(ROOT, '.local');
  const file = join(dir, 'backup.key');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    console.log('[backup] generated .local/backup.key (DEV ONLY; store production keys in the KMS/vault).');
  }
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error('.local/backup.key must contain 32 base64 bytes');
  return key;
}

/** Decides whether to run pg tools locally or through docker compose. */
export async function pgToolMode(ownerUrl) {
  if (process.env.PG_TOOL_MODE === 'docker' || process.env.PG_TOOL_MODE === 'local') return process.env.PG_TOOL_MODE;
  const local = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (local.status !== 0) return 'docker';
  const clientMajor = Number(/(\d+)\./.exec(local.stdout)?.[1] ?? 0);
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  const serverMajor = Number((await c.query('SHOW server_version_num')).rows[0].server_version_num.slice(0, 2));
  await c.end();
  return clientMajor >= serverMajor ? 'local' : 'docker';
}

/** Runs a pg tool and returns stdout as Buffer. */
export function runPgTool(mode, tool, args, ownerUrl, input) {
  const u = new URL(ownerUrl);
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(u.password) };
  const conn = ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username)];
  const r =
    mode === 'local'
      ? spawnSync(tool, [...conn, ...args], { env, input, maxBuffer: 2 * 1024 ** 3 })
      : spawnSync(
          'docker',
          [
            'compose',
            'exec',
            '-T',
            '-e',
            `PGPASSWORD=${env.PGPASSWORD}`,
            'postgres',
            tool,
            '-h',
            '127.0.0.1',
            '-U',
            decodeURIComponent(u.username),
            ...args,
          ],
          {
            cwd: ROOT,
            input,
            maxBuffer: 2 * 1024 ** 3,
          },
        );
  if (r.status !== 0) throw new Error(`${tool} failed: ${String(r.stderr).slice(0, 500)}`);
  return r.stdout;
}

if (process.argv[1] && process.argv[1].endsWith('backup-local.mjs')) {
  ensureDevEnv();
  const owner = process.env.DATABASE_URL;
  if (!owner) throw new Error('DATABASE_URL required');
  if (process.env.NODE_ENV === 'production') throw new Error('backup:local is a development tool; use the production backup job');
  const dbName = new URL(owner).pathname.slice(1);
  const mode = await pgToolMode(owner);
  const dump = runPgTool(mode, 'pg_dump', ['-Fc', '--no-owner', '--no-acl', '-d', dbName], owner);
  const c = new pg.Client({ connectionString: owner });
  await c.connect();
  const schema = (await c.query('SELECT max(version) AS v FROM schema_migrations')).rows[0].v;
  const serverVersion = (await c.query('SHOW server_version')).rows[0].server_version;
  await c.end();
  const key = backupKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `autolemon-${dbName}-${stamp}`;
  cipher.setAAD(Buffer.from(`autolemon-backup|${base}`));
  const ct = Buffer.concat([nonce, cipher.update(dump), cipher.final(), cipher.getAuthTag()]);
  const dir = join(ROOT, 'backups');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${base}.dump.enc`), ct, { mode: 0o600 });
  const manifest = {
    format: 'autolemon-backup/v1',
    name: base,
    createdAt: new Date().toISOString(),
    database: dbName,
    serverVersion,
    schemaVersion: schema,
    toolMode: mode,
    cipher: 'AES-256-GCM (nonce||ciphertext||tag), AAD=autolemon-backup|<name>',
    keyRef: '.local/backup.key (dev only)',
    plaintextSha256: createHash('sha256').update(dump).digest('hex'),
    ciphertextSha256: createHash('sha256').update(ct).digest('hex'),
    bytes: ct.length,
    offsite: 'NOT CONFIGURED — local demonstration only',
  };
  writeFileSync(join(dir, `${base}.manifest.json`), JSON.stringify(manifest, null, 2));
  console.log(`[backup] wrote backups/${base}.dump.enc (${ct.length} bytes) and manifest. Off-site copy: NOT CONFIGURED.`);
}
