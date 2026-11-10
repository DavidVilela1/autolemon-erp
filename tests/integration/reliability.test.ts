/**
 * @file Reliability evidence for the WMS release gate (engineering integrity):
 *  - scan verification of destinations (putaway, stock move, container move);
 *  - failure injection: a database error in the MIDDLE of a stock command rolls back every
 *    partial write (balances, ledger, transaction header, idempotency record) and the same
 *    Idempotency-Key can be retried successfully afterwards;
 *  - migration upgrade rehearsal: a database created by the v0.5.0 migrations (0001–0003) with
 *    an in-transit transfer is upgraded to the current schema; data is preserved and back-filled.
 * Real PostgreSQL, no mocks.
 * @module tests/integration
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listMigrations, MIGRATIONS_DIR, migrate } from '../../apps/api/src/db/migrator.js';
import { node, ok, staff, startApp, tenant, type Tenant, type TestApp } from '../helpers/harness.js';

let t: TestApp;
let A: Tenant;
let wh: string;
let sku: string;
const N: Record<string, string> = {};
const wms = (path: string) => `/api/wms/w/${wh}${path}`;

beforeAll(async () => {
  t = await startApp();
  A = await tenant(t, 'REL', ['W1']);
  wh = A.wh.W1!;
  const z = await node(A.admin, wh, 'ZONE', 'R-Z');
  N.s1 = await node(A.admin, wh, 'LOCATION', 'R-L1', z);
  N.s2 = await node(A.admin, wh, 'LOCATION', 'R-L2', z);
  N.stage = await node(A.admin, wh, 'STAGING', 'R-REC');
  sku = ok(await A.admin.post('/api/wms/skus', { code: 'REL-1', description: 'Artigo de fiabilidade' })).id;
  ok(await A.admin.post(wms('/stock/opening'), { lines: [{ skuId: sku, to: { nodeId: N.s1 }, qty: 10 }] }));
});
afterAll(async () => {
  await t?.close();
});

const positionAt = async (nodeId: string) =>
  (ok(await A.admin.get(wms(`/stock?skuId=${sku}`))) as Array<Record<string, string>>).find((p) => p.nodeId === nodeId) ?? null;

describe('Scan verification of destinations', () => {
  it('refuses a putaway whose scanned label is not the chosen destination', async () => {
    const r = ok(await A.admin.post(wms('/inbound'), { kind: 'EXPECTED', lines: [{ skuId: sku, qtyExpected: 2 }] }));
    ok(await A.admin.post(wms(`/inbound/${r.id}/release`)));
    ok(await A.admin.post(wms(`/inbound/${r.id}/receive`), { stagingNodeId: N.stage, lines: [{ skuId: sku, qty: 2 }] }));
    const task = (ok(await A.admin.get(wms('/putaway'))) as Array<{ id: string }>)[0]!;
    const bad = await A.admin.post(wms(`/putaway/${task.id}/complete`), { qty: 2, to: { nodeId: N.s2 }, scan: 'R-L1' });
    expect(bad.body.error.code).toBe('SCAN_MISMATCH');
    ok(await A.admin.post(wms(`/putaway/${task.id}/complete`), { qty: 2, to: { nodeId: N.s2 }, scan: 'r-l2' })); // case-insensitive
  });

  it('refuses stock and container moves with the wrong label', async () => {
    const p = (await positionAt(N.s1!))!;
    expect(
      (await A.admin.post(wms('/stock/move'), { positionId: p.id, qty: 1, to: { nodeId: N.s2 }, scan: 'R-REC' })).body.error.code,
    ).toBe('SCAN_MISMATCH');
    const box = ok(await A.admin.post(wms('/containers'), { code: 'REL-BOX', kind: 'BOX', nodeId: N.s1 })).id;
    ok(await A.admin.post(wms('/stock/move'), { positionId: p.id, qty: 1, to: { containerId: box }, scan: 'REL-BOX' }));
    expect((await A.admin.post(wms(`/containers/${box}/move`), { toNodeId: N.s2, scan: 'R-L1' })).body.error.code).toBe('SCAN_MISMATCH');
    ok(await A.admin.post(wms(`/containers/${box}/move`), { toNodeId: N.s2, scan: 'R-L2' }));
  });
});

describe('Failure injection and rollback', () => {
  it('a failure after the source was decremented rolls back everything; the same key then succeeds', async () => {
    const src = (await positionAt(N.s1!))!;
    const before = {
      src: src.onHand,
      dst: (await positionAt(N.s2!))?.onHand ?? '0',
      txns: (await t.owner.query('SELECT count(*)::int AS n FROM inventory_transactions WHERE warehouse_id = $1', [wh])).rows[0].n,
      ledger: (await t.owner.query('SELECT count(*)::int AS n FROM inventory_ledger WHERE warehouse_id = $1', [wh])).rows[0].n,
    };
    // Inject: the ledger insert for the DESTINATION fails (the source line was already written).
    await t.owner.query(`CREATE FUNCTION test_inject_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.holder_node_id = '${N.s2}'::uuid AND NEW.sku_id = '${sku}'::uuid THEN
          RAISE EXCEPTION 'injected failure';
        END IF;
        RETURN NEW;
      END $$`);
    await t.owner.query(
      'CREATE TRIGGER test_inject_failure BEFORE INSERT ON inventory_ledger FOR EACH ROW EXECUTE FUNCTION test_inject_failure()',
    );
    // Idempotency-Key header value (not a credential); named so secret scanners do not misread it.
    const retryId = 'retry-after-injected-failure';
    try {
      const r = await A.admin.post(
        wms('/stock/move'),
        { positionId: src.id, qty: 3, to: { nodeId: N.s2 } },
        { 'idempotency-key': retryId },
      );
      expect(r.status).toBe(500);
      expect(r.text).not.toMatch(/injected|trigger|stack|at \w+ \(/i); // no internals leaked
    } finally {
      await t.owner.query('DROP TRIGGER test_inject_failure ON inventory_ledger');
      await t.owner.query('DROP FUNCTION test_inject_failure()');
    }
    expect((await positionAt(N.s1!))!.onHand).toBe(before.src);
    expect((await positionAt(N.s2!))?.onHand ?? '0').toBe(before.dst);
    expect((await t.owner.query('SELECT count(*)::int AS n FROM inventory_transactions WHERE warehouse_id = $1', [wh])).rows[0].n).toBe(
      before.txns,
    );
    expect((await t.owner.query('SELECT count(*)::int AS n FROM inventory_ledger WHERE warehouse_id = $1', [wh])).rows[0].n).toBe(
      before.ledger,
    );
    expect((await t.owner.query('SELECT count(*)::int AS n FROM command_log WHERE idempotency_key = $1', [retryId])).rows[0].n).toBe(0);
    // Retry with the same key now executes (the failed attempt left no idempotency record).
    const retry = ok(
      await A.admin.post(wms('/stock/move'), { positionId: src.id, qty: 3, to: { nodeId: N.s2 } }, { 'idempotency-key': retryId }),
    );
    expect(retry.txnId).toBeTruthy();
    // And a second identical submission is a replay, not a second posting.
    const replay = await A.admin.post(
      wms('/stock/move'),
      { positionId: src.id, qty: 3, to: { nodeId: N.s2 } },
      { 'idempotency-key': retryId },
    );
    expect(replay.body.txnId).toBe(retry.txnId);
    expect(Number((await positionAt(N.s1!))!.onHand)).toBe(Number(before.src) - 3);
    const rec = ok(await A.admin.get(wms('/stock/reconciliation')));
    expect(rec.ledgerMismatches).toEqual([]);
  });
});

describe('Migration upgrade rehearsal (v0.5.0 schema → current)', () => {
  const ownerUrl = process.env.TEST_OWNER_URL!;
  const dbName = `${new URL(ownerUrl).pathname.slice(1)}_upg`;
  const upgUrl = (() => {
    const u = new URL(ownerUrl);
    u.pathname = `/${dbName}`;
    return u.toString();
  })();
  let dir = '';

  afterAll(async () => {
    await t.owner.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('upgrades a populated v0.5.0 database and back-fills lots in transit', async () => {
    expect(dbName).toMatch(/^[a-z0-9_]+$/);
    await t.owner.query(`CREATE DATABASE ${dbName}`);
    dir = mkdtempSync(join(tmpdir(), 'al-mig-'));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => /^000[1-3]_.*\.sql$/.test(n))) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
    expect(await migrate(upgUrl, { dir })).toEqual(['0001_platform.sql', '0002_wms.sql', '0003_rls_and_grants.sql']);

    // v0.5-shaped data: an in-transit transfer (5 shipped, 2 received).
    const db = new pg.Client({ connectionString: upgUrl });
    await db.connect();
    try {
      const c = (await db.query(`INSERT INTO companies (code, name) VALUES ('UPG', 'Upgrade Lda') RETURNING id`)).rows[0].id;
      const w1 = (await db.query(`INSERT INTO warehouses (company_id, code, name) VALUES ($1, 'A', 'A') RETURNING id`, [c])).rows[0].id;
      const w2 = (await db.query(`INSERT INTO warehouses (company_id, code, name) VALUES ($1, 'B', 'B') RETURNING id`, [c])).rows[0].id;
      const s = (await db.query(`INSERT INTO skus (company_id, code, description) VALUES ($1, 'UPG-1', 'x') RETURNING id`, [c])).rows[0].id;
      const tr = (
        await db.query(
          `INSERT INTO transfers (company_id, number, source_warehouse_id, dest_warehouse_id, status, created_by)
           VALUES ($1, 'A-TRF-1', $2, $3, 'PARTIALLY_RECEIVED', gen_random_uuid()) RETURNING id`,
          [c, w1, w2],
        )
      ).rows[0].id;
      await db.query(
        `INSERT INTO transfer_lines (company_id, transfer_id, line_no, sku_id, qty_requested, qty_shipped, qty_received)
         VALUES ($1, $2, 1, $3, 5, 5, 2)`,
        [c, tr, s],
      );

      const applied = await migrate(upgUrl); // the real, current migration set
      expect(applied).toEqual(
        listMigrations()
          .map((m) => m.name)
          .filter((n) => !/^000[1-3]_/.test(n)),
      );

      const lots = (await db.query(`SELECT lot_code, qty_shipped::text, qty_received::text, qty_lost::text FROM transfer_line_lots`)).rows;
      expect(lots).toEqual([{ lot_code: '', qty_shipped: '5.000', qty_received: '2.000', qty_lost: '0.000' }]);
      // Re-running is a no-op; checksums of applied files are enforced.
      expect(await migrate(upgUrl)).toEqual([]);
    } finally {
      await db.end();
    }
  });
});

describe('Full count with recount and segregated approval', () => {
  it('counts every position, recounts a line, and a different approver posts exactly the difference', async () => {
    const counter = await staff(t, A, wh, ['wms.view', 'wms.count']);
    const cnt = ok(await counter.post(wms('/counts'), { kind: 'FULL' }));
    const view = ok(await counter.get(wms(`/counts/${cnt.id}`)));
    const truth = (ok(await A.admin.get(wms('/stock'))) as Array<Record<string, string>>).filter((p) => Number(p.onHand) > 0);
    expect(view.lines.length).toBe(truth.length); // FULL = every non-empty position of the warehouse
    const lines = view.lines as Array<{ id: string; nodePath: string; containerCode: string | null; status: string }>;
    const qtyFor = (l: (typeof lines)[number]) =>
      truth.find((p) => p.nodePath === l.nodePath && (p.containerCode ?? null) === (l.containerCode ?? null) && p.status === l.status)!
        .onHand!;
    // First line miscounted (+5), then recounted correctly; the second is genuinely short by 1.
    ok(await counter.post(wms(`/counts/${cnt.id}/lines/${lines[0]!.id}/count`), { qtyCounted: String(Number(qtyFor(lines[0]!)) + 5) }));
    for (const l of lines.slice(1)) {
      const q = l === lines[1] ? String(Number(qtyFor(l)) - 1) : qtyFor(l);
      ok(await counter.post(wms(`/counts/${cnt.id}/lines/${l.id}/count`), { qtyCounted: q }));
    }
    ok(await counter.post(wms(`/counts/${cnt.id}/lines/${lines[0]!.id}/recount`)));
    ok(await counter.post(wms(`/counts/${cnt.id}/lines/${lines[0]!.id}/count`), { qtyCounted: qtyFor(lines[0]!) }));
    const sub = ok(await counter.post(wms(`/counts/${cnt.id}/submit`)));
    expect(sub.discrepancies).toBe(lines.length > 1 ? 1 : 0);
    await A.admin.stepUp();
    const appr = ok(await A.admin.post(wms(`/counts/${cnt.id}/approve`)));
    expect(appr.adjustedLines).toBe(lines.length > 1 ? 1 : 0);
    const rec = ok(await A.admin.get(wms('/stock/reconciliation')));
    expect(rec.ledgerMismatches).toEqual([]);
    expect(rec.reservationMismatches).toEqual([]);
  });
});
