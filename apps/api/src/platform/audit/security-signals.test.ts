/**
 * @file Unit tests: SecuritySignals writes the first event per source and window, counts the rest,
 * summarises ended windows, keeps sources apart and bounds memory (ADR-0029).
 * @module platform/audit
 */
import { describe, expect, it } from 'vitest';
import type { AuditService } from './audit.service.js';
import { SecuritySignals, type SignalContext } from './security-signals.js';

function harness(maxKeys = 100) {
  const written: Array<Record<string, unknown>> = [];
  const audit = { record: async (ev: Record<string, unknown>) => void written.push(ev) } as unknown as AuditService;
  let now = 1_000_000;
  const s = new SecuritySignals(audit, 60_000, maxKeys, () => now);
  return { s, written, advance: (ms: number) => (now += ms) };
}

const ctx = (ip: string, companyId: string | null = 'c1'): SignalContext => ({
  companyId,
  actorUserId: 'u1',
  clientIp: ip,
  route: 'POST /api/wms/w/:wh/receipts',
  code: 'VALIDATION_FAILED',
});

describe('SecuritySignals', () => {
  it('writes the first event, suppresses the rest of the window, then writes a summary and a new first event', async () => {
    const { s, written, advance } = harness();
    for (let i = 0; i < 50; i++) await s.record('input_rejected', ctx('203.0.113.1'));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ action: 'security.input_rejected', outcome: 'DENIED', details: { errorCode: 'VALIDATION_FAILED' } });

    advance(61_000);
    await s.record('input_rejected', ctx('203.0.113.1'));
    expect(written).toHaveLength(3);
    expect(written[1]).toMatchObject({ details: { summary: true, suppressedEvents: 49 } });
    expect(written[2]).toMatchObject({ details: { errorCode: 'VALIDATION_FAILED' } });
  });

  it('keeps signals, sources and companies apart and summarises on flush; single events need no summary', async () => {
    const { s, written, advance } = harness();
    await s.record('input_rejected', ctx('203.0.113.1'));
    await s.record('input_rejected', ctx('203.0.113.2'));
    await s.record('rate_limited', ctx('203.0.113.1'));
    await s.record('rate_limited', ctx('203.0.113.1', null));
    await s.record('rate_limited', ctx('203.0.113.1', null));
    expect(written).toHaveLength(4);
    advance(61_000);
    expect(await s.flush()).toBe(4);
    expect(written).toHaveLength(5); // only the window with a suppressed event gets a summary
    expect(written[4]).toMatchObject({ companyId: null, action: 'security.rate_limited', details: { suppressedEvents: 1 } });
    expect(s.openWindows).toBe(0);
  });

  it('bounds memory: new sources beyond the cap are only counted, then reported once', async () => {
    const { s, written } = harness(3);
    for (let i = 0; i < 10; i++) await s.record('rate_limited', ctx(`198.51.100.${i}`, null));
    expect(s.openWindows).toBe(3);
    expect(written).toHaveLength(3);
    await s.flush(true);
    expect(written.at(-1)).toMatchObject({ action: 'security.signals_overflow', details: { droppedEvents: 7, maxKeys: 3 } });
  });
});
