/**
 * @file Unit tests for the PostgreSQL → domain error mapping (owning module: common).
 * @module apps/api/common
 */
import { describe, expect, it } from 'vitest';
import { translatePgError } from './errors.js';

const map = (code: string) => {
  const e = translatePgError({ code });
  return e ? { status: e.status, code: e.code } : undefined;
};

describe('translatePgError', () => {
  it('maps transient database conditions to a clear, retryable 503 (never a generic 500)', () => {
    expect(map('40P01')).toEqual({ status: 503, code: 'BUSY_RETRY' }); // deadlock after the retries
    expect(map('40001')).toEqual({ status: 503, code: 'BUSY_RETRY' }); // serialization failure
    expect(map('57014')).toEqual({ status: 503, code: 'QUERY_TIMEOUT' }); // statement timeout
  });

  it('keeps the existing constraint mappings and leaves unknown codes to the generic handler', () => {
    expect(map('23505')).toEqual({ status: 409, code: 'DUPLICATE' });
    expect(map('XX000')).toBeUndefined();
  });
});
