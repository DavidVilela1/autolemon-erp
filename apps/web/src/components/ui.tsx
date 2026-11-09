/**
 * @file Shared UI primitives (pt-PT, keyboard-first, accessible). See docs/DESIGN_SYSTEM.md.
 * @module web/components
 *
 * Rendering rule: all user/API data is rendered as React text children (auto-escaped). No
 * component in this app uses dangerouslySetInnerHTML (ESLint rule enforces it).
 */
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api';

/** Page wrapper with title, purpose and short workflow instructions. */
export function Page({
  title,
  purpose,
  steps,
  actions,
  children,
}: {
  title: string;
  purpose: string;
  steps?: string[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby="page-title" className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-3">
        <div className="max-w-3xl">
          <h1 id="page-title" className="text-xl font-semibold tracking-tight">
            {title}
          </h1>
          <p className="text-ink-soft">{purpose}</p>
          {steps && (
            <ol className="mt-1 flex flex-wrap gap-x-4 text-sm text-ink-soft">
              {steps.map((s, i) => (
                <li key={s}>
                  <span className="font-semibold text-teal">{i + 1}.</span> {s}
                </li>
              ))}
            </ol>
          )}
        </div>
        {actions && <div className="no-print flex gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** Card / panel. */
export function Panel({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-md border border-line bg-surface p-4 ${className}`}>
      {title && <h2 className="mb-3 text-base font-semibold">{title}</h2>}
      {children}
    </div>
  );
}

/** Button with variants; disabled while busy. */
export function Button({
  children,
  variant = 'primary',
  type = 'button',
  onClick,
  disabled,
  small,
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  type?: 'button' | 'submit';
  onClick?: () => void;
  disabled?: boolean;
  small?: boolean;
}) {
  const v = {
    primary: 'bg-teal text-white hover:bg-teal-dark border-teal',
    secondary: 'bg-surface text-ink border-line hover:bg-paper',
    danger: 'bg-danger text-white border-danger hover:opacity-90',
    ghost: 'bg-transparent text-teal border-transparent hover:underline',
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${v} ${small ? 'px-2 py-1 text-sm' : 'px-3 py-2'} rounded border font-medium disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {children}
    </button>
  );
}

/** Labelled input field. */
export function Field({
  label,
  value,
  onChange,
  type = 'text',
  required,
  placeholder,
  autoFocus,
  hint,
  autoComplete,
  inputMode,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  hint?: string;
  autoComplete?: string;
  inputMode?: 'numeric' | 'decimal' | 'text';
  maxLength?: number;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id} className="font-medium">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength ?? 200}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-line-strong bg-surface px-2 py-1.5 text-base"
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint && (
        <span id={`${id}-hint`} className="text-xs text-ink-soft">
          {hint}
        </span>
      )}
    </div>
  );
}

/** Labelled select. */
export function Select({
  label,
  value,
  onChange,
  options,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  required?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <select
        id={id}
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-line-strong bg-surface px-2 py-1.5 text-base"
      >
        <option value="">— escolher —</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Scanner-friendly input: keyboard-wedge scanners type the code and press Enter. Submits on
 * Enter, strips CR/LF, clears and keeps focus for the next scan.
 */
export function ScanInput({ label, onScan, autoFocus = true }: { label: string; onScan: (code: string) => void; autoFocus?: boolean }) {
  const [v, setV] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const id = useId();
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <input
        id={id}
        ref={ref}
        value={v}
        autoFocus={autoFocus}
        autoComplete="off"
        maxLength={64}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const code = v.replace(/[\r\n]/g, '').trim();
            if (code) onScan(code);
            setV('');
            ref.current?.focus();
          }
        }}
        className="rounded border-2 border-teal bg-lemon-soft px-2 py-2 font-mono text-lg"
        placeholder="Ler código e Enter"
      />
    </div>
  );
}

/** Status message (role=status/alert for screen readers). Never claims success that did not happen. */
export function Notice({ kind, children }: { kind: 'error' | 'ok' | 'info'; children: ReactNode }) {
  const cls = {
    error: 'bg-danger-soft text-danger border-danger',
    ok: 'bg-ok-soft text-ok border-ok',
    info: 'bg-teal-soft text-ink border-teal',
  }[kind];
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`rounded border-l-4 px-3 py-2 text-sm ${cls}`}>
      {children}
    </div>
  );
}

/** Renders an API/unknown error as a Notice, including the request id for support. */
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  if (error instanceof ApiError) {
    const details = Array.isArray(error.details) ? (error.details as Array<{ path?: string; message?: string; row?: number }>) : [];
    return (
      <Notice kind="error">
        <strong>{error.message}</strong>
        {details.length > 0 && (
          <ul className="mt-1 list-disc pl-5">
            {details.slice(0, 10).map((d, i) => (
              <li key={i}>
                {d.row !== undefined ? `Linha ${d.row}: ` : d.path ? `${d.path}: ` : ''}
                {d.message}
              </li>
            ))}
          </ul>
        )}
        {error.requestId && <div className="mt-1 text-xs opacity-80">Código do pedido: {error.requestId}</div>}
      </Notice>
    );
  }
  return <Notice kind="error">Erro inesperado. Verifique a ligação e tente novamente.</Notice>;
}

/** Simple dense table. Columns render text only. */
export function Table<T>({
  rows,
  cols,
  empty = 'Sem registos.',
  rowKey,
}: {
  rows: T[];
  cols: Array<{ h: string; c: (r: T) => ReactNode; num?: boolean }>;
  empty?: string;
  rowKey: (r: T) => string;
}) {
  if (!rows.length) return <p className="text-sm text-ink-soft">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-ink-soft">
            {cols.map((c) => (
              <th key={c.h} scope="col" className={`px-2 py-1.5 font-medium ${c.num ? 'text-right' : ''}`}>
                {c.h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className="border-b border-line last:border-0 hover:bg-paper">
              {cols.map((c) => (
                <td key={c.h} className={`px-2 py-1.5 ${c.num ? 'num' : ''}`}>
                  {c.c(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Data loading hook with explicit loading/error states and reload. */
export function useLoad<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): { data: T | undefined; error: unknown; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    run()
      .then((d) => alive && (setData(d), setError(undefined)))
      .catch((e: unknown) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [run, tick]);
  return { data, error, loading, reload: () => setTick((x) => x + 1) };
}

/** Runs a command with busy/error/success state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState<string>();
  const run = useCallback(async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await fn();
      if (success) setMessage(success);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, message, run, clear: () => (setError(undefined), setMessage(undefined)) };
}

/** Loading indicator. */
export function Loading() {
  return (
    <p role="status" className="text-sm text-ink-soft">
      A carregar…
    </p>
  );
}

/** Form wrapper preventing default submit. */
export function Form({ onSubmit, children, className = '' }: { onSubmit: () => void; children: ReactNode; className?: string }) {
  return (
    <form
      className={className}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

/** Status pill. */
export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'danger' }) {
  const cls = {
    neutral: 'bg-paper text-ink-soft',
    ok: 'bg-ok-soft text-ok',
    warn: 'bg-lemon-soft text-ink',
    danger: 'bg-danger-soft text-danger',
  }[tone];
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}
