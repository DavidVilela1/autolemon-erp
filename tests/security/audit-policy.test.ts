/**
 * @file Dependency-audit policy of `pnpm security:scan` (scripts/lib.mjs evaluateAudit): HIGH/
 * CRITICAL advisories in production dependencies always block; dev-only ones block unless the exact
 * advisory has an unexpired, at most 90-day exception in docs/security/audit-exceptions.json.
 * @module tests/security
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_EXCEPTION_MAX_DAYS, evaluateAudit } from '../../scripts/lib.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const high = { id: 'GHSA-aaaa', severity: 'high', module: 'pkg' };
const exception = (expires: string, recorded = '2026-11-18') => ({ advisory: 'GHSA-aaaa', recorded, expires });

describe('Dependency-audit policy', () => {
  it('a HIGH advisory in a production dependency blocks, even with an exception', () => {
    const r = evaluateAudit({
      advisories: [high],
      prodIds: new Set(['GHSA-aaaa']),
      exceptions: [exception('2026-12-01')],
      today: '2026-11-18',
    });
    expect(r.ok).toBe(false);
    expect(r.blocking.join()).toMatch(/production dependency/);
  });

  it('a dev-only HIGH advisory blocks without an exception and passes with a valid one', () => {
    expect(evaluateAudit({ advisories: [high], prodIds: new Set(), exceptions: [], today: '2026-11-18' }).ok).toBe(false);
    const r = evaluateAudit({ advisories: [high], prodIds: new Set(), exceptions: [exception('2026-12-01')], today: '2026-11-18' });
    expect(r).toMatchObject({ ok: true, blocking: [] });
    expect(r.accepted.join()).toMatch(/accepted until 2026-12-01/);
  });

  it('an expired or over-long exception blocks; one for a vanished advisory is only a warning', () => {
    expect(evaluateAudit({ advisories: [high], prodIds: new Set(), exceptions: [exception('2026-11-17')], today: '2026-11-18' }).ok).toBe(
      false,
    );
    const long = evaluateAudit({ advisories: [high], prodIds: new Set(), exceptions: [exception('2027-06-01')], today: '2026-11-18' });
    expect(long.blocking.join()).toMatch(new RegExp(`longer than ${AUDIT_EXCEPTION_MAX_DAYS} days`));
    const stale = evaluateAudit({ advisories: [], prodIds: new Set(), exceptions: [exception('2026-12-01')], today: '2026-11-18' });
    expect(stale).toMatchObject({ ok: true });
    expect(stale.warnings.join()).toMatch(/no longer needed/);
  });

  it('moderate and low advisories are reported but never block', () => {
    const moderate = { id: 'GHSA-bbbb', severity: 'moderate', module: 'm' };
    expect(evaluateAudit({ advisories: [moderate], prodIds: new Set(['GHSA-bbbb']), exceptions: [], today: '2026-11-18' }).ok).toBe(true);
  });

  it('the repository exceptions file is well formed: one advisory id each, reason, open item, ≤ 90 days', () => {
    const { exceptions } = JSON.parse(readFileSync(resolve(ROOT, 'docs/security/audit-exceptions.json'), 'utf8')) as {
      exceptions: Array<Record<string, string>>;
    };
    expect(exceptions.length).toBeGreaterThan(0);
    for (const e of exceptions) {
      expect(e.advisory).toMatch(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
      expect(e.reason!.length).toBeGreaterThan(40);
      expect(e.openItem).toMatch(/^SEC-OPEN-\d{3}$/);
      expect(Date.parse(e.expires!) - Date.parse(e.recorded!)).toBeLessThanOrEqual(AUDIT_EXCEPTION_MAX_DAYS * 86_400_000);
    }
  });
});
