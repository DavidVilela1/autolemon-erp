/**
 * @file Runs a command against a fresh, disposable PostgreSQL database (owning module: tooling).
 *
 * 1. Loads .env (or CI-provided env) to obtain the OWNER connection (DATABASE_URL).
 * 2. Creates database `autolemon_test_<random>` on the same server, runs all migrations.
 * 3. Executes the given command with DATABASE_URL / APP_DATABASE_URL pointing at it.
 * 4. Drops the database (WITH FORCE) afterwards, whatever the outcome.
 * Never touches the developer's main database.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { ensureDevEnv, ROOT } from './dev-env.mjs';

if (existsSync(resolve(ROOT, '.env'))) ensureDevEnv();
const owner = process.env.DATABASE_URL;
const app = process.env.APP_DATABASE_URL;
if (!owner || !app) {
  console.error('DATABASE_URL and APP_DATABASE_URL are required (copy .env.example to .env).');
  process.exit(2);
}
const dbName = `autolemon_test_${randomBytes(4).toString('hex')}`;
const ownerUrl = new URL(owner);
const admin = new pg.Client({ connectionString: owner });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`); // name is generated locally: [a-z0-9_] only
await admin.end();

const withDb = (u) => {
  const x = new URL(u);
  x.pathname = `/${dbName}`;
  return x.toString();
};
const env = {
  ...process.env,
  NODE_ENV: 'test',
  SKIP_DOTENV: '1',
  DATABASE_URL: withDb(owner),
  APP_DATABASE_URL: withDb(app),
  TEST_OWNER_URL: withDb(owner),
  LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
  ARGON2_MEMORY_KIB: '19456',
  ARGON2_ITERATIONS: '2',
};
let status = 1;
try {
  const mig = spawnSync('pnpm', ['--filter', '@autolemon/api', 'db:migrate'], {
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (mig.status !== 0) throw new Error('migration failed');
  const [cmd, ...args] = process.argv.slice(2);
  const r = spawnSync(cmd === 'vitest' ? resolve(ROOT, 'node_modules/.bin/vitest') : cmd, args, {
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  status = r.status ?? 1;
} catch (e) {
  console.error(String(e));
} finally {
  const c = new pg.Client({ connectionString: owner });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await c.end();
  console.log(`[with-test-db] dropped ${dbName} on ${ownerUrl.hostname}`);
}
process.exit(status);
