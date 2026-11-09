/**
 * @file Vitest workspace configuration (owning module: repository tooling).
 * Projects: unit (pure, no DB), integration (real Postgres, acceptance flows), security
 * (negative/attack tests, real Postgres). DB projects run sequentially in one fork because
 * they share one disposable database created by scripts/with-test-db.mjs.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { decorator: { legacy: true } },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['apps/api/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'security',
          include: ['tests/security/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
