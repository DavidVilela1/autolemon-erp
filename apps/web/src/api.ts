/**
 * @file API client: same-origin fetch with session cookie, in-memory CSRF token, idempotency keys.
 * @module web
 *
 * Security notes: no token is ever stored in localStorage/sessionStorage. The session cookie is
 * HttpOnly (invisible to JS). The CSRF token lives in a module variable and is re-fetched from
 * /api/auth/session after a reload. WMS commands carry an Idempotency-Key generated once per
 * user action and reused on a network retry, so a retry can never move stock twice.
 */

let csrfToken: string | null = null;

/** Stores the CSRF token for subsequent writes (memory only). */
export function setCsrf(token: string | null): void {
  csrfToken = token;
}

/** Error returned by the API with a stable code and pt-PT message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

/** Generates an idempotency key for one user action. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** Request options. */
export interface ApiOptions {
  /** Raw text body (CSV import). */
  text?: string;
  /** Return response text instead of JSON (CSV export). */
  asText?: boolean;
  /** Reuse a specific idempotency key. */
  idempotencyKey?: string;
}

/**
 * Performs an API call. Mutations automatically include CSRF, the custom anti-CSRF header and,
 * for /api/wms/ paths, an Idempotency-Key. One automatic retry on network failure (same key).
 */
export async function api<T = unknown>(method: string, path: string, body?: unknown, opts: ApiOptions = {}): Promise<T> {
  const mutating = method !== 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (mutating) {
    headers['X-Requested-With'] = 'autolemon';
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    if (path.startsWith('/api/wms/')) headers['Idempotency-Key'] = opts.idempotencyKey ?? newIdempotencyKey();
  }
  let payload: BodyInit | undefined;
  if (opts.text !== undefined) {
    headers['Content-Type'] = 'text/csv';
    payload = opts.text;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  } else if (mutating) {
    headers['Content-Type'] = 'application/json';
    payload = '{}';
  }
  const doFetch = () => fetch(path, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  let res: Response;
  try {
    res = await doFetch();
  } catch {
    res = await doFetch(); // same headers ⇒ same Idempotency-Key
  }
  if (opts.asText && res.ok) return (await res.text()) as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown }; requestId?: string }) ?? {};
    throw new ApiError(res.status, e.error?.code ?? 'HTTP_ERROR', e.error?.message ?? `Erro ${res.status}`, e.error?.details, e.requestId);
  }
  return data as T;
}

/** Formats a decimal string quantity for pt-PT display ("12.500" → "12,5"). */
export function fmtQty(q: string | number | null | undefined): string {
  if (q === null || q === undefined || q === '') return '—';
  const n = Number(q);
  return Number.isFinite(n) ? n.toLocaleString('pt-PT', { maximumFractionDigits: 3 }) : String(q);
}

/** Formats an ISO timestamp in Europe/Lisbon. */
export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon', dateStyle: 'short', timeStyle: 'short' });
}
