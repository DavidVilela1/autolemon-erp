/**
 * @file Gate F-12 evidence: activity (ledger) CSV export and cross-document search.
 * Real HTTP API + PostgreSQL. Covers authorization (permission, step-up, warehouse scope),
 * bounded periods, CSV formula-injection encoding, literal LIKE matching, transfer visibility
 * from both sides, and isolation from other warehouses' documents.
 * @module tests/integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { node, ok, staff, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let A: Tenant;
let w1: string;
let w2: string;
let sku: string;
const N: Record<string, string> = {};
const since = new Date(Date.now() - 3600_000).toISOString();

beforeAll(async () => {
  t = await startApp();
  A = await tenant(t, 'RPT', ['W1', 'W2']);
  w1 = A.wh.W1!;
  w2 = A.wh.W2!;
  const z = await node(A.admin, w1, 'ZONE', 'RP-Z');
  N.l1 = await node(A.admin, w1, 'LOCATION', 'RP-L1', z);
  N.l2 = await node(A.admin, w1, 'LOCATION', 'RP-L2', z);
  sku = ok(
    await A.admin.post('/api/wms/skus', {
      code: 'RPT-50_PCT',
      description: 'Pastilhas de travão',
      barcodes: [{ barcode: '5601234567890', uom: 'UN', qtyPerUom: 1 }],
    }),
  ).id;
  ok(await A.admin.post(`/api/wms/w/${w1}/stock/opening`, { lines: [{ skuId: sku, to: { nodeId: N.l1 }, qty: 10 }] }));
  const pos = (ok(await A.admin.get(`/api/wms/w/${w1}/stock?skuId=${sku}`)) as Array<{ id: string }>)[0]!;
  // A reason crafted as a spreadsheet formula: must be neutralised in the export.
  ok(
    await A.admin.post(`/api/wms/w/${w1}/stock/move`, {
      positionId: pos.id,
      qty: 2,
      to: { nodeId: N.l2 },
      reason: '=HYPERLINK("http://evil")',
    }),
  );
  ok(
    await A.admin.post(`/api/wms/w/${w1}/inbound`, {
      kind: 'EXPECTED',
      externalRef: 'GUIA-2026/777',
      lines: [{ skuId: sku, qtyExpected: 1 }],
    }),
  );
  ok(await A.admin.post('/api/wms/transfers', { sourceWarehouseId: w2, destWarehouseId: w1, lines: [{ skuId: sku, qty: 1 }] }));
  ok(await A.admin.post(`/api/wms/w/${w2}/outbound`, { externalRef: 'ONLY-IN-W2', lines: [{ skuId: sku, qty: 1 }] }));
});
afterAll(async () => {
  await t?.close();
});

describe('Activity (ledger) CSV export', () => {
  it('requires wms.export and a recent step-up; refuses unbounded or oversized periods', async () => {
    const viewer = await staff(t, A, w1, ['wms.view', 'wms.report']);
    expect((await viewer.get(`/api/wms/w/${w1}/reports/ledger.csv?from=${since}`)).status).toBe(403);
    await t.owner.query('UPDATE sessions SET step_up_at = NULL WHERE user_id = $1', [A.admin.userId]);
    const noStep = await A.admin.get(`/api/wms/w/${w1}/reports/ledger.csv?from=${since}`);
    expect(noStep.body.error.code).toBe('STEP_UP_REQUIRED');
    await A.admin.stepUp();
    expect((await A.admin.get(`/api/wms/w/${w1}/reports/ledger.csv`)).status).toBe(400); // `from` is mandatory
    const tooLong = `from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z`;
    expect((await A.admin.get(`/api/wms/w/${w1}/reports/ledger.csv?${tooLong}`)).status).toBe(400);
  });

  it('exports the period completely, with document numbers, neutralised formulas and an audit entry', async () => {
    await A.admin.stepUp();
    const r = await A.admin.get(`/api/wms/w/${w1}/reports/ledger.csv?from=${encodeURIComponent(since)}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/movimentos\.csv/);
    const lines = r.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      [
        'data_hora',
        'tipo',
        'transacao',
        'documento',
        'artigo',
        'localizacao',
        'caixa',
        'estado',
        'lote',
        'quantidade',
        'utilizador',
        'nota',
      ]
        .map((h) => `"${h}"`)
        .join(';'),
    );
    expect(lines.filter((l) => l.includes(';"OPENING";'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes(';"MOVE";'))).toHaveLength(2); // source −2 and target +2
    expect(r.text).not.toMatch(/;"=HYPERLINK/); // formula cells are prefixed, never raw
    expect(r.text).toContain('"\'=HYPERLINK');
    expect(r.text).toContain(';"-2.000";'); // plain negative numbers stay numeric
    const typed = await A.admin.get(`/api/wms/w/${w1}/reports/ledger.csv?from=${encodeURIComponent(since)}&type=OPENING`);
    expect(typed.text.trim().split('\r\n')).toHaveLength(2);
    const audit = (
      await t.owner.query(`SELECT details FROM security_audit_log WHERE action = 'wms.export.ledger_csv' ORDER BY id DESC LIMIT 1`)
    ).rows[0];
    expect(audit.details).toMatchObject({ rows: 1, type: 'OPENING' }); // the latest (filtered) export
  });
});

describe('Cross-document search', () => {
  const search = (q: string, wh = w1) => A.admin.get(`/api/wms/w/${wh}/search?q=${encodeURIComponent(q)}`);
  const kinds = (body: { hits: Array<{ kind: string }> }) => body.hits.map((h) => h.kind).sort();

  it('finds documents by external reference, SKUs by barcode and description, locations by path', async () => {
    expect(kinds(ok(await search('GUIA-2026/777')))).toEqual(['inbound']);
    expect(kinds(ok(await search('5601234567890')))).toEqual(['sku']);
    expect(ok(await search('travão')).hits[0].label).toBe('RPT-50_PCT');
    expect(kinds(ok(await search('RP-L')))).toEqual(['location', 'location']);
  });

  it('finds a transfer from the destination side and hides other warehouses’ documents', async () => {
    const tr = ok(await search('TRF'));
    expect(tr.hits.some((h: { kind: string }) => h.kind === 'transfer')).toBe(true);
    expect(ok(await search('ONLY-IN-W2')).hits).toEqual([]);
    expect(kinds(ok(await search('ONLY-IN-W2', w2)))).toEqual(['outbound']);
    const scoped = await staff(t, A, w1, ['wms.view']);
    expect((await scoped.get(`/api/wms/w/${w2}/search?q=ONLY`)).status).toBe(404);
  });

  it('matches wildcard characters literally and rejects malformed queries without errors', async () => {
    expect(ok(await search('%%')).hits).toEqual([]); // not "match everything"
    expect(ok(await search('50_PCT')).hits.map((h: { label: string }) => h.label)).toEqual(['RPT-50_PCT']);
    expect(ok(await search('5_PCT')).hits).toEqual([]); // "_" is not a single-character wildcard
    expect(ok(await search("' OR 1=1 --")).hits).toEqual([]);
    expect((await search('x')).status).toBe(400);
    expect((await search('a'.repeat(65))).status).toBe(400);
    expect((await A.admin.get(`/api/wms/w/${w1}/search?q=ab%01cd`)).status).toBe(400);
  });
});
