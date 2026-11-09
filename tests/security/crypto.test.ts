/**
 * @file Scenario 13: application-level encryption — ciphertext ≠ plaintext, tamper detection,
 * tenant/record/field binding, unauthorized denial, DEK rotation with re-encryption, KEK rewrap,
 * and refusal of the development key provider in production. Uses real PostgreSQL.
 * @module tests/security
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config/env.js';
import { Database } from '../../apps/api/src/db/database.js';
import { DecryptionError, FieldCrypto } from '../../apps/api/src/platform/crypto/field-crypto.js';
import { LocalDevKeyProvider } from '../../apps/api/src/platform/crypto/key-provider.js';
import { ok, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

const kekA = `kek-a:${randomBytes(32).toString('base64')}`;
const kekB = `kek-b:${randomBytes(32).toString('base64')}`;
let t: TestApp;
let A: Tenant;
let B: Tenant;
let db: Database;

beforeAll(async () => {
  process.env.TEST_KEKS = kekA;
  t = await startApp();
  A = await tenant(t, 'ENC-A', ['W']);
  B = await tenant(t, 'ENC-B', ['W']);
  db = new Database({ APP_DATABASE_URL: process.env.APP_DATABASE_URL!, DB_SSL: 'disable', DB_POOL_MAX: 3 });
});
afterAll(async () => {
  delete process.env.TEST_KEKS;
  await db?.close();
  await t?.close();
});

describe('Field encryption (AES-256-GCM, envelope keys)', () => {
  const ref = (companyId: string, recordId = '11111111-1111-4111-8111-111111111111') => ({
    companyId,
    table: 'users',
    recordId,
    field: 'phone',
  });

  it('round-trips and produces different ciphertext each time (random nonce), never containing plaintext', async () => {
    const fc = new FieldCrypto(db, new LocalDevKeyProvider(kekA));
    const c1 = await fc.encrypt(ref(A.companyId), '+351 900 000 001');
    const c2 = await fc.encrypt(ref(A.companyId), '+351 900 000 001');
    expect(c1).not.toBe(c2);
    expect(c1).not.toContain('900');
    expect(await fc.decrypt(ref(A.companyId), c1)).toBe('+351 900 000 001');
  });

  it('detects tampering of nonce, ciphertext or tag (fail closed)', async () => {
    const fc = new FieldCrypto(db, new LocalDevKeyProvider(kekA));
    const c = await fc.encrypt(ref(A.companyId), 'segredo comercial');
    const parts = c.split('.');
    const flip = (s: string) => (s[5] === 'A' ? `${s.slice(0, 5)}B${s.slice(6)}` : `${s.slice(0, 5)}A${s.slice(6)}`);
    for (const bad of [
      [parts[0], parts[1], flip(parts[2]!), parts[3]].join('.'),
      [parts[0], parts[1], parts[2], flip(parts[3]!)].join('.'),
      [parts[0], '99', parts[2], parts[3]].join('.'),
      'plaintext-not-an-envelope',
    ]) {
      await expect(fc.decrypt(ref(A.companyId), bad)).rejects.toBeInstanceOf(DecryptionError);
    }
  });

  it('is bound to tenant, record and field (transplanted ciphertext fails)', async () => {
    const fc = new FieldCrypto(db, new LocalDevKeyProvider(kekA));
    const c = await fc.encrypt(ref(A.companyId), 'dados');
    await expect(fc.decrypt(ref(B.companyId), c)).rejects.toBeInstanceOf(DecryptionError);
    await expect(fc.decrypt(ref(A.companyId, randomUUID()), c)).rejects.toBeInstanceOf(DecryptionError);
    await expect(fc.decrypt({ ...ref(A.companyId), field: 'other' }, c)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('stores only wrapped DEKs; a different KEK cannot unwrap them', async () => {
    const r = await t.owner.query('SELECT wrapped_dek, kek_id FROM tenant_data_keys WHERE company_id = $1', [A.companyId]);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows[0].wrapped_dek.length).toBe(60);
    const wrong = new FieldCrypto(db, new LocalDevKeyProvider(kekB));
    const good = new FieldCrypto(db, new LocalDevKeyProvider(kekA));
    const c = await good.encrypt(ref(A.companyId), 'x');
    await expect(wrong.decrypt(ref(A.companyId), c)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('DEK rotation re-encrypts stored fields with the new version; old backups stay readable', async () => {
    // Real encrypted data: a user phone created through the API.
    const u = ok(
      await A.admin.post('/api/admin/users', {
        email: `rot-${randomUUID().slice(0, 6)}@x.test`,
        displayName: 'Rot',
        role: 'STAFF',
        warehouseId: A.wh.W,
        permissions: [],
        phone: '+351 911 111 111',
      }),
    );
    const before = (await t.owner.query('SELECT phone_enc FROM users WHERE id = $1', [u.id])).rows[0].phone_enc as string;
    const vBefore = FieldCrypto.envelopeVersion(before)!;
    expect((await A.admin.post('/api/admin/keys/rotate')).status).toBe(403); // step-up required
    await A.admin.stepUp();
    const rot = ok(await A.admin.post('/api/admin/keys/rotate'));
    expect(rot.newVersion).toBe(vBefore + 1);
    expect(rot.reencrypted).toBeGreaterThanOrEqual(2); // phone + admin TOTP seed
    const after = (await t.owner.query('SELECT phone_enc FROM users WHERE id = $1', [u.id])).rows[0].phone_enc as string;
    expect(FieldCrypto.envelopeVersion(after)).toBe(vBefore + 1);
    expect(after).not.toBe(before);
    await A.admin.stepUp(); // TOTP secret was re-encrypted: MFA must still work
    expect(ok(await A.admin.get(`/api/admin/users/${u.id}/pii`)).phone).toBe('+351 911 111 111');
    // A pre-rotation ciphertext (e.g. from a backup) still decrypts with the retired version.
    const fc = new FieldCrypto(db, new LocalDevKeyProvider(kekA));
    expect(await fc.decrypt({ companyId: A.companyId, table: 'users', recordId: u.id, field: 'phone' }, before)).toBe('+351 911 111 111');
  });

  it('KEK rotation rewraps every DEK; data stays readable only with the new keyring', async () => {
    const fcOld = new FieldCrypto(db, new LocalDevKeyProvider(kekA));
    const c = await fcOld.encrypt(ref(B.companyId), 'antes da rotação');
    // New keyring: kek-b active, kek-a retained for unwrap during rotation.
    const rotating = new FieldCrypto(db, new LocalDevKeyProvider(`${kekB},${kekA}`));
    const n = await rotating.rewrapAllDeks([A.companyId, B.companyId]);
    expect(n).toBeGreaterThan(0);
    const ids = await t.owner.query(`SELECT DISTINCT kek_id FROM tenant_data_keys WHERE company_id = ANY($1)`, [
      [A.companyId, B.companyId],
    ]);
    expect(ids.rows.map((r) => r.kek_id)).toEqual(['kek-b']);
    const onlyNew = new FieldCrypto(db, new LocalDevKeyProvider(kekB));
    expect(await onlyNew.decrypt(ref(B.companyId), c)).toBe('antes da rotação');
    const onlyOld = new FieldCrypto(db, new LocalDevKeyProvider(kekA));
    await expect(onlyOld.decrypt(ref(B.companyId), c)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('refuses the local development key provider and other unsafe settings in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        APP_DATABASE_URL: 'postgres://x@db/x',
        KEY_PROVIDER: 'local-dev',
        LOCAL_DEV_KEKS: kekA,
        CSRF_SECRET: randomBytes(32).toString('base64'),
        DB_SSL: 'disable',
        WEB_ORIGIN: 'http://erp.example',
      }),
    ).toThrow(/KEY_PROVIDER=local-dev is forbidden.*DB_SSL must be verify-full.*WEB_ORIGIN must be https/);
  });
});
