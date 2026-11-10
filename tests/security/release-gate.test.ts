/**
 * @file The WMS release-gate guard is fail-closed: a status file that claims production
 * readiness without every criterion passing and without named approvals is rejected, and a PASS
 * without evidence is rejected (owning module: tests / release management).
 * @module tests/security
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const real = JSON.parse(readFileSync(join(root, 'docs/WMS_RELEASE_STATUS.json'), 'utf8'));

function check(status: unknown) {
  const f = join(mkdtempSync(join(tmpdir(), 'gate-')), 'status.json');
  writeFileSync(f, JSON.stringify(status));
  return spawnSync(process.execPath, [join(root, 'scripts/wms-gate.mjs'), '--no-render-check'], {
    env: { ...process.env, WMS_GATE_JSON: f },
    encoding: 'utf8',
  });
}

describe('WMS release gate guard', () => {
  it('accepts the committed status and the committed rendering is current', () => {
    const r = spawnSync(process.execPath, [join(root, 'scripts/wms-gate.mjs')], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(real.state).toBe('WMS_IN_PROGRESS');
  });

  it('refuses WMS_PRODUCTION_READY while criteria are not PASS or approvals are missing', () => {
    const r = check({ ...real, state: 'WMS_PRODUCTION_READY' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/criteria not PASS/);
    expect(r.stderr).toMatch(/release-owner approval/);
    const allPass = real.criteria.map((c: Record<string, unknown>) => ({
      ...c,
      status: 'PASS',
      evidence: ['x'],
      verifiedAt: 'd',
      reviewer: 'r',
    }));
    const noApproval = check({ ...real, state: 'AWAITING_NEXT_MODULE_SELECTION', criteria: allPass });
    expect(noApproval.status).toBe(1);
    expect(noApproval.stderr).toMatch(/independent security review/);
  });

  it('refuses a PASS without evidence and a release candidate with FAIL items', () => {
    const forged = real.criteria.map((c: Record<string, unknown>, i: number) => (i === 0 ? { ...c, status: 'PASS', evidence: [] } : c));
    expect(check({ ...real, criteria: forged }).stderr).toMatch(/PASS requires evidence/);
    expect(check({ ...real, state: 'WMS_RELEASE_CANDIDATE' }).stderr).toMatch(/no FAIL criteria/);
  });
});
