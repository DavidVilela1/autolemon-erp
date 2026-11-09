/**
 * @file Shared primitive validators used by every API contract.
 * @module contracts (owning module: shared platform contracts)
 *
 * Every value that crosses a trust boundary (HTTP body, query, route param, CSV cell,
 * barcode scan) is validated with these primitives before it reaches a domain command.
 * Validation here is a *first* gate only: domain services re-check ownership, state
 * transitions and quantities inside the database transaction.
 */
import { z } from 'zod';

/** Canonical lower-case RFC 4122 UUID (any version). Rejects braces, upper-case and whitespace. */
export const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'UUID inválido');

/**
 * Printable single-line text. Control characters (including NUL, CR, LF, TAB) are rejected
 * rather than stripped, so stored values are exactly what the user typed. HTML/SQL
 * metacharacters are *allowed* on purpose: we defend with parameterised SQL and React output
 * encoding, not lossy input sanitisation (see docs/security/THREAT_MODEL.md, T-INJ).
 */
export const SafeLine = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.normalize('NFC').trim())
    // eslint-disable-next-line no-control-regex -- intentionally matching control characters to reject them
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'Caracteres de controlo não são permitidos');

/** Multi-line note text (LF allowed, other control characters rejected). */
export const SafeText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.normalize('NFC').replace(/\r\n/g, '\n').trim())
    // eslint-disable-next-line no-control-regex -- intentionally matching control characters to reject them
    .refine((s) => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(s), 'Caracteres de controlo não são permitidos');

/**
 * Business code (SKU code, location code, document number): upper-case letters, digits and
 * the separators `-`, `_`, `.`, `/`. Restricting codes keeps barcodes, labels and CSV exports
 * unambiguous and prevents formula-injection prefixes (`=`, `+`, `-` as first char, `@`).
 */
export const Code = z
  .string()
  .min(1)
  .max(40)
  .transform((s) => s.trim().toUpperCase())
  .refine((s) => /^[A-Z0-9][A-Z0-9._/-]{0,39}$/.test(s), 'Código inválido (A-Z, 0-9, . _ / -)');

/**
 * Barcode scan payload. Scanners in keyboard-wedge mode may append CR/LF which the UI strips;
 * here we accept printable ASCII only (GS1 FNC1 is not supported in v0.5).
 */
export const Barcode = z
  .string()
  .min(1)
  .max(64)
  .transform((s) => s.trim())
  .refine((s) => /^[\x21-\x7e]+$/.test(s), 'Código de barras inválido');

/** Maximum quantity per line: one billion base units. Protects numeric(18,3) and UI. */
export const QTY_MAX = 1_000_000_000;

/**
 * Positive quantity with at most 3 decimal places, accepted as JSON number or decimal string
 * and normalised to a canonical decimal string (e.g. "12", "0.5"). Strings avoid binary
 * floating point surprises; the database stores numeric(18,3).
 */
export const Qty = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
  .refine((s) => /^\d{1,10}(\.\d{1,3})?$/.test(s), 'Quantidade inválida (máx. 3 casas decimais)')
  .refine((s) => Number(s) > 0 && Number(s) <= QTY_MAX, 'Quantidade fora do intervalo permitido')
  .transform((s) => normaliseDecimal(s));

/** Non-negative quantity (counts may legitimately be zero). */
export const QtyOrZero = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
  .refine((s) => /^\d{1,10}(\.\d{1,3})?$/.test(s), 'Quantidade inválida (máx. 3 casas decimais)')
  .refine((s) => Number(s) >= 0 && Number(s) <= QTY_MAX, 'Quantidade fora do intervalo permitido')
  .transform((s) => normaliseDecimal(s));

/** Removes leading zeros and trailing fractional zeros: "007.500" → "7.5". */
export function normaliseDecimal(s: string): string {
  const [intPart = '0', frac = ''] = s.split('.');
  const i = intPart.replace(/^0+(?=\d)/, '');
  const f = frac.replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

/** Idempotency key supplied by clients on every inventory command (header `Idempotency-Key`). */
export const IdempotencyKey = z
  .string()
  .min(8)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/, 'Idempotency-Key inválida');

/** Pagination with hard upper bound to prevent resource exhaustion. */
export const Page = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();
