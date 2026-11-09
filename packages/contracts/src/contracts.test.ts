/**
 * @file Unit tests: shared validation contracts (strictness, normalisation, rejection).
 * @module contracts
 */
import { describe, expect, it } from 'vitest';
import { Code, CreateSkuInput, HolderRef, Qty, SafeLine, Uuid } from './index.js';

describe('contracts', () => {
  it('normalises and bounds quantities', () => {
    expect(Qty.parse('007.500')).toBe('7.5');
    expect(Qty.parse(12)).toBe('12');
    for (const bad of [0, -1, '1.2345', 'abc', '1e5', 2e9, Number.NaN]) expect(Qty.safeParse(bad).success).toBe(false);
  });
  it('codes are upper-cased and formula-safe', () => {
    expect(Code.parse(' brk-001 ')).toBe('BRK-001');
    for (const bad of ['=1', '+A', '-A', '@A', 'A B', '', 'x'.repeat(41)]) expect(Code.safeParse(bad).success).toBe(false);
  });
  it('rejects control characters but keeps markup as literal text', () => {
    expect(SafeLine(50).safeParse('a\nb').success).toBe(false);
    expect(SafeLine(50).parse('<b>x</b>')).toBe('<b>x</b>');
  });
  it('requires canonical UUIDs and exactly one holder', () => {
    expect(Uuid.safeParse('A0000000-0000-0000-0000-000000000000').success).toBe(false);
    expect(HolderRef.safeParse({}).success).toBe(false);
    expect(
      HolderRef.safeParse({ nodeId: '00000000-0000-4000-8000-000000000000', containerId: '00000000-0000-4000-8000-000000000001' }).success,
    ).toBe(false);
  });
  it('strict DTOs reject unknown fields (mass assignment)', () => {
    expect(CreateSkuInput.safeParse({ code: 'A', description: 'x', companyId: 'evil' }).success).toBe(false);
  });
});
