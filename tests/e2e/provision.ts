/**
 * @file E2E helper: provisions a synthetic tenant on the disposable test DB and prints the
 * one-time invitation token as JSON (owning module: tests/e2e).
 */
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../../apps/api/src/config/env.js';
import { buildServices } from '../../apps/api/src/composition.js';
import { provisionTenant } from '../../apps/api/src/platform/tenant/provision.js';

const s = buildServices(loadConfig());
const suffix = randomBytes(3).toString('hex');
const email = `e2e-admin-${suffix}@example.test`;
const r = await provisionTenant(s.database, s.auth, {
  code: `E2E-${suffix.toUpperCase()}`,
  name: 'Empresa E2E',
  adminEmail: email,
  adminName: 'Admin E2E',
  warehouses: [
    { code: 'PORTO', name: 'Armazém Porto' },
    { code: 'LISBOA', name: 'Armazém Lisboa' },
  ],
});
process.stdout.write(JSON.stringify({ token: r.invitationToken, email }));
await s.database.close();
