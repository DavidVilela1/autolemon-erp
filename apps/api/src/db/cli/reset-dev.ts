/**
 * @file CLI: destroy and recreate the DEVELOPMENT database schema (`pnpm db:reset:dev`).
 * @module platform/db
 *
 * Safety interlocks (all must pass, otherwise it refuses):
 *  - NODE_ENV must be `development` or `test`;
 *  - database host must be localhost / 127.0.0.1 / ::1;
 *  - database name must start with `autolemon` and must not contain `prod`;
 *  - the database must not contain the production marker table `_production_marker`.
 */
import pg from 'pg';
import { loadToolEnv, requireEnv } from './env.js';
import { ensureDevAppRoleLogin, migrate } from '../migrator.js';

await loadToolEnv();
const owner = requireEnv('DATABASE_URL');
const url = new URL(owner);
const dbName = url.pathname.replace(/^\//, '');
const env = process.env.NODE_ENV ?? 'development';
const problems: string[] = [];
if (!['development', 'test'].includes(env)) problems.push(`NODE_ENV=${env}`);
if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) problems.push(`host ${url.hostname} is not local`);
if (!/^autolemon/.test(dbName) || /prod/i.test(dbName)) problems.push(`database name "${dbName}" not a dev database`);
if (problems.length) {
  console.error(`Refusing to reset: ${problems.join('; ')}`);
  process.exit(3);
}
const client = new pg.Client({ connectionString: owner });
await client.connect();
const marker = await client.query(`SELECT to_regclass('public._production_marker') AS t`);
if (marker.rows[0]?.t) {
  console.error('Refusing to reset: production marker table present');
  process.exit(3);
}
await client.query('DROP SCHEMA public CASCADE');
await client.query('CREATE SCHEMA public');
await client.end();
const applied = await migrate(owner);
await ensureDevAppRoleLogin(owner, requireEnv('APP_DATABASE_URL'));
console.log(`Development database reset. Applied: ${applied.join(', ')}`);
