/**
 * @file Unit + property tests for CSV export encoding and strict import parsing.
 * @module platform/common
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { csvCell, CsvError, isFormulaLike, parseCsv, toCsv } from './csv.js';

describe('CSV export', () => {
  it('neutralises formula-leading cells and escapes quotes', () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('+SUM(A1)')).toBe(`"'+SUM(A1)"`);
    expect(csvCell('-2+3')).toBe(`"'-2+3"`); // Excel would evaluate this
    expect(csvCell('-2.000')).toBe(`"-2.000"`); // a plain number cannot be a formula: stays numeric
    expect(csvCell('-1e5')).toBe(`"'-1e5"`);
    expect(csvCell('@cmd')).toBe(`"'@cmd"`);
    expect(csvCell('a"b')).toBe(`"a""b"`);
    expect(csvCell(null)).toBe('""');
  });
  it('round-trips through the parser for arbitrary non-formula text (property)', () => {
    const cell = fc.string({ maxLength: 40 }).filter((s) => !isFormulaLike(s) && !s.includes('\u0000') && !s.includes('\r'));
    fc.assert(
      fc.property(fc.array(fc.array(cell, { minLength: 2, maxLength: 4 }), { minLength: 1, maxLength: 10 }), (rows) => {
        const header = rows[0]!.map((_, i) => `c${i}`);
        const width = header.length;
        const body = rows.map((r) => [...r, ...Array(width).fill('')].slice(0, width));
        const parsed = parseCsv(toCsv([header, ...body]));
        const norm = (r: string[]) => r.map((c) => c.replace(/\n/g, '\n'));
        return JSON.stringify(parsed.slice(1).map(norm)) === JSON.stringify(body.map(norm).filter((r) => !(r.length === 1 && r[0] === '')));
      }),
      { numRuns: 200 },
    );
  });
});

describe('CSV import limits', () => {
  it('enforces bytes, rows, columns, cell length, NUL and quoting', () => {
    expect(() => parseCsv('a,b\n"x', undefined)).toThrow(CsvError);
    expect(() => parseCsv('a\u0000')).toThrow(CsvError);
    expect(() => parseCsv('a,b\nx"y,1')).toThrow(CsvError);
    expect(() => parseCsv('h\n' + 'x\n'.repeat(3000))).toThrow(/Demasiadas linhas/);
    expect(() => parseCsv(Array(20).fill('x').join(','))).toThrow(/colunas/);
    expect(() => parseCsv('a\n' + 'y'.repeat(400))).toThrow(/longa/);
    expect(parseCsv('a;b\r\n1;"2;3"\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2;3'],
    ]);
  });
});
