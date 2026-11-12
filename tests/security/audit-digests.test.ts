/**
 * @file Signed audit-chain digests (SEC-OPEN-008; ADR-0027): digest content and signature,
 * forgery/wrong-key/format rejection, detection of a CONSISTENT superuser rewrite that the hash
 * chain alone cannot see, truncation and plain tampering, and the CLI (key handling, exit codes).
 * @module tests/security
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuditRow, computeEntryHash } from '../../apps/api/src/platform/audit/audit.service.js';
import {
  type AuditDigest,
  createDigest,
  generateDigestKeyPair,
  parseAndVerifyDigest,
  verifyDigestsAgainstDb,
} from '../../apps/api/src/platform/audit/digest.js';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let A: Tenant;
let B: Tenant;
const keys = generateDigestKeyPair();
const priv = createPrivateKey(keys.privatePem);
const pub = createPublicKey(keys.publicPem);

beforeAll(async () => {
  t = await startApp();
  A = await tenant(t, 'DIG-A', ['W1']);
  B = await tenant(t, 'DIG-B', ['W1']);
  await events(A.companyId, 4);
  await events(B.companyId, 4);
});
afterAll(async () => {
  await t?.close();
});

async function events(companyId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await t.services.audit.record({
      companyId,
      action: 'auth.password_change',
      outcome: 'SUCCESS',
      clientIp: '198.51.100.23',
      details: { i },
    });
  }
}

/** Round-trips a digest through JSON and checks it like the CLI does. */
function reparse(d: AuditDigest): AuditDigest {
  return parseAndVerifyDigest(JSON.parse(JSON.stringify(d)), pub);
}

async function withTriggerOff<T>(fn: () => Promise<T>): Promise<T> {
  await t.owner.query('ALTER TABLE security_audit_log DISABLE TRIGGER security_audit_append_only');
  try {
    return await fn();
  } finally {
    await t.owner.query('ALTER TABLE security_audit_log ENABLE TRIGGER security_audit_append_only');
  }
}

describe('Digest content and signature', () => {
  it('records every chain head, carries no audit contents, verifies, and stays valid as chains grow', async () => {
    const d = reparse(await createDigest(t.services.database, priv));
    expect(d.keyId).toBe(keys.keyId);
    for (const ten of [A, B]) {
      const head = await t.owner.query('SELECT max(seq)::text AS seq FROM security_audit_log WHERE chain_key = $1', [ten.companyId]);
      expect(d.chains.find((c) => c.chainKey === ten.companyId)?.seq).toBe(head.rows[0].seq);
    }
    const text = JSON.stringify(d);
    expect(text).not.toContain('198.51.100.23');
    expect(text).not.toContain('password_change');

    await events(A.companyId, 2);
    // Scope to this file's chains: other files share the test database and tamper with theirs.
    const mine = { ...d, chains: d.chains.filter((c) => [A.companyId, B.companyId].includes(c.chainKey)) };
    const r = await verifyDigestsAgainstDb(t.services.audit, [{ source: 'd1', digest: mine }]);
    expect(r).toMatchObject({ ok: true, problems: [] });
    expect(r.chains).toBe(2);
  });

  it('rejects forged, foreign-key, malformed and non-Ed25519 inputs', async () => {
    const d = await createDigest(t.services.database, priv);
    const forged = JSON.parse(JSON.stringify(d)) as AuditDigest;
    forged.chains[0]!.hash = 'f'.repeat(64);
    expect(() => parseAndVerifyDigest(forged, pub)).toThrow(/signature does not verify/);

    const other = generateDigestKeyPair();
    expect(() => parseAndVerifyDigest(d, createPublicKey(other.publicPem))).toThrow(/another key/);
    expect(() => parseAndVerifyDigest({ ...d, extra: 1 }, pub)).toThrow(/not a valid/);
    expect(() => parseAndVerifyDigest({ ...d, chains: [{ chainKey: 'x', seq: '1', hash: 'a' }] }, pub)).toThrow(/not a valid/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => parseAndVerifyDigest(d, rsa.publicKey)).toThrow(/Ed25519/);
    await expect(createDigest(t.services.database, rsa.privateKey)).rejects.toThrow(/Ed25519/);
  });
});

