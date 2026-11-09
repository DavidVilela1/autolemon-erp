/**
 * @file Exact decimal quantity helpers (3 fractional digits) using bigint milli-units.
 * @module wms/inventory
 *
 * The database stores numeric(18,3) and performs the authoritative arithmetic. TypeScript
 * needs comparisons and simple sums for validation; floating point is never used for that.
 */

/** Parses a decimal string ("12", "0.5", "-3.250") into milli-units (bigint). */
export function toMilli(s: string | number): bigint {
  const str = typeof s === 'number' ? s.toFixed(3) : s.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,3}))?$/.exec(str);
  if (!m) throw new Error(`invalid decimal: ${str}`);
  const v = BigInt(m[2]!) * 1000n + BigInt((m[3] ?? '').padEnd(3, '0') || '0');
  return m[1] ? -v : v;
}

/** Formats milli-units back to a canonical decimal string ("12", "0.5", "-3.25"). */
export function fromMilli(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const int = a / 1000n;
  const frac = (a % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** Canonicalises a numeric string returned by PostgreSQL ("12.000" → "12"). */
export function canon(s: string): string {
  return fromMilli(toMilli(s));
}

/** Sum of decimal strings. */
export function sum(values: string[]): string {
  return fromMilli(values.reduce((acc, v) => acc + toMilli(v), 0n));
}

/** a - b as decimal string. */
export function sub(a: string, b: string): string {
  return fromMilli(toMilli(a) - toMilli(b));
}

/** Negation. */
export function neg(a: string): string {
  return fromMilli(-toMilli(a));
}

/** Comparison: -1, 0, 1. */
export function cmp(a: string, b: string): number {
  const d = toMilli(a) - toMilli(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/** Minimum of two decimals. */
export function min(a: string, b: string): string {
  return cmp(a, b) <= 0 ? a : b;
}

/** True when strictly positive. */
export function isPositive(a: string): boolean {
  return toMilli(a) > 0n;
}
