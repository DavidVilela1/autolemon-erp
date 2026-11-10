/**
 * @file Data-retention purge job (owning module: platform).
 * @module platform/retention
 *
 * Calls the SECURITY DEFINER function app_retention_purge (migration 0006): the runtime role
 * has no direct DELETE on the purged tables, and the function itself refuses windows shorter
 * than 7 days. Only expired operational data is removed — never inventory history, documents
 * or the security audit log. Each run with deletions is recorded in the audit log.
 */
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/database.js';
import { one } from '../../db/database.js';
import type { AuditService } from '../audit/audit.service.js';

/** Rows deleted per table by one purge run. */
export interface PurgeResult {
  commandLog: number;
  sessions: number;
  oneTimeTokens: number;
  domainOutbox: number;
  authThrottle: number;
}

/** Periodic retention purge. */
export class RetentionService {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly database: Database,
    private readonly cfg: Pick<
      AppConfig,
      'RETENTION_COMMAND_LOG_DAYS' | 'RETENTION_SESSION_DAYS' | 'RETENTION_TOKEN_DAYS' | 'RETENTION_OUTBOX_DAYS'
    >,
    private readonly audit: AuditService,
  ) {}

  /** Runs one purge with the configured windows. */
  async runOnce(): Promise<PurgeResult> {
    const r = await this.database.systemTx((tx) =>
      one<Record<string, string>>(
        tx,
        sql`SELECT * FROM app_retention_purge(${this.cfg.RETENTION_COMMAND_LOG_DAYS}::int, ${this.cfg.RETENTION_SESSION_DAYS}::int,
              ${this.cfg.RETENTION_TOKEN_DAYS}::int, ${this.cfg.RETENTION_OUTBOX_DAYS}::int)`,
      ),
    );
    const result: PurgeResult = {
      commandLog: Number(r.command_log),
      sessions: Number(r.sessions),
      oneTimeTokens: Number(r.one_time_tokens),
      domainOutbox: Number(r.domain_outbox),
      authThrottle: Number(r.auth_throttle),
    };
    if (Object.values(result).some((n) => n > 0)) {
      await this.audit.record({ action: 'system.retention.purge', resourceType: 'system', outcome: 'SUCCESS', details: { ...result } });
    }
    return result;
  }

  /** Starts the periodic purge (default every 6 hours; first run after one interval). */
  start(intervalMs = 6 * 3600_000, onError: (e: unknown) => void = () => undefined): void {
    this.timer = setInterval(() => void this.runOnce().catch(onError), intervalMs);
    this.timer.unref();
  }

  /** Stops the periodic purge. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
