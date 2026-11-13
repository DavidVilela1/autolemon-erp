/**
 * @file Security monitoring: rule-based alerts over the audit log, incremental audit-chain
 * verification, job-failure alerts, alert delivery and the admin read/acknowledge API
 * (gate S-05 code part; ADR-0026).
 * @module platform/monitoring
 *
 * Design:
 *  - Signals come from the hash-chained security audit log, which every authentication,
 *    authorization denial and high-risk administrative action already writes. The monitor adds
 *    no new collection path that could diverge from the audit trail.
 *  - Count rules ({@link COUNT_RULES}) fire when a company (or the pre-authentication chain) has
 *    at least `threshold` matching entries inside `windowMinutes`. Entries that occurred before
 *    the last acknowledgement of the same rule are not counted again, so acknowledging stops a
 *    re-raise for already-seen events while a continuing attack raises a new alert.
 *  - Event alerts (audit chain broken, outbox stuck, background job failed) carry a dedupe key
 *    in `details.key`; the same key never raises twice, open or acknowledged.
 *  - At most one OPEN alert per (company, rule) (database unique index): a sustained condition
 *    updates `occurrences`/`last_seen_at` instead of creating more rows. Only NEW alerts are
 *    delivered; failed deliveries are retried up to {@link MAX_NOTIFY_ATTEMPTS} times.
 *  - Audit chains are verified incrementally from a checkpoint (≤ {@link VERIFY_BATCH} entries per
 *    chain per run); every 24 h the checkpoint restarts from the genesis so a rewrite of old
 *    entries is still detected.
 *
 * What this is NOT: it does not replace an external monitoring stack (metrics, uptime, on-call
 * paging, off-site audit digests). Those remain owner-side controls (gate O-05, SEC-OPEN-003/008).
 */
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { AcknowledgeAlertInput, SecurityAlertsQuery } from '@autolemon/contracts';
import { Conflict, NotFound } from '../../common/errors.js';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/database.js';
import { asDate, one, row, rows } from '../../db/database.js';
import { type Actor, requirePermission, requireStepUp } from '../authz/actor.js';
import { AUDIT_GENESIS_HASH, type AuditService, PRE_AUTH_CHAIN } from '../audit/audit.service.js';
import { type AlertNotice, type AlertSink, LogAlertSink, type MonitorLogger, SILENT_LOGGER, WebhookAlertSink } from './alert-sinks.js';

/** Alert severity. */
export type Severity = AlertNotice['severity'];

/** A threshold rule over audit entries. */
export interface CountRule {
  /** Stable rule id (also the alert `rule`). */
  id: string;
  severity: Severity;
  /** Audit actions that count. */
  actions: readonly string[];
  /** Only entries with this outcome count (all outcomes when omitted). */
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  threshold: number;
  windowMinutes: number;
  /** `company`: per company chain; `system`: the pre-authentication chain (unknown accounts). */
  scope: 'company' | 'system';
}

/**
 * Built-in rules. Thresholds are deliberately conservative for a warehouse with tens of users;
 * tune them in code (with a test) rather than per deployment so behaviour stays reviewable.
 */
