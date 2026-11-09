/**
 * @file Safe CSV export encoding and strict CSV import parsing.
 * @module platform/common
 *
 * Export: every cell is quoted; quotes are doubled; cells beginning with a spreadsheet formula
 * trigger (= + - @ TAB CR) are prefixed with an apostrophe (OWASP CSV Injection guidance), so
 * opening the file in Excel/LibreOffice never evaluates attacker-controlled formulas.
 * Import: RFC 4180 subset with hard limits on bytes, rows and columns; formula-leading cells
 * are rejected rather than silently altered.
 */

/** UTF-8 byte-order mark (helps Excel detect UTF-8). */
const BOM = String.fromCharCode(0xfeff);

/** Characters that make spreadsheet software interpret a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Encodes one CSV cell safely. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Encodes rows (first row = header) as CSV with CRLF line endings and a UTF-8 BOM for Excel. */
export function toCsv(rows: unknown[][]): string {
  return BOM + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

/** Limits applied to CSV imports. */
export interface CsvLimits {
  maxBytes: number;
  maxRows: number;
  maxCols: number;
  maxCellChars: number;
}

/** Default import limits. */
export const DEFAULT_CSV_LIMITS: CsvLimits = { maxBytes: 1_000_000, maxRows: 2000, maxCols: 12, maxCellChars: 300 };

/** Thrown for structurally invalid CSV (bad quoting, limits exceeded). */
export class CsvError extends Error {}

/**
 * Parses CSV text with `,` or `;` delimiter (auto-detected from the header line).
 * @returns array of rows (arrays of strings). The header row is included.
 */
export function parseCsv(text: string, limits: CsvLimits = DEFAULT_CSV_LIMITS): string[][] {
  if (Buffer.byteLength(text, 'utf8') > limits.maxBytes) throw new CsvError('Ficheiro demasiado grande');
  if (text.includes('\u0000')) throw new CsvError('Ficheiro binário ou corrompido');
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  const pushCell = () => {
    if (cell.length > limits.maxCellChars) throw new CsvError(`Célula demasiado longa na linha ${out.length + 1}`);
    row.push(cell);
    cell = '';
    if (row.length > limits.maxCols) throw new CsvError(`Demasiadas colunas na linha ${out.length + 1}`);
  };
  const pushRow = () => {
    pushCell();
    if (!(row.length === 1 && row[0] === '')) out.push(row);
    row = [];
    if (out.length > limits.maxRows + 1) throw new CsvError('Demasiadas linhas');
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      if (cell.length > 0) throw new CsvError(`Aspas inválidas na linha ${out.length + 1}`);
      inQuotes = true;
    } else if (ch === delim) pushCell();
    else if (ch === '\n') pushRow();
    else if (ch === '\r') {
      /* ignore CR; LF terminates the row */
    } else cell += ch;
    i++;
  }
  if (inQuotes) throw new CsvError('Aspas não fechadas');
  if (cell.length > 0 || row.length > 0) pushRow();
  return out;
}

/** True when a cell would be interpreted as a formula by spreadsheet software. */
export function isFormulaLike(cell: string): boolean {
  return FORMULA_START.test(cell);
}
