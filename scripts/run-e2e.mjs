/**
 * @file `pnpm test:e2e`: runs the browser E2E suite on a disposable database (owning module:
 * repository tooling). Requires a Chromium: PLAYWRIGHT_CHROME_PATH or
 * `pnpm exec playwright install chromium`.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT } from './dev-env.mjs';

const r = spawnSync(
  process.execPath,
  [resolve(ROOT, 'scripts/with-test-db.mjs'), process.execPath, resolve(ROOT, 'scripts/e2e-inner.mjs')],
  {
    stdio: 'inherit',
    env: process.env,
  },
);
process.exit(r.status ?? 1);