export const COUNT_RULES: readonly CountRule[] = [
  {
    id: 'auth.login_failures',
    severity: 'HIGH',
    actions: ['auth.login'],
    outcome: 'FAILURE',
    threshold: 10,
    windowMinutes: 15,
    scope: 'company',
  },
  {
    id: 'auth.mfa_failures',
    severity: 'HIGH',
    actions: ['auth.mfa_verify', 'auth.step_up'],
    outcome: 'FAILURE',
    threshold: 10,
    windowMinutes: 15,
    scope: 'company',
  },
  {
    id: 'auth.unknown_account_failures',
    severity: 'HIGH',
    actions: ['auth.login'],
    outcome: 'FAILURE',
    threshold: 50,
    windowMinutes: 15,
    scope: 'system',
  },
  { id: 'authz.denied_spike', severity: 'MEDIUM', actions: ['authz.denied'], threshold: 20, windowMinutes: 15, scope: 'company' },
  {
    id: 'auth.recovery_code_used',
    severity: 'MEDIUM',
    actions: ['auth.login.recovery_code_used'],
    threshold: 1,
    windowMinutes: 60,
    scope: 'company',
  },
  {
    id: 'auth.mfa_reset',
    severity: 'MEDIUM',
    actions: ['admin.user.mfa_reset', 'auth.mfa_reset.completed'],
    threshold: 1,
    windowMinutes: 60,
    scope: 'company',
  },
  { id: 'admin.pii_read_burst', severity: 'MEDIUM', actions: ['admin.pii.read'], threshold: 5, windowMinutes: 60, scope: 'company' },
  {
    // Rows are already rate-limited per source and window (ADR-0029), so 10 rows mean many
    // distinct sources or a sustained run of rejected/throttled requests.
    id: 'security.probing',
    severity: 'MEDIUM',
    actions: ['security.input_rejected', 'security.rate_limited'],
    threshold: 10,
    windowMinutes: 15,
    scope: 'company',
  },
  {
    id: 'security.unauthenticated_probing',
    severity: 'MEDIUM',
    actions: ['security.input_rejected', 'security.rate_limited'],
    threshold: 20,
    windowMinutes: 15,
    scope: 'system',
  },
  { id: 'admin.key_rotation', severity: 'LOW', actions: ['admin.keys.rotate'], threshold: 1, windowMinutes: 60, scope: 'company' },
  {
    id: 'wms.export_burst',
    severity: 'MEDIUM',
    actions: ['wms.export.ledger_csv', 'wms.export.stock_csv'],
    threshold: 10,
    windowMinutes: 60,
    scope: 'company',
  },
];

/** Counter groups of the admin overview (action → category). */
const OVERVIEW_GROUPS: ReadonlyArray<{ key: string; actions: readonly string[]; outcome?: string }> = [
  { key: 'loginSuccess', actions: ['auth.login', 'auth.login.recovery_code_used'], outcome: 'SUCCESS' },
  { key: 'loginFailure', actions: ['auth.login'], outcome: 'FAILURE' },
  { key: 'mfaFailure', actions: ['auth.mfa_verify', 'auth.step_up'], outcome: 'FAILURE' },
  { key: 'recoveryCodeUsed', actions: ['auth.login.recovery_code_used'] },
  { key: 'accessDenied', actions: ['authz.denied'] },
  { key: 'mfaReset', actions: ['admin.user.mfa_reset', 'auth.mfa_reset.completed'] },
  { key: 'passwordChange', actions: ['auth.password_change', 'auth.password_reset.completed', 'admin.user.password_reset_issued'] },
  { key: 'passkeyChange', actions: ['auth.passkey.register', 'auth.passkey.revoke'] },
  { key: 'piiRead', actions: ['admin.pii.read'] },
  { key: 'export', actions: ['wms.export.ledger_csv', 'wms.export.stock_csv'] },
  { key: 'keyRotation', actions: ['admin.keys.rotate'] },
  { key: 'controlBypass', actions: ['security.input_rejected', 'security.rate_limited'] },
  { key: 'privilegeChange', actions: ['admin.user.create', 'admin.user.permissions', 'admin.user.warehouse', 'admin.user.deactivate'] },
];

/** Unpublished domain events older than this raise `system.outbox_stuck`. */
export const OUTBOX_STUCK_MINUTES = 15;
/** Maximum audit entries verified per chain per run. */
export const VERIFY_BATCH = 20_000;
/** A full re-verification from the genesis restarts after this many hours. */
export const FULL_PASS_HOURS = 24;
/** Delivery retries per alert. */
export const MAX_NOTIFY_ATTEMPTS = 5;

/** Result of one monitor run (also logged). */
export interface MonitorRunResult {
  raised: number;
  updated: number;
  chainsChecked: number;
  entriesVerified: number;
  brokenChains: number;
  delivered: number;
  deliveryFailures: number;
}

