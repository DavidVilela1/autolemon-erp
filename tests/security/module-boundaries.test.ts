/**
 * @file Module-boundary rules (review finding R-16) are real ESLint errors, not convention:
 * lints synthetic files at the guarded locations and expects `no-restricted-imports` to fire,
 * so removing or weakening a rule in eslint.config.js fails this test.
 * @module tests/security
 */
import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: resolve(import.meta.dirname, '../..') });

async function restricted(filePath: string, code: string): Promise<string[]> {
  const [r] = await eslint.lintText(code, { filePath: resolve(import.meta.dirname, '../..', filePath) });
  return (r?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
}

describe('module boundaries', () => {
  it('WMS cannot import the HTTP layer or platform auth/admin/tenant internals', async () => {
    const m = await restricted(
      'apps/api/src/wms/probe.ts',
      "import { a } from '../http/http-util.js';\nimport { b } from '../platform/auth/auth.service.js';\nimport { c } from '../platform/tenant/provision.js';\nexport const x = [a, b, c];\n",
    );
    expect(m).toHaveLength(3);
  });

  it('WMS may use platform authz, audit and crypto', async () => {
    const m = await restricted(
      'apps/api/src/wms/probe.ts',
      "import { a } from '../platform/authz/actor.js';\nimport { b } from '../platform/audit/audit.service.js';\nimport { c } from '../platform/crypto/field-crypto.js';\nexport const x = [a, b, c];\n",
    );
    expect(m).toEqual([]);
  });

  it('platform, db and common code cannot import business modules or the HTTP layer', async () => {
    for (const f of ['apps/api/src/platform/probe.ts', 'apps/api/src/db/probe.ts', 'apps/api/src/common/probe.ts']) {
      const m = await restricted(
        f,
        "import { a } from '../wms/runner.js';\nimport { b } from '../http/auth.guard.js';\nexport const x = [a, b];\n",
      );
      expect(m, f).toHaveLength(2);
    }
  });

  it('the web client cannot import API code or server-only modules; contracts cannot import apps', async () => {
    const web = await restricted(
      'apps/web/src/probe.ts',
      "import { a } from '../../api/src/composition.js';\nimport pg from 'pg';\nimport { b } from 'node:crypto';\nexport const x = [a, pg, b];\n",
    );
    expect(web).toHaveLength(3);
    const contracts = await restricted('packages/contracts/src/probe.ts', "import { a } from '@autolemon/api';\nexport const x = a;\n");
    expect(contracts).toHaveLength(1);
  });
});
