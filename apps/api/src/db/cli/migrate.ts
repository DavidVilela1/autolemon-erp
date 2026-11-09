/**
 * @file CLI: apply database migrations (`pnpm db:migrate`).
 * @module platform/db
 *
 * Uses the OWNER connection (DATABASE_URL). In non-production environments it also ensures the
 * runtime role `autolemon_app` can log in with the password from APP_DATABASE_URL.
 */
import { loadToolEnv, requireEnv } from './env.js';
import { ensureDevAppRoleLogin, migrate } from '../migrator.js';
import { sslOptions } from '../database.js';

await loadToolEnv();
const owner = requireEnv('DATABASE_URL');
const sslMode = (process.env.DB_SSL ?? 'disable') as 'disable' | 'require' | 'verify-full';
const applied = await migrate(owner, { ssl: sslOptions({ DB_SSL: sslMode, DB_SSL_CA_FILE: process.env.DB_SSL_CA_FILE }) });
if (process.env.NODE_ENV !== 'production') {
  await ensureDevAppRoleLogin(owner, requireEnv('APP_DATABASE_URL'));
}
console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database schema is up to date.');
