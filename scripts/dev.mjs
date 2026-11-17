/**
 * @file `pnpm dev` — starts API (tsx watch) and web (Vite) for local development
 * (owning module: repository tooling). Requires `pnpm db:migrate` (and optionally
 * `pnpm db:seed`) beforehand and a running PostgreSQL (docker compose up -d).
 */
import { spawn } from 'node:child_process';
import { ensureDevEnv, shellSafe } from './dev-env.mjs';

ensureDevEnv();
const pnpm = (pkg) => {
  const s = shellSafe('pnpm', ['--filter', pkg, 'dev']);
  return spawn(s.cmd, s.args, { stdio: 'inherit', env: process.env, shell: s.shell });
};
const procs = [pnpm('@autolemon/api'), pnpm('@autolemon/web')];
console.log(`\nAutoLemon dev: web http://localhost:5173  (API http://127.0.0.1:${process.env.API_PORT ?? 3000}, proxied under /api)\n`);
const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && code !== 0 && stop());
