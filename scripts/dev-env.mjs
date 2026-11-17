/**
 * @file Loads .env and generates missing development secrets (owning module: repository tooling).
 *
 * Replaces `__GENERATE__` placeholders in .env with fresh CSPRNG values (dev KEK keyring and
 * CSRF secret) so no key material ever lives in the repository or the release archive.
 * Refuses to generate anything when NODE_ENV=production.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Repository root (scripts/..). */
export const ROOT = resolve(import.meta.dirname, '..');

/**
 * Spawn arguments that also work on Windows. There the `pnpm`, `tsx`, `vitest`… shims are `.cmd`
 * files that need a shell, and Node then joins command and arguments with plain spaces, so a
 * path such as `C:\Program Files\nodejs\node.exe` breaks at the space. On Windows every token
 * that contains a space or a cmd.exe metacharacter is double-quoted; elsewhere no shell is used.
 * @param {string} cmd
 * @param {readonly string[]} args
 * @param {string} [platform]
 * @returns {{ cmd: string, args: string[], shell: boolean }}
 */
export function shellSafe(cmd, args, platform = process.platform) {
  if (platform !== 'win32') return { cmd, args: [...args], shell: false };
  const q = (s) => {
    const v = String(s);
    if (v.includes('"')) throw new Error(`shellSafe: double quote in argument is not supported: ${v}`);
    return /[\s&|<>^()]/.test(v) || v === '' ? `"${v}"` : v;
  };
  return { cmd: q(cmd), args: args.map(q), shell: true };
}

/**
 * Starts a long-running tool (server) so that `killTree` can later stop it together with every
 * process it started. On POSIX the child leads its own process group; on Windows it runs through
 * `shellSafe` (`.cmd` shims) and is stopped with `taskkill /T`.
 * @param {string} cmd
 * @param {readonly string[]} args
 * @param {import('node:child_process').SpawnOptions} [opts]
 * @returns {import('node:child_process').ChildProcess}
 */
export function startTree(cmd, args, opts = {}) {
  const s = shellSafe(cmd, args);
  return spawn(s.cmd, s.args, { ...opts, shell: s.shell, detached: process.platform !== 'win32' });
}

/**
 * Stops a process started with `startTree` and all its descendants. Killing only the direct child
 * is not enough: on Windows that is the cmd.exe wrapper, and `tsx` runs the program in a child
 * Node process, so the real server would be left running (seen on Windows in v0.6.11).
 * @param {import('node:child_process').ChildProcess} child
 */
export function killTree(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

/**
 * Parses a dotenv file (KEY=VALUE, # comments). Values are taken literally (no expansion).
 * @param {string} file
 * @returns {Record<string,string>}
 */
export function parseEnvFile(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Ensures .env exists with generated dev secrets and loads it into process.env (existing
 * environment variables win, so CI can inject its own values).
 * @returns {Record<string,string>} merged environment
 */
export function ensureDevEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) {
    throw new Error('.env not found. Run: cp .env.example .env  (PowerShell: Copy-Item .env.example .env)');
  }
  let text = readFileSync(envPath, 'utf8');
  if (text.includes('__GENERATE__')) {
    if ((process.env.NODE_ENV ?? parseEnvFile(envPath).NODE_ENV) === 'production') {
      throw new Error('Refusing to generate secrets for NODE_ENV=production');
    }
    text = text
      .replace('LOCAL_DEV_KEKS=__GENERATE__', `LOCAL_DEV_KEKS=dev-kek-${Date.now().toString(36)}:${randomBytes(32).toString('base64')}`)
      .replace('CSRF_SECRET=__GENERATE__', `CSRF_SECRET=${randomBytes(32).toString('base64')}`);
    writeFileSync(envPath, text, { mode: 0o600 });
    console.log('[dev-env] Generated development-only secrets in .env (never commit this file).');
  }
  const parsed = parseEnvFile(envPath);
  for (const [k, v] of Object.entries(parsed)) if (process.env[k] === undefined) process.env[k] = v;
  return { ...parsed, ...process.env };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureDevEnv();
  console.log('[dev-env] .env ready');
}
