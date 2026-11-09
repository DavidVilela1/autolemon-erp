/**
 * @file Unit tests: configuration validation and production safety interlocks.
 * @module platform/config
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig, trustProxySetting } from './env.js';

const base = {
  APP_DATABASE_URL: 'postgres://u:p@localhost/db',
  LOCAL_DEV_KEKS: `k1:${randomBytes(32).toString('base64')}`,
  CSRF_SECRET: randomBytes(32).toString('base64'),
};

describe('loadConfig', () => {
  it('accepts a development configuration', () => {
    expect(loadConfig(base).KEY_PROVIDER).toBe('local-dev');
  });
  it('rejects malformed values', () => {
    expect(() => loadConfig({ ...base, CSRF_SECRET: 'short' })).toThrow(/CSRF_SECRET/);
    expect(() => loadConfig({ ...base, ARGON2_MEMORY_KIB: '1024' })).toThrow();
  });
  it('enforces production interlocks', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        KEY_PROVIDER: 'external-kms',
        DB_SSL: 'verify-full',
        WEB_ORIGIN: 'https://erp.example',
        TRUST_PROXY: 'true',
      }),
    ).toThrow(/TRUST_PROXY=true is forbidden/);
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        KEY_PROVIDER: 'external-kms',
        DB_SSL: 'verify-full',
        WEB_ORIGIN: 'https://erp.example',
        COOKIE_SECURE: 'false',
      }),
    ).toThrow(/COOKIE_SECURE/);
    expect(
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        KEY_PROVIDER: 'external-kms',
        DB_SSL: 'verify-full',
        WEB_ORIGIN: 'https://erp.example',
      }).NODE_ENV,
    ).toBe('production');
  });
  it('parses trusted proxy lists', () => {
    expect(trustProxySetting(loadConfig(base))).toBe(false);
    expect(trustProxySetting(loadConfig({ ...base, TRUST_PROXY: '10.0.0.5, 10.0.1.0/24' }))).toEqual(['10.0.0.5', '10.0.1.0/24']);
  });
});
