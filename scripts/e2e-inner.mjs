/**
 * @file Starts API + Vite against the disposable DB, provisions a tenant, runs Playwright,
 * then stops everything (owning module: repository tooling). Invoked via run-e2e.mjs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { ROOT } from './dev-env.mjs';

const bin = (n) => resolve(ROOT, 'node_modules/.bin', process.platform === 'win32' ? `${n}.cmd` : n);
const API_PORT = process.env.E2E_API_PORT ?? '3901';
const WEB_PORT = process.env.E2E_WEB_PORT ?? '5199';
const env = {
  ...process.env,
  NODE_ENV: 'test',
  API_PORT,
  WEB_PORT,
  VITE_API_TARGET: `http://127.0.0.1:${API_PORT}`,
  WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
  LOCAL_DEV_KEKS: `e2e-kek:${randomBytes(32).toString('base64')}`,
  CSRF_SECRET: randomBytes(32).toString('base64'),
  LOG_LEVEL: 'warn',
};
const procs = [];
const start = (cmd, args, cwd) => {
  const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
  procs.push(p);
  return p;
};
async function waitFor(url, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${url}`);
}
let status = 1;
try {
  start(bin('tsx'), ['--tsconfig', 'apps/api/tsconfig.json', 'apps/api/src/main.ts'], ROOT);
  start(bin('vite'), ['--logLevel', 'warn'], resolve(ROOT, 'apps/web'));
  await waitFor(`http://127.0.0.1:${API_PORT}/api/health`);
  await waitFor(`http://localhost:${WEB_PORT}/`);
  const prov = spawnSync(bin('tsx'), ['--tsconfig', 'apps/api/tsconfig.json', 'tests/e2e/provision.ts'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (prov.status !== 0) throw new Error(`provision failed: ${prov.stderr}`);
  const { token, email } = JSON.parse(prov.stdout.trim().split('\n').pop());
  const r = spawnSync(bin('playwright'), ['test', '-c', 'tests/e2e/playwright.config.ts'], {
    cwd: ROOT,
    env: { ...env, E2E_INVITE: token, E2E_EMAIL: email, E2E_BASE_URL: `http://localhost:${WEB_PORT}` },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  status = r.status ?? 1;
} catch (e) {
  console.error(String(e));
} finally {
  for (const p of procs) p.kill('SIGTERM');
}
process.exit(status);
