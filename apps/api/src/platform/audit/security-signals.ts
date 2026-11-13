/**
 * @file Rate-limited audit records of control-bypass signals (ASVS 5.0 V16.3.3; ADR-0029).
 * @module platform/audit
 *
 * Rejected input (400/413/415) and rate limiting (429) are evidence of probing, fuzzing or brute
 * force, so they belong in the security audit trail — but writing one row per rejected request
 * would let an attacker flood the hash-chained log. This recorder writes:
 *  - the FIRST event of each (signal, company, user, client IP) key in a 5-minute window, with
 *    the error code and route;
 *  - one SUMMARY entry when that window ends, carrying how many further events were suppressed.
 * Memory is bounded (at most 10 000 keys; beyond that new keys are counted in one overflow
 * summary). Counts are per API process; with several replicas each writes its own summaries.
 * Nothing from the request body is recorded — only the route template, error code and client IP.
 */
import type { AuditService } from './audit.service.js';

/** Signals recorded by this module (audit actions `security.<signal>`). */
export type SecuritySignal = 'input_rejected' | 'rate_limited';

/** Where a signal came from. */
export interface SignalContext {
  companyId: string | null;
  actorUserId: string | null;
  clientIp: string;
  /** Route template ("POST /api/wms/w/:wh/receipts"), never the concrete URL. */
  route: string;
  /** Error code (VALIDATION_FAILED, RATE_LIMITED, or the HTTP reason phrase for parser errors). Stored as details.errorCode — `code` would be redacted by the audit writer. */
  code: string;
  requestId?: string;
}

interface Window {
  start: number;
  suppressed: number;
  ctx: SignalContext;
  signal: SecuritySignal;
}

/** Window length: one audit entry per source and signal at most every 5 minutes (+ a summary). */
export const SIGNAL_WINDOW_MS = 5 * 60_000;
/** Memory bound on open windows; further new sources are only counted (overflow summary). */
export const SIGNAL_MAX_KEYS = 10_000;

/** Rate-limited writer of control-bypass signals into the security audit log. */
export class SecuritySignals {
  private readonly windows = new Map<string, Window>();
  private overflow = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly audit: AuditService,
    private readonly windowMs = SIGNAL_WINDOW_MS,
    private readonly maxKeys = SIGNAL_MAX_KEYS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Records one event. Writes an audit entry only for the first event of a key in its window;
   * later events in the window are counted. Never throws (audit failures are logged by caller).
   */
  async record(signal: SecuritySignal, ctx: SignalContext): Promise<void> {
    const key = `${signal}|${ctx.companyId ?? '-'}|${ctx.actorUserId ?? '-'}|${ctx.clientIp}`;
    const t = this.now();
    const w = this.windows.get(key);
    if (w && t - w.start < this.windowMs) {
      w.suppressed++;
      return;
    }
    if (w) await this.writeSummary(key, w); // previous window ended: close it first
    if (!w && this.windows.size >= this.maxKeys) {
      this.overflow++;
      return;
    }
    this.windows.set(key, { start: t, suppressed: 0, ctx, signal });
    await this.audit.record({
      companyId: ctx.companyId,
      actorUserId: ctx.actorUserId,
      action: `security.${signal}`,
      resourceType: 'route',
      resourceId: ctx.route.slice(0, 80),
      outcome: 'DENIED',
      requestId: ctx.requestId,
      clientIp: ctx.clientIp,
      details: { errorCode: ctx.code.slice(0, 40), windowMinutes: Math.round(this.windowMs / 60_000) },
    });
  }

  /** Writes summaries for every window that has ended (called periodically and on stop). */
  async flush(all = false): Promise<number> {
    const t = this.now();
    let written = 0;
    for (const [key, w] of [...this.windows]) {
      if (all || t - w.start >= this.windowMs) {
        await this.writeSummary(key, w);
        written++;
      }
    }
    if (this.overflow > 0) {
      const n = this.overflow;
      this.overflow = 0;
      await this.audit.record({
        action: 'security.signals_overflow',
        resourceType: 'system',
        outcome: 'DENIED',
        details: { droppedEvents: n, maxKeys: this.maxKeys },
      });
      written++;
    }
    return written;
  }

  /** Number of open windows (for tests and diagnostics). */
  get openWindows(): number {
    return this.windows.size;
  }

  /** Starts the periodic flush (once a minute, unref'd). */
  start(onError: (e: unknown) => void): void {
    this.timer = setInterval(() => void this.flush().catch(onError), 60_000);
    this.timer.unref();
  }

  /** Stops the timer and writes the remaining summaries. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush(true);
  }

  private async writeSummary(key: string, w: Window): Promise<void> {
    this.windows.delete(key);
    if (w.suppressed === 0) return; // a single event is already fully recorded
    await this.audit.record({
      companyId: w.ctx.companyId,
      actorUserId: w.ctx.actorUserId,
      action: `security.${w.signal}`,
      resourceType: 'route',
      resourceId: w.ctx.route.slice(0, 80),
      outcome: 'DENIED',
      clientIp: w.ctx.clientIp,
      details: { summary: true, suppressedEvents: w.suppressed, windowMinutes: Math.round(this.windowMs / 60_000) },
    });
  }
}
