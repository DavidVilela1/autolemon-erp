/**
 * @file Transactional outbox dispatcher (PostgreSQL-only background job, no message broker).
 * @module platform/outbox
 *
 * Polls unpublished events with FOR UPDATE SKIP LOCKED (safe with several API instances),
 * hands them to in-process subscribers registered by enabled modules and marks them published.
 * Each company's events are processed inside that company's RLS context so a subscriber can
 * never read another tenant's data through the same transaction. In WMS-only mode there are no
 * subscribers: events are simply marked published (they remain queryable for integrations).
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/database.js';
import { rows } from '../../db/database.js';

/** A published domain event as delivered to subscribers. */
export interface DomainEvent {
  id: string;
  companyId: string;
  warehouseId: string | null;
  type: string;
  version: number;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** Subscriber callback; must be idempotent (at-least-once delivery). */
export type Subscriber = (event: DomainEvent) => Promise<void>;

/** Outbox polling dispatcher. */
export class OutboxDispatcher {
  private readonly subscribers: Subscriber[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly database: Database) {}

  /** Registers an in-process subscriber (used by future modules). */
  subscribe(fn: Subscriber): void {
    this.subscribers.push(fn);
  }

  /** Processes up to `batch` pending events per company. Returns the number published. */
  async runOnce(batch = 100): Promise<number> {
    const companies = await this.database.systemTx((tx) => rows<{ id: string }>(tx, sql`SELECT id FROM companies ORDER BY id`));
    let published = 0;
    for (const c of companies) {
      published += await this.database.tenantTx({ companyId: c.id, whScope: '*' }, async (tx) => {
        const events = await rows<{
          id: string;
          company_id: string;
          warehouse_id: string | null;
          event_type: string;
          event_version: number;
          aggregate_type: string;
          aggregate_id: string;
          payload: Record<string, unknown>;
          created_at: Date;
        }>(
          tx,
          sql`SELECT * FROM domain_outbox WHERE company_id = ${c.id} AND published_at IS NULL ORDER BY id LIMIT ${batch} FOR UPDATE SKIP LOCKED`,
        );
        for (const e of events) {
          const ev: DomainEvent = {
            id: e.id,
            companyId: e.company_id,
            warehouseId: e.warehouse_id,
            type: e.event_type,
            version: e.event_version,
            aggregateType: e.aggregate_type,
            aggregateId: e.aggregate_id,
            payload: e.payload,
            createdAt: e.created_at,
          };
          for (const s of this.subscribers) await s(ev);
          await tx.execute(sql`UPDATE domain_outbox SET published_at = now(), attempts = attempts + 1 WHERE id = ${e.id}`);
        }
        return events.length;
      });
    }
    return published;
  }

  /** Starts periodic polling. */
  start(intervalMs = 5000, onError: (e: unknown) => void = () => undefined): void {
    this.timer = setInterval(() => void this.runOnce().catch(onError), intervalMs);
    this.timer.unref();
  }

  /** Stops polling. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
