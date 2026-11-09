/**
 * @file `pnpm dev` — starts API (tsx watch) and web (Vite) for local development
 * (owning module: repository tooling). Requires `pnpm db:migrate` (and optionally
 * `pnpm db:seed`) beforehand and a running PostgreSQL (docker compose up -d).
 */
import { spawn } from 'node:child_process';
import { ensureDevEnv } from './dev-env.mjs';

ensureDevEnv();
const shell = process.platform === 'win32';
const procs = [
  spawn('pnpm', ['--filter', '@autolemon/api', 'dev'], { stdio: 'inherit', env: process.env, shell }),
  spawn('pnpm', ['--filter', '@autolemon/web', 'dev'], { stdio: 'inherit', env: process.env, shell }),
];
console.log(`\nAutoLemon dev: web http://localhost:5173  (API http://127.0.0.1:${process.env.API_PORT ?? 3000}, proxied under /api)\n`);
const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && code !== 0 && stop());
