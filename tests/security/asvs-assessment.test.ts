/**
 * @file The ASVS 5.0.0 L1+L2 requirement-level assessment is complete, consistent and current
 * (ADR-0028): every canonical requirement assessed once, evidence files exist, I+T cites a test,
 * the generated Markdown is up to date — and the checker really fails on bad input.
 * @module tests/security
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../..');
const script = join(repo, 'scripts/asvs-report.mjs');
const assessmentPath = join(repo, 'docs/security/asvs/assessment.json');
const canon = JSON.parse(readFileSync(join(repo, 'docs/security/asvs/asvs-5.0.0-l1-l2.json'), 'utf8'));

function check(assessment?: unknown) {
  const env = { ...process.env };
  if (assessment !== undefined) {
    const file = join(mkdtempSync(join(tmpdir(), 'asvs-')), 'assessment.json');
    writeFileSync(file, JSON.stringify(assessment));
    env.ASSESSMENT_JSON = file;
  }
  return spawnSync(process.execPath, [script, '--check'], { env, encoding: 'utf8' });
}

describe('ASVS 5.0.0 L2 requirement-level assessment', () => {
  it('covers all 253 L1+L2 requirements of the pinned CSV and the generated report is current', () => {
    expect(canon.requirements).toHaveLength(253);
    expect(canon.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    const r = check();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('fails closed on a missing requirement, a fake I+T, missing evidence or an unknown status', () => {
    const base = JSON.parse(readFileSync(assessmentPath, 'utf8'));
    const clone = () => JSON.parse(JSON.stringify(base));

    const missing = clone();
    missing.requirements = missing.requirements.filter((x: { id: string }) => x.id !== 'V8.2.2');
    expect(check(missing).stderr).toMatch(/V8\.2\.2: not assessed/);

    const fakeTested = clone();
    const sec = fakeTested.requirements.find((x: { id: string }) => x.id === 'V6.2.1');
    sec.evidence = ['docs/security/AUTH_AND_RBAC.md'];
    expect(check(fakeTested).stderr).toMatch(/V6\.2\.1: I\+T without a test file/);

    const ghost = clone();
    ghost.requirements[0].evidence = ['tests/security/does-not-exist.test.ts'];
    expect(check(ghost).stderr).toMatch(/evidence not found/);

    const status = clone();
    status.requirements[0].status = 'PASS';
    const r = check(status);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown status PASS/);
  });
});
