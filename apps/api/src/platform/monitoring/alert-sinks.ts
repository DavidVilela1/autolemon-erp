/**
 * @file Alert delivery channels for the security monitor (ADR-0026).
 * @module platform/monitoring
 *
 * Two sinks exist:
 *  - {@link LogAlertSink}: always on. Writes one structured `warn` line per alert with the stable
 *    marker `securityAlert: true`, so any log pipeline (journald, Loki, a SIEM agent) can alert on
 *    it without knowing the application.
 *  - {@link WebhookAlertSink}: optional, operator-configured HTTPS endpoint (SIEM, chat or pager
 *    bridge). The URL comes from configuration only — never from a request — so there is no
 *    user-controlled SSRF. Requests are HMAC-SHA256 signed over `timestamp.body`, time out after
 *    5 s, never follow redirects, and the stored error never includes the URL (it may carry an
 *    access token in its path).
 *
 * Payloads contain rule ids, severities, counts, company ids and timestamps only — no e-mail
 * addresses, IP addresses, names or audit details that could hold personal data.
 */
import { createHmac } from 'node:crypto';

/** What is delivered for one alert. */
export interface AlertNotice {
  id: string;
  rule: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  companyId: string | null;
  occurrences: number;
  windowMinutes: number;
  firstSeenAt: string;
  details: Record<string, string | number | boolean | null>;
}

/** A delivery channel. `notify` throws on failure; the monitor records and retries. */
export interface AlertSink {
  readonly name: string;
  notify(notice: AlertNotice): Promise<void>;
}

/** Minimal structured logger (pino-compatible). */
export interface MonitorLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Logger that discards everything (default until the process logger is attached). */
export const SILENT_LOGGER: MonitorLogger = { warn: () => undefined, error: () => undefined };

/** Writes alerts to the application log. */
export class LogAlertSink implements AlertSink {
  readonly name = 'log';
  constructor(private readonly log: () => MonitorLogger) {}

  /** Emits one `warn` line; never throws. */
  async notify(n: AlertNotice): Promise<void> {
    this.log().warn({ securityAlert: true, alert: n }, `security alert ${n.severity} ${n.rule}`);
  }
}

/** Posts alerts to an operator-configured HTTPS endpoint. */
export class WebhookAlertSink implements AlertSink {
  readonly name = 'webhook';

  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5000,
  ) {}

  /**
   * Sends one signed POST. Headers: `X-AutoLemon-Timestamp` (Unix seconds) and
   * `X-AutoLemon-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>`. Receivers
   * must recompute the signature and reject timestamps older than 5 minutes (replay).
   * @throws Error with a short, URL-free reason on any non-2xx status, timeout or network error.
   */
  async notify(n: AlertNotice): Promise<void> {
    const body = JSON.stringify({ type: 'autolemon.security_alert', version: 1, alert: n });
    const ts = Math.floor(Date.now() / 1000).toString();
    const signature = signWebhook(this.secret, ts, body);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AutoLemon-Timestamp': ts, 'X-AutoLemon-Signature': `v1=${signature}` },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // Only the error class: messages (and causes) from fetch can echo the URL, which may carry a token.
      // eslint-disable-next-line preserve-caught-error -- the cause is dropped on purpose (see above)
      throw new Error(`webhook ${e instanceof Error ? e.name : 'error'}`);
    }
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
  }
}

/** HMAC-SHA256 hex signature used by {@link WebhookAlertSink} (exported for receivers/tests). */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
