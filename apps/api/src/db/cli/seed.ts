/**
 * @file CLI: development seed (`pnpm db:seed`). SYNTHETIC DATA ONLY — no real people/customers.
 * @module platform/db
 *
 * Creates company DEMO with warehouses PORTO and LISBOA, a realistic topology, three SKUs, an
 * administrator and two warehouse operators. Accounts start INVITED: the script prints one-time
 * invitation links (72 h) to set a password and enrol TOTP. There are no default passwords.
 * Refuses to run when NODE_ENV=production or when company DEMO already exists.
 */
import { sql } from 'drizzle-orm';
import { DEFAULT_STAFF_PERMISSIONS, PERMISSIONS, type Permission } from '@autolemon/contracts';
import { loadConfig } from '../../config/env.js';
import { buildServices } from '../../composition.js';
import { row } from '../database.js';
import type { Actor } from '../../platform/authz/actor.js';
import { provisionTenant } from '../../platform/tenant/provision.js';
import { loadToolEnv } from './env.js';

await loadToolEnv();
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed a production environment.');
  process.exit(3);
}
const cfg = loadConfig();
const s = buildServices(cfg);
try {
  const exists = await s.database.systemTx((tx) => row(tx, sql`SELECT 1 FROM companies WHERE code = 'DEMO'`));
  if (exists) {
    console.log('Seed already applied (company DEMO exists). Use `pnpm db:reset:dev` to start over.');
    process.exit(0);
  }
  const t = await provisionTenant(s.database, s.auth, {
    code: 'DEMO',
    name: 'AutoLemon Demonstração, Lda.',
    adminEmail: 'admin@demo.autolemon.test',
    adminName: 'Administrador Demo',
    warehouses: [
      { code: 'PORTO', name: 'Armazém Porto' },
      { code: 'LISBOA', name: 'Armazém Lisboa' },
    ],
  });
  // Synthetic system actor used only to build seed structures through the normal services
  // (so every invariant, trigger and RLS policy applies). It is never a login.
  const seedActor = (warehouseId: string | null): Actor => ({
    userId: t.adminId,
    companyId: t.companyId,
    role: 'ADMIN',
    displayName: 'seed',
    warehouseId,
    permissions: new Set<Permission>(PERMISSIONS),
    sessionId: '00000000-0000-0000-0000-000000000000',
    stepUpAt: new Date(),
    requestId: 'seed',
    clientIp: '127.0.0.1',
  });
  const a = seedActor(null);
  let k = 0;
  const key = () => `seed-${Date.now()}-${k++}`;
  for (const [code, whId] of Object.entries(t.warehouses)) {
    const node = async (kind: string, c: string, name: string, parentId?: string) =>
      (await s.topology.createNode(a, whId, key(), { kind: kind as never, code: c, name, ...(parentId ? { parentId } : {}) })).id;
    const zone = await node('ZONE', `${code}-A`, 'Zona A — Armazenagem');
    const aisle = await node('AISLE', `${code}-A01`, 'Corredor 01', zone);
    const rack = await node('RACK', `${code}-A01-R1`, 'Estante 1', aisle);
    const shelf1 = await node('SHELF', `${code}-A01-R1-P1`, 'Prateleira 1', rack);
    await node('SHELF', `${code}-A01-R1-P2`, 'Prateleira 2', rack);
    await node('BIN', `${code}-A01-R1-P1-C01`, 'Compartimento 01', shelf1);
    await node('BIN', `${code}-A01-R1-P1-C02`, 'Compartimento 02', shelf1);
    await node('LOCATION', `${code}-A-CHAO01`, 'Chão 01 (paletes)', zone);
    await node('STAGING', `${code}-REC`, 'Cais de receção');
    await node('INSPECTION', `${code}-INSP`, 'Inspeção');
    await node('QUARANTINE', `${code}-QUAR`, 'Quarentena');
    const disp = await node('DISPATCH', `${code}-EXP`, 'Expedição / embalagem');
    void disp;
    await s.topology.createContainer(a, whId, key(), { code: `${code}-CX-0001`, kind: 'BOX', nodeId: shelf1 });
  }
  const skus = [
    { code: 'BRK-001', description: 'Pastilhas de travão dianteiras (exemplo)', brand: 'MarcaExemplo', barcode: '5600000000017' },
    { code: 'OIL-5W30-5L', description: 'Óleo motor 5W30 5 L (exemplo)', brand: 'MarcaExemplo', barcode: '5600000000024' },
    { code: 'FLT-AIR-01', description: 'Filtro de ar (exemplo)', brand: 'MarcaExemplo', barcode: '5600000000031' },
  ];
  const skuIds: Record<string, string> = {};
  for (const sk of skus) {
    skuIds[sk.code] = (
      await s.skus.create(a, {
        code: sk.code,
        description: sk.description,
        baseUom: 'UN',
        brand: sk.brand,
        tracking: 'NONE',
        barcodes: [{ barcode: sk.barcode, uom: 'UN', qtyPerUom: '1' }],
      })
    ).id;
  }
  // Synthetic opening stock in Porto (several positions of the same SKU) and one allocated
  // outbound request with an encrypted (synthetic) recipient contact.
  const portoWh = t.warehouses.PORTO!;
  const pNodes = await s.topology.listNodes(a, portoWh);
  const byCode = (c: string) => (pNodes as Array<{ id: string; code: string }>).find((n) => n.code === c)!.id;
  await s.stock.opening(a, portoWh, key(), {
    lines: [
      { skuId: skuIds['BRK-001']!, to: { nodeId: byCode('PORTO-A01-R1-P1') }, qty: '10' },
      { skuId: skuIds['BRK-001']!, to: { nodeId: byCode('PORTO-A01-R1-P1-C01') }, qty: '6' },
      { skuId: skuIds['OIL-5W30-5L']!, to: { nodeId: byCode('PORTO-A-CHAO01') }, qty: '24' },
      { skuId: skuIds['FLT-AIR-01']!, to: { nodeId: byCode('PORTO-A01-R1-P1-C02') }, qty: '15' },
    ],
    note: 'Stock inicial de demonstração (sintético)',
  });
  const demoOut = await s.outbound.create(a, portoWh, key(), {
    externalRef: 'DEMO-BALCAO-1',
    recipientContact: 'Oficina Fictícia Lda., Rua do Exemplo 1, 4000-000 Porto',
    lines: [{ skuId: skuIds['BRK-001']!, qty: '4' }],
  });
  await s.outbound.allocate(a, portoWh, demoOut.id, key());
  const porto = await s.admin.createUser(a, {
    email: 'operador.porto@demo.autolemon.test',
    displayName: 'Operador Porto',
    role: 'STAFF',
    warehouseId: t.warehouses.PORTO,
    permissions: [...DEFAULT_STAFF_PERMISSIONS],
  });
  const lisboa = await s.admin.createUser(a, {
    email: 'operador.lisboa@demo.autolemon.test',
    displayName: 'Operador Lisboa',
    role: 'STAFF',
    warehouseId: t.warehouses.LISBOA,
    permissions: [...DEFAULT_STAFF_PERMISSIONS],
  });
  const link = (tok: string) => `${cfg.WEB_ORIGIN}/#/convite/${tok}`;
  console.log('\nSeed complete (synthetic data). DEVELOPMENT-ONLY one-time invitation links (valid 72 h):');
  console.log(`  Admin  admin@demo.autolemon.test           ${link(t.invitationToken)}`);
  console.log(`  Staff  operador.porto@demo.autolemon.test  ${link(porto.invitationToken)}`);
  console.log(`  Staff  operador.lisboa@demo.autolemon.test ${link(lisboa.invitationToken)}`);
  console.log('Open a link, choose a password (min. 12 chars) and scan the TOTP QR/secret with an authenticator app.\n');
} finally {
  await s.database.close();
}
