/**
 * @file Property-based tests for exact decimal quantity arithmetic.
 * @module wms/inventory
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canon, cmp, fromMilli, sub, sum, toMilli } from './qty.js';

const milli = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });

describe('qty (bigint milli-units)', () => {
  it('fromMilli/toMilli round-trip for any value', () => {
    fc.assert(fc.property(milli, (m) => toMilli(fromMilli(m)) === m));
  });
  it('sum and sub are exact (no floating point drift)', () => {
    fc.assert(fc.property(fc.array(milli, { maxLength: 50 }), (xs) => toMilli(sum(xs.map(fromMilli))) === xs.reduce((a, b) => a + b, 0n)));
    expect(sum(['0.1', '0.2'])).toBe('0.3');
    expect(sub('10', '0.001')).toBe('9.999');
  });
  it('cmp is a total order consistent with bigint', () => {
    fc.assert(fc.property(milli, milli, (a, b) => cmp(fromMilli(a), fromMilli(b)) === (a < b ? -1 : a > b ? 1 : 0)));
  });
  it('canonicalises database numerics and rejects garbage', () => {
    expect(canon('12.000')).toBe('12');
    expect(canon('0.500')).toBe('0.5');
    expect(() => toMilli('1e3')).toThrow();
    expect(() => toMilli('1.0001')).toThrow();
  });
});