/** Periodic security monitor and the admin-facing security API. */
export class SecurityMonitor {
  private timer: NodeJS.Timeout | undefined;
  private log: MonitorLogger = SILENT_LOGGER;
  private readonly sinks: AlertSink[];
  private running = false;

  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
    private readonly cfg: Pick<
      AppConfig,
      'SECURITY_MONITOR_INTERVAL_SECONDS' | 'ALERT_WEBHOOK_URL' | 'ALERT_WEBHOOK_SECRET' | 'STEP_UP_MINUTES'
    >,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.sinks = [new LogAlertSink(() => this.log)];
    if (cfg.ALERT_WEBHOOK_URL && cfg.ALERT_WEBHOOK_SECRET) {
      this.sinks.push(new WebhookAlertSink(cfg.ALERT_WEBHOOK_URL, cfg.ALERT_WEBHOOK_SECRET, fetchImpl));
    }
  }

  /** Attaches the process logger used by the log sink and for monitor errors. */
  useLogger(log: MonitorLogger): void {
    this.log = log;
  }

  // ------------------------------------------------------------------ periodic run

  /**
   * One full evaluation: count rules, outbox backlog, audit-chain checkpoints, then delivery of
   * new and previously failed alerts. Runs are not re-entrant (a slow run skips the next tick).
   */
  async runOnce(): Promise<MonitorRunResult> {
    const result: MonitorRunResult = {
      raised: 0,
      updated: 0,
      chainsChecked: 0,
      entriesVerified: 0,
      brokenChains: 0,
      delivered: 0,
      deliveryFailures: 0,
    };
    if (this.running) return result;
    this.running = true;
    try {
      for (const rule of COUNT_RULES) await this.evaluateCountRule(rule, result);
      await this.evaluateOutbox(result);
      await this.verifyChains(result);
      await this.deliverPending(result);
      return result;
    } finally {
      this.running = false;
    }
  }

  /** Starts the periodic monitor (first run after one interval). */
  start(log: MonitorLogger): void {
    this.useLogger(log);
    this.timer = setInterval(() => {
      void this.runOnce().catch((e: unknown) => this.log.error({ err: e }, 'security monitor run failed'));
    }, this.cfg.SECURITY_MONITOR_INTERVAL_SECONDS * 1000);
    this.timer.unref();
  }

  /** Stops the periodic monitor. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Records a background-job failure (retention purge, outbox dispatch) as a system alert and,
   * when the alert is new, a system audit entry. At most one new alert per job per hour (dedupe
   * key) so a job failing every few seconds cannot flood the audit log. The error message is
   * NOT stored — only its class name — because driver messages can contain data values.
   * @returns what happened to the alert.
   */
  async reportJobFailure(job: 'retention' | 'outbox', error: unknown): Promise<'raised' | 'updated' | 'skipped'> {
    const errorClass = error instanceof Error ? error.name : 'Error';
    const hour = new Date().toISOString().slice(0, 13);
    const r = await this.raise(null, `system.${job}_failed`, 'HIGH', 1, 60, { job, errorClass, key: `${job}:${hour}` });
    if (r === 'raised') {
      await this.audit.record({ action: `system.${job}.failed`, resourceType: 'system', outcome: 'FAILURE', details: { job, errorClass } });
    }
    return r;
  }

  private async evaluateCountRule(rule: CountRule, result: MonitorRunResult): Promise<void> {
    const scopeFilter = rule.scope === 'system' ? sql`a.chain_key = ${PRE_AUTH_CHAIN}` : sql`a.company_id IS NOT NULL`;
    const outcomeFilter = rule.outcome ? sql`AND a.outcome = ${rule.outcome}` : sql``;
    const hits = await this.database.systemTx((tx) =>
      rows<{ company_id: string | null; n: number; first_at: Date | string; last_at: Date | string }>(
        tx,
        sql`SELECT a.company_id, count(*)::int AS n, min(a.occurred_at) AS first_at, max(a.occurred_at) AS last_at
              FROM security_audit_log a
             WHERE a.occurred_at > now() - make_interval(mins => ${rule.windowMinutes}::int)
               AND a.action IN (SELECT jsonb_array_elements_text(${JSON.stringify(rule.actions)}::jsonb)) ${outcomeFilter}
               AND ${scopeFilter}
               -- Events already acknowledged for this rule are not counted again.
               AND a.occurred_at > coalesce((SELECT max(s.acknowledged_at) FROM security_alerts s
                                             WHERE s.rule = ${rule.id} AND s.company_id IS NOT DISTINCT FROM a.company_id), '-infinity')
             GROUP BY a.company_id
            HAVING count(*) >= ${rule.threshold}`,
      ),
    );
    for (const h of hits) {
      const r = await this.raise(h.company_id, rule.id, rule.severity, h.n, rule.windowMinutes, {
        threshold: rule.threshold,
        firstEventAt: asDate(h.first_at)!.toISOString(),
        lastEventAt: asDate(h.last_at)!.toISOString(),
      });
      if (r === 'raised') result.raised++;
      else if (r === 'updated') result.updated++;
    }
  }

  private async evaluateOutbox(result: MonitorRunResult): Promise<void> {
    // domain_outbox is tenant-scoped under RLS: read it per company, like the dispatcher does.
    for (const companyId of await this.companyIds()) {
      const s = await this.database.tenantTx({ companyId, whScope: '*' }, (tx) =>
        one<{ n: number; oldest_id: string | null }>(
          tx,
          sql`SELECT count(*)::int AS n, min(id)::text AS oldest_id FROM domain_outbox
               WHERE published_at IS NULL AND created_at < now() - make_interval(mins => ${OUTBOX_STUCK_MINUTES}::int)`,
        ),
      );
      if (s.n === 0) continue;
      const r = await this.raise(companyId, 'system.outbox_stuck', 'MEDIUM', s.n, OUTBOX_STUCK_MINUTES, { key: `outbox:${s.oldest_id}` });
      if (r === 'raised') result.raised++;
      else if (r === 'updated') result.updated++;
    }
  }

  private async companyIds(): Promise<string[]> {
    const list = await this.database.systemTx((tx) => rows<{ id: string }>(tx, sql`SELECT id FROM companies ORDER BY id`));
    return list.map((c) => c.id);
  }

  private async verifyChains(result: MonitorRunResult): Promise<void> {
    for (const chainKey of [PRE_AUTH_CHAIN, ...(await this.companyIds())]) {
      const cp = await this.database.systemTx((tx) =>
        row<{ seq: string; hash: Buffer; full_pass_started_at: Date | string; last_result: string }>(
          tx,
          sql`SELECT seq::text, hash, full_pass_started_at, last_result FROM audit_chain_checkpoints WHERE chain_key = ${chainKey}`,
        ),
      );
      const restart = !cp || Date.now() - asDate(cp.full_pass_started_at)!.getTime() > FULL_PASS_HOURS * 3600_000;
      const from = restart ? { seq: 0n, hash: AUDIT_GENESIS_HASH } : { seq: BigInt(cp.seq), hash: cp.hash };
      const v = await this.audit.verifyRange(chainKey, from, VERIFY_BATCH);
      result.chainsChecked++;
      result.entriesVerified += v.checked;
      const status = v.ok ? 'OK' : 'BROKEN';
      await this.database.systemTx((tx) =>
        tx.execute(sql`
          INSERT INTO audit_chain_checkpoints (chain_key, seq, hash, verified_at, full_pass_started_at, last_result, broken_at_seq)
          VALUES (${chainKey}, ${v.lastSeq.toString()}, ${v.lastHash}, now(), now(), ${status}, ${v.brokenAtSeq ?? null})
          ON CONFLICT (chain_key) DO UPDATE SET seq = EXCLUDED.seq, hash = EXCLUDED.hash, verified_at = now(),
            full_pass_started_at = CASE WHEN ${restart} THEN now() ELSE audit_chain_checkpoints.full_pass_started_at END,
            last_result = EXCLUDED.last_result, broken_at_seq = EXCLUDED.broken_at_seq`),
      );
      if (!v.ok) {
        result.brokenChains++;
        const companyId = chainKey === PRE_AUTH_CHAIN ? null : chainKey;
        const r = await this.raise(companyId, 'audit.chain_broken', 'CRITICAL', 1, 1, {
          brokenAtSeq: v.brokenAtSeq ?? null,
          key: `chain:${chainKey}:${v.brokenAtSeq}`,
        });
        if (r === 'raised') result.raised++;
      }
    }
  }

  /**
   * Opens a new alert or refreshes the open one for (company, rule). Event alerts with a
   * `details.key` already seen (open or acknowledged) are skipped.
   * @returns `raised` (new row, will be delivered), `updated` or `skipped`.
   */
  private async raise(
    companyId: string | null,
    rule: string,
    severity: Severity,
    occurrences: number,
    windowMinutes: number,
    details: Record<string, string | number | boolean | null>,
  ): Promise<'raised' | 'updated' | 'skipped'> {
    return this.database.systemTx(async (tx) => {
      if (typeof details.key === 'string') {
        const seen = await row(
          tx,
          sql`SELECT 1 FROM security_alerts WHERE rule = ${rule} AND company_id IS NOT DISTINCT FROM ${companyId}
                AND details->>'key' = ${details.key} LIMIT 1`,
        );
        if (seen) return 'skipped';
      }
      const r = await one<{ id: string; inserted: boolean }>(
        tx,
        sql`INSERT INTO security_alerts (company_id, rule, severity, occurrences, window_minutes, details)
            VALUES (${companyId}, ${rule}, ${severity}, ${occurrences}, ${windowMinutes}, ${JSON.stringify(details)}::jsonb)
            ON CONFLICT (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), rule) WHERE status = 'OPEN'
            DO UPDATE SET occurrences = greatest(security_alerts.occurrences, EXCLUDED.occurrences),
                          details = EXCLUDED.details, last_seen_at = now()
            RETURNING id, (xmax = 0) AS inserted`,
      );
      if (r.inserted && companyId) {
        // Raising is itself part of the company's security history.
        await this.audit.recordInTx(tx, {
          companyId,
          action: 'security.alert.raised',
          resourceType: 'security_alert',
          resourceId: r.id,
          outcome: 'SUCCESS',
          details: { rule, severity, occurrences },
        });
      }
      return r.inserted ? 'raised' : 'updated';
    });
  }

  private async deliverPending(result: MonitorRunResult): Promise<void> {
    const pending = await this.database.systemTx((tx) =>
      rows<{
        id: string;
        rule: string;
        severity: Severity;
        company_id: string | null;
        occurrences: number;
        window_minutes: number;
        first_seen_at: Date | string;
        details: AlertNotice['details'];
      }>(
        tx,
        sql`SELECT id, rule, severity, company_id, occurrences, window_minutes, first_seen_at, details FROM security_alerts
             WHERE notified_at IS NULL AND notify_attempts < ${MAX_NOTIFY_ATTEMPTS} ORDER BY first_seen_at LIMIT 100`,
      ),
    );
    for (const a of pending) {
      const notice: AlertNotice = {
        id: a.id,
        rule: a.rule,
        severity: a.severity,
        companyId: a.company_id,
        occurrences: a.occurrences,
        windowMinutes: a.window_minutes,
        firstSeenAt: asDate(a.first_seen_at)!.toISOString(),
        details: a.details,
      };
      const errors: string[] = [];
      for (const sink of this.sinks) {
        try {
          await sink.notify(notice);
        } catch (e) {
          errors.push(`${sink.name}: ${e instanceof Error ? e.message : 'error'}`.slice(0, 100));
        }
      }
      if (errors.length) {
        result.deliveryFailures++;
        this.log.error({ alertId: a.id, rule: a.rule, errors }, 'security alert delivery failed');
      } else {
        result.delivered++;
      }
      const error = errors.length ? errors.join('; ').slice(0, 200) : null;
      await this.database.systemTx((tx) =>
        tx.execute(sql`UPDATE security_alerts SET notify_attempts = notify_attempts + 1, notify_error = ${error},
                         notified_at = CASE WHEN ${error === null} THEN now() ELSE NULL END WHERE id = ${a.id}`),
      );
    }
  }

  // ------------------------------------------------------------------ admin API

  /**
   * Company security overview for administrators (admin.audit.read): counters per category in a
   * bounded window, open alerts, audit-chain checkpoint state, outbox backlog and the monitor
   * configuration (never the webhook URL or secret).
   */
  async overview(actor: Actor, windowMinutes: number) {
    requirePermission(actor, 'admin.audit.read');
    // domain_outbox is tenant-scoped under RLS.
    const outbox = await this.database.tenantTx({ companyId: actor.companyId, whScope: '*' }, (tx) =>
      one<{ n: number; oldest: Date | string | null }>(
        tx,
        sql`SELECT count(*)::int AS n, min(created_at) AS oldest FROM domain_outbox WHERE published_at IS NULL`,
      ),
    );
    return this.database.systemTx(async (tx) => {
      const counts = await rows<{ action: string; outcome: string; n: number }>(
        tx,
        sql`SELECT action, outcome, count(*)::int AS n FROM security_audit_log
             WHERE company_id = ${actor.companyId} AND occurred_at > now() - make_interval(mins => ${windowMinutes}::int)
             GROUP BY action, outcome`,
      );
      const counters: Record<string, number> = {};
      for (const g of OVERVIEW_GROUPS) {
        counters[g.key] = counts
          .filter((c) => g.actions.includes(c.action) && (!g.outcome || c.outcome === g.outcome))
          .reduce((s, c) => s + c.n, 0);
      }
      const alerts = await rows<{ severity: Severity; n: number }>(
        tx,
        sql`SELECT severity, count(*)::int AS n FROM security_alerts WHERE company_id = ${actor.companyId} AND status = 'OPEN' GROUP BY severity`,
      );
      const chain = await row<{ seq: string; verified_at: Date | string; last_result: string; broken_at_seq: string | null }>(
        tx,
        sql`SELECT seq::text, verified_at, last_result, broken_at_seq::text FROM audit_chain_checkpoints WHERE chain_key = ${actor.companyId}`,
      );
      return {
        windowMinutes,
        generatedAt: new Date().toISOString(),
        counters,
        openAlerts: Object.fromEntries(
          (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((s) => [s, alerts.find((a) => a.severity === s)?.n ?? 0]),
        ),
        auditChain: chain
          ? {
              verifiedSeq: chain.seq,
              verifiedAt: asDate(chain.verified_at)!.toISOString(),
              result: chain.last_result,
              brokenAtSeq: chain.broken_at_seq,
            }
          : null,
        outbox: { pending: outbox.n, oldestPendingAt: outbox.oldest ? asDate(outbox.oldest)!.toISOString() : null },
        monitor: {
          intervalSeconds: this.cfg.SECURITY_MONITOR_INTERVAL_SECONDS,
          channels: this.sinks.map((s) => s.name),
          rules: COUNT_RULES.filter((r) => r.scope === 'company').map((r) => ({
            id: r.id,
            severity: r.severity,
            threshold: r.threshold,
            windowMinutes: r.windowMinutes,
          })),
        },
      };
    });
  }

  /** Alerts of the caller's company (admin.audit.read). System alerts are never listed. */
  async alerts(actor: Actor, q: z.infer<typeof SecurityAlertsQuery>) {
    requirePermission(actor, 'admin.audit.read');
    const statusFilter = q.status === 'ALL' ? sql`` : sql`AND a.status = ${q.status}`;
    return this.database.systemTx((tx) =>
      rows(
        tx,
        sql`SELECT a.id, a.rule, a.severity, a.status, a.occurrences, a.window_minutes AS "windowMinutes", a.details,
                   a.first_seen_at AS "firstSeenAt", a.last_seen_at AS "lastSeenAt", a.acknowledged_at AS "acknowledgedAt",
                   u.display_name AS "acknowledgedBy", a.ack_note AS "ackNote", a.notified_at AS "notifiedAt"
              FROM security_alerts a LEFT JOIN users u ON u.id = a.acknowledged_by
             WHERE a.company_id = ${actor.companyId} ${statusFilter}
             ORDER BY (a.status = 'OPEN') DESC, a.first_seen_at DESC LIMIT ${q.limit}`,
      ),
    );
  }

  /**
   * Acknowledges an open alert of the caller's company (admin.security + step-up, audited).
   * One-way: an acknowledged alert cannot be reopened or re-acknowledged (also enforced by a
   * database trigger). Another company's alert id → 404 (no existence oracle).
   */
  async acknowledge(actor: Actor, id: string, input: z.infer<typeof AcknowledgeAlertInput>) {
    requirePermission(actor, 'admin.security');
    requireStepUp(actor, 'security.alert.ack', this.cfg.STEP_UP_MINUTES);
    return this.database.systemTx(async (tx) => {
      const current = await row<{ status: string }>(
        tx,
        sql`SELECT status FROM security_alerts WHERE id = ${id} AND company_id = ${actor.companyId} FOR UPDATE`,
      );
      if (!current) throw new NotFound('Alerta');
      if (current.status !== 'OPEN') throw new Conflict('O alerta já foi marcado como visto', 'ALERT_ALREADY_ACKNOWLEDGED');
      await tx.execute(sql`UPDATE security_alerts SET status = 'ACKNOWLEDGED', acknowledged_at = now(),
                             acknowledged_by = ${actor.userId}, ack_note = ${input.note || null} WHERE id = ${id}`);
      await this.audit.recordInTx(tx, {
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: 'security.alert.acknowledged',
        resourceType: 'security_alert',
        resourceId: id,
        outcome: 'SUCCESS',
        requestId: actor.requestId,
        clientIp: actor.clientIp,
        details: { withNote: !!input.note },
      });
      return { id, status: 'ACKNOWLEDGED' as const };
    });
  }
}