describe('CLI', () => {
  const repo = resolve(import.meta.dirname, '../..');
  // Run tsx's JS entry with the current Node: node_modules/.bin/tsx is a .cmd shim on Windows,
  // which spawnSync cannot start without a shell (status null).
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  const cli = join(repo, 'apps/api/src/db/cli/audit-digest.ts');
  const env = {
    ...process.env,
    SKIP_DOTENV: '1',
    LOCAL_DEV_KEKS: process.env.TEST_KEKS ?? `test-kek-a:${randomBytes(32).toString('base64')}`,
    CSRF_SECRET: randomBytes(32).toString('base64'),
    WEB_ORIGIN: 'http://localhost:5173',
  };
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [tsxCli, cli, ...args], { env, encoding: 'utf8', timeout: 60_000 });
    if (r.error) throw r.error; // a spawn failure must not look like "exit code null"
    return r;
  };

  it('keygen refuses the repository, writes a 0600 private key once; create + verify exit 0; tampering exits 1; usage exits 2', async () => {
    expect(run('keygen', '--out-dir', join(repo, 'docs')).status).toBe(2);

    const dir = mkdtempSync(join(tmpdir(), 'autolemon-digest-'));
    const kg = run('keygen', '--out-dir', dir);
    expect(kg.status).toBe(0);
    const privFile = readdirSync(dir).find((f) => f.endsWith('.private.pem'))!;
    const pubFile = readdirSync(dir).find((f) => f.endsWith('.public.pem'))!;
    // POSIX permission bits do not exist on Windows (Node reports 0o666); protect the key with NTFS ACLs there.
    if (process.platform !== 'win32') expect(statSync(join(dir, privFile)).mode & 0o777).toBe(0o600);
    expect(kg.stdout).not.toContain('PRIVATE KEY'); // the key itself is never printed

    const out = mkdtempSync(join(tmpdir(), 'autolemon-digests-'));
    expect(run('create', '--key', join(dir, privFile), '--out-dir', out).status).toBe(0);
    const [digestFile] = readdirSync(out);
    expect(statSync(join(out, digestFile!)).mode & 0o222).toBe(0); // written read-only
    expect(JSON.parse(readFileSync(join(out, digestFile!), 'utf8')).format).toBe('autolemon.audit-digest');

    const scope = ['--chain', A.companyId, '--chain', B.companyId];
    const ok = run('verify', '--pub', join(dir, pubFile), ...scope, out);
    expect(ok.stdout).toContain('OK:');
    expect(ok.status).toBe(0);

    await events(A.companyId, 1);
    const last = await t.owner.query('SELECT max(seq) AS s FROM security_audit_log WHERE chain_key = $1', [A.companyId]);
    const d = JSON.parse(readFileSync(join(out, digestFile!), 'utf8')) as AuditDigest;
    expect(BigInt(d.chains.find((c) => c.chainKey === A.companyId)!.seq)).toBeLessThan(BigInt(last.rows[0].s));
    await withTriggerOff(() =>
      t.owner.query(`UPDATE security_audit_log SET details = '{"y":2}' WHERE chain_key = $1 AND seq = 1`, [A.companyId]),
    );
    const bad = run('verify', '--pub', join(dir, pubFile), ...scope, out);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/CHAIN_BROKEN|HASH_MISMATCH/);

    expect(run('verify').status).toBe(2);
    expect(run('frobnicate').status).toBe(2);
  });
});

describe('Tamper detection against signed digests', () => {
  it('detects a CONSISTENT rewrite (all later hashes recomputed) that the chain check alone accepts', async () => {
    const d = reparse(await createDigest(t.services.database, priv));
    await events(A.companyId, 2); // entries after the digest are rewritten too

    // Superuser attack: change entry 2 and recompute every later hash so the chain still verifies.
    await withTriggerOff(async () => {
      await t.owner.query(`UPDATE security_audit_log SET details = '{"i":"forged"}' WHERE chain_key = $1 AND seq = 2`, [A.companyId]);
      const all = (
        await t.owner.query<AuditRow & { id: string }>('SELECT * FROM security_audit_log WHERE chain_key = $1 ORDER BY seq', [A.companyId])
      ).rows;
      let prev: Buffer = Buffer.alloc(32);
      for (const e of all) {
        const h = computeEntryHash(prev, { ...e, prev_hash: prev });
        await t.owner.query('UPDATE security_audit_log SET prev_hash = $1, hash = $2 WHERE id = $3', [prev, h, e.id]);
        prev = h;
      }
    });
    expect(await t.services.audit.verifyChain(A.companyId)).toMatchObject({ ok: true }); // invisible to the chain alone

    const r = await verifyDigestsAgainstDb(t.services.audit, [{ source: 'before-rewrite.json', digest: d }]);
    expect(r.ok).toBe(false);
    expect(r.problems.filter((p) => p.chainKey === A.companyId)).toEqual([
      expect.objectContaining({ source: 'before-rewrite.json', chainKey: A.companyId, problem: 'HASH_MISMATCH' }),
    ]);
  });

  it('detects deleted entries (truncation) and a plain inconsistent edit', async () => {
    const d = reparse(await createDigest(t.services.database, priv));
    await withTriggerOff(() =>
      t.owner.query(
        'DELETE FROM security_audit_log WHERE chain_key = $1 AND seq > (SELECT max(seq) - 2 FROM security_audit_log WHERE chain_key = $1)',
        [B.companyId],
      ),
    );
    let r = await verifyDigestsAgainstDb(t.services.audit, [{ source: 'd', digest: d }]);
    expect(r.problems.find((p) => p.chainKey === B.companyId)).toMatchObject({ problem: 'ENTRIES_MISSING' });

    const C = await tenant(t, 'DIG-C', ['W1']);
    await events(C.companyId, 3);
    const d2 = reparse(await createDigest(t.services.database, priv));
    await withTriggerOff(() =>
      t.owner.query(`UPDATE security_audit_log SET details = '{"x":1}' WHERE chain_key = $1 AND seq = 1`, [C.companyId]),
    );
    r = await verifyDigestsAgainstDb(t.services.audit, [{ source: 'd2', digest: d2 }]);
    expect(r.problems.find((p) => p.chainKey === C.companyId)).toMatchObject({ problem: 'CHAIN_BROKEN' });
  });
});
