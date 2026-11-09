/**
 * @file Code 128 barcode rendered as pure SVG <rect> elements.
 * @module web/components
 *
 * JsBarcode is used ONLY as an encoder (object mode, no DOM access); React renders the bars,
 * so no inline style attributes or innerHTML are needed and the strict CSP holds.
 */
import JsBarcode from 'jsbarcode';
import { useMemo } from 'react';

/** Printable barcode label. */
export function Barcode({ value, height = 60, caption }: { value: string; height?: number; caption?: string }) {
  const bars = useMemo(() => {
    const target: { encodings?: Array<{ data: string }> } = {};
    try {
      JsBarcode(target, value, { format: 'CODE128' });
    } catch {
      return null;
    }
    return target.encodings?.map((e) => e.data).join('') ?? null;
  }, [value]);
  if (!bars) return <span className="text-danger">Código inválido para etiqueta</span>;
  const module = 2;
  const width = bars.length * module + 20;
  return (
    <figure className="inline-flex flex-col items-center rounded border border-line bg-white p-2">
      <svg role="img" aria-label={`Código de barras ${value}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <rect x={0} y={0} width={width} height={height} fill="#fff" />
        {[...bars].map((b, i) =>
          b === '1' ? <rect key={i} x={10 + i * module} y={0} width={module} height={height} fill="#000" /> : null,
        )}
      </svg>
      <figcaption className="font-mono text-sm">{value}</figcaption>
      {caption && <figcaption className="text-xs text-ink-soft">{caption}</figcaption>}
    </figure>
  );
}
