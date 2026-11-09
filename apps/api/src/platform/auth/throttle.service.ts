/**
 * @file Database-backed throttling with exponential backoff (login, MFA, one-time tokens).
 * @module platform/auth
 *
 * Stored in PostgreSQL so limits hold across API instances and restarts. Each key accumulates
 * failures within a 15-minute window; once `threshold` is reached the key is locked for
 * 30 s × 2^(failures − threshold), capped at 15 minutes (gradual backoff, NIST 800-63B §3.2.2).
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/database.js';
import { asDate, row } from '../../db/database.js';
import { RateLimited } from '../../common/errors.js';

const WINDOW_MS = 15 * 60_000;
const MAX_LOCK_MS = 15 * 60_000;

/** Throttle helper. Keys are namespaced strings such as `login:user@x.pt` or `ip:10.0.0.1`. */
export class ThrottleService {
  constructor(
    private readonly database: Database,
    private readonly enabled: boolean,
  ) {}

  /** Throws RateLimited when any key is currently locked. */
  async assertAllowed(keys: string[]): Promise<void> {
    if (!this.enabled) return;
    for (const key of keys) {
      const r = await this.database.systemTx((tx) =>
        row<{ locked_until: Date | null }>(tx, sql`SELECT locked_until FROM auth_throttle WHERE throttle_key = ${key}`),
      );
      const until = asDate(r?.locked_until);
      if (until && until.getTime() > Date.now()) {
        throw new RateLimited(Math.ceil((until.getTime() - Date.now()) / 1000));
      }
    }
  }

  /** Records a failure for `key`; locks it once `threshold` failures occur in the window. */
  async recordFailure(key: string, threshold: number): Promise<void> {
    if (!this.enabled) return;
    await this.database.systemTx(async (tx) => {
      const r = await row<{ failures: number; window_started_at: Date }>(
        tx,
        sql`INSERT INTO auth_throttle (throttle_key, failures) VALUES (${key}, 1)
            ON CONFLICT (throttle_key) DO UPDATE SET
              failures = CASE WHEN auth_throttle.window_started_at < now() - make_interval(secs => ${WINDOW_MS / 1000})
                              THEN 1 ELSE auth_throttle.failures + 1 END,
              window_started_at = CASE WHEN auth_throttle.window_started_at < now() - make_interval(secs => ${WINDOW_MS / 1000})
                              THEN now() ELSE auth_throttle.window_started_at END
            RETURNING failures, window_started_at`,
      );
      if (r && r.failures >= threshold) {
        const lockMs = Math.min(30_000 * 2 ** (r.failures - threshold), MAX_LOCK_MS);
        await tx.execute(
          sql`UPDATE auth_throttle SET locked_until = now() + make_interval(secs => ${lockMs / 1000}) WHERE throttle_key = ${key}`,
        );
      }
    });
  }

  /** Clears a key after a successful authentication. */
  async clear(key: string): Promise<void> {
    await this.database.systemTx((tx) => tx.execute(sql`DELETE FROM auth_throttle WHERE throttle_key = ${key}`));
  }
}
