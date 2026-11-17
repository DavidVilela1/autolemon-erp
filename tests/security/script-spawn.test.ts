/**
 * @file Repository scripts spawn tools through `shellSafe` (scripts/dev-env.mjs), so they work on
 * Windows when a path contains a space (e.g. `C:\Program Files\nodejs\node.exe`, or a user folder
 * such as `C:\Users\Ana Silva`). Regression for the v0.6.10 report: `pnpm test:e2e` failed on
 * Windows with "'C:\Program' is not recognized". Runs a real shell (cmd.exe on Windows, sh elsewhere).
 * @module tests/security
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { shellSafe } from '../../scripts/dev-env.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const win = process.platform === 'win32';
const dir = mkdtempSync(join(tmpdir(), 'al spawn '));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function echoScript(): string {
  const sub = join(dir, 'Program Files');
  mkdirSync(sub, { recursive: true });
  if (win) {
    const f = join(sub, 'echo-args.cmd');
    writeFileSync(f, '@echo off\r\necho ok %~1\r\n');
    return f;
  }
  const f = join(sub, 'echo-args.sh');
  writeFileSync(f, '#!/bin/sh\necho "ok $1"\n');
  chmodSync(f, 0o755);
  return f;
}

describe('Spawning tools through a shell (Windows paths with spaces)', () => {
  it('quotes the command and arguments so a path with a space survives the shell', () => {
    const script = echoScript();
    // Always the Windows quoting, run through the platform's real shell.
    const s = shellSafe(script, ['a b'], 'win32');
    expect(s.shell).toBe(true);
    const r = spawnSync(s.cmd, s.args, { shell: true, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ok a b');
    // The pre-v0.6.10 form (unquoted through a shell) breaks at the space.
    const broken = spawnSync(script, ['a b'], { shell: true, encoding: 'utf8' });
    expect(broken.status).not.toBe(0);
  });

  it('uses no shell outside Windows and refuses arguments it cannot quote safely', () => {
    expect(shellSafe('/usr/bin/x', ['a b'], 'linux')).toEqual({ cmd: '/usr/bin/x', args: ['a b'], shell: false });
    expect(shellSafe('C:\\Program Files\\nodejs\\node.exe', ['--x', 'y&z', ''], 'win32')).toEqual({
      cmd: '"C:\\Program Files\\nodejs\\node.exe"',
      args: ['--x', '"y&z"', '""'],
      shell: true,
    });
    expect(() => shellSafe('x', ['say "hi"'], 'win32')).toThrow(/double quote/);
  });

  it('no repository script spawns a Windows shell without shellSafe', () => {
    const offenders = readdirSync(join(ROOT, 'scripts'))
      .filter((f) => f.endsWith('.mjs') && f !== 'dev-env.mjs') // the helpers themselves live here
      .filter((f) => /process\.platform\s*===\s*'win32'\s*[,;})]/.test(readFileSync(join(ROOT, 'scripts', f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
