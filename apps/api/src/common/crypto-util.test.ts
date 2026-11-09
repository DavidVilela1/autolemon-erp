/**
 * @file Unit tests: canonical JSON, base32 (property-based), audit redaction and nesting rules.
 * @module platform/common
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, canonicalJson, randomToken } from './crypto-util.js';
import { redactDetails } from '../platform/audit/audit.service.js';
import { holdsStockFor, nestingError } from '../wms/topology.service.js';

describe('crypto utilities', () => {
  it('canonicalJson is independent of key order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 8 }), fc.oneof(fc.integer(), fc.string(), fc.boolean())), (o) => {
        const reversed = Object.fromEntries(Object.entries(o).reverse());
        return canonicalJson(o) === canonicalJson(reversed);
      }),
    );
  });
  it('base32 round-trips arbitrary bytes', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 64 }),
        (b) => Buffer.compare(base32Decode(base32Encode(Buffer.from(b))), Buffer.from(b)) === 0,
      ),
    );
    expect(() => base32Decode('abc1')).toThrow();
  });
  it('random tokens are 256-bit url-safe and unique', () => {
    const s = new Set(Array.from({ length: 1000 }, randomToken));
    expect(s.size).toBe(1000);
    [...s].forEach((x) => expect(x).toMatch(/^[A-Za-z0-9_-]{43}$/));
  });
});

describe('audit redaction', () => {
  it('removes secrets and PII-like keys but keeps operational identifiers', () => {
    const r = redactDetails({
      password: 'x',
      sessionToken: 'y',
      code: '123456',
      phone: '+351',
      email: 'a@b',
      reasonCode: 'LOSS',
      qtyDelta: '-1',
      warehouseCode: 'PORTO',
    });
    expect(r).toEqual({
      password: '[REDACTED]',
      sessionToken: '[REDACTED]',
      code: '[REDACTED]',
      phone: '[REDACTED]',
      email: '[REDACTED]',
      reasonCode: 'LOSS',
      qtyDelta: '-1',
      warehouseCode: 'PORTO',
    });
  });
});

describe('topology nesting rules', () => {
  it('allows supported hierarchies and rejects unsupported nesting', () => {
    expect(nestingError('AISLE', 'ZONE')).toBeUndefined();
    expect(nestingError('BIN', 'SHELF')).toBeUndefined();
    expect(nestingError('STAGING', null)).toBeUndefined();
    expect(nestingError('ZONE', 'ZONE')).toBeDefined();
    expect(nestingError('SHELF', 'BIN')).toBeDefined();
    expect(nestingError('BIN', null)).toBeDefined();
    expect(nestingError('DISPATCH', 'RACK')).toBeDefined();
  });
  it('structural nodes never hold stock; shelves may', () => {
    expect(() => holdsStockFor('RACK', true)).toThrow();
    expect(holdsStockFor('RACK')).toBe(false);
    expect(holdsStockFor('SHELF', false)).toBe(false);
    expect(holdsStockFor('BIN')).toBe(true);
  });
});
