/**
 * @file Playwright configuration (owning module: tests/e2e). Servers are started by
 * scripts/e2e-inner.mjs; this config only points the browser at them.
 * Set PLAYWRIGHT_CHROME_PATH to use a system Chrome; otherwise run
 * `pnpm exec playwright install chromium` once.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]],
  outputDir: '../../test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5199',
    locale: 'pt-PT',
    timezoneId: 'Europe/Lisbon',
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {},
  },
});
