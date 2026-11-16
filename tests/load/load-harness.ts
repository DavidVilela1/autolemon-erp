/**
 * @file Reproducible WMS load/performance harness (gate E-04; ADR-0030).
 * @module tests/load
 *
 * Usage (disposable database, never the developer's data):
 *   pnpm test:load                         smoke profile, enforces the targets
 *   pnpm test:load -- --profile representative
 *   pnpm test:load -- --profile stress          (report only: degradation at 60 users)
 *   pnpm test:load -- --profile smoke --no-enforce
 *
 * What it does:
 *  1. Starts the API in-process (same composition as production, test configuration) on a fresh
 *     database created by scripts/with-test-db.mjs.
 *  2. Seeds a load tenant: SKUs (bulk SQL — catalogue rows have no stock invariants), a storage
 *     tree with N bins (service calls), and opening stock through the REAL stock command in
 *     batches of 500 lines, so every position has its transaction, ledger rows and audit trail.
 *  3. Logs in one STAFF user per virtual user (password + TOTP) and runs a weighted mix of
 *     operator requests through the full HTTP stack (routing, guard, CSRF, validation, RLS,
 *     serialisation) via Fastify inject — no network hop, so latencies are server-side.
 *     Each virtual user moves stock only between its own positions/bins (operators work on
 *     different bins), reads are random over the whole catalogue.
 *  4. After the run: total on-hand must be unchanged (moves conserve stock) and the ledger and
 *     reservation reconciliation must report zero mismatches.
 *  5. Writes artifacts/perf/<profile>-<timestamp>.json and docs/perf/LAST_RUN_<profile>.md and,
 *     unless --no-enforce, exits 1 when a p95 target, the error rate or the throughput is missed.
 *
 * Load generator and server share the machine: results are a lower bound for a dedicated
 * server, and they are NOT a substitute for a test against the target environment (O-01).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { type Client, ok, staff, startApp, tenant } from '../helpers/harness.js';

type Scenario = 'stock_by_sku' | 'sku_search' | 'global_search' | 'ledger_page' | 'stock_move';
interface Profile {
  description: string;
  warehouses: number;
  skus: number;
  bins: number;
  positionsPerSku: number;
  virtualUsers: number;
  warmupSeconds: number;
  durationSeconds: number;
  /** false = report only (stress profiles); targets are enforced by default. */
  enforce?: boolean;
}
interface Targets {
  status: string;
  profiles: Record<string, Profile>;
  mix: Record<Scenario, number>;
  targets: { p95Ms: Record<Scenario, number>; maxErrorRate: number; minThroughputRps: number };
}

const ROOT = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const profileName = args.includes('--profile') ? (args[args.indexOf('--profile') + 1] ?? 'smoke') : 'smoke';
const noEnforceFlag = args.includes('--no-enforce');
const cfg = JSON.parse(readFileSync(resolve(ROOT, 'docs/perf/targets.json'), 'utf8')) as Targets;
const maybeProfile = cfg.profiles[profileName];
if (!maybeProfile) {
  console.error(`Unknown profile ${profileName}; known: ${Object.keys(cfg.profiles).join(', ')}`);
  process.exit(2);
}
const profile: Profile = maybeProfile;
const enforce = !noEnforceFlag && profile.enforce !== false;
if (profile.positionsPerSku > profile.bins) throw new Error('positionsPerSku must not exceed bins');
if (profile.bins < profile.virtualUsers * 2) throw new Error('each virtual user needs at least two bins of its own');

/** Nearest-rank percentile of a sorted array. */
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
const log = (m: string) => console.log(`[load] ${m}`);

const t = await startApp();
const startedAt = new Date();
let exitCode = 0;
try {
  // ------------------------------------------------------------------ seed
  const seedT0 = performance.now();
  const T = await tenant(t, 'LOAD', ['W1']);
  const wh = T.wh.W1!;
  await t.owner.query(
    `INSERT INTO skus (company_id, code, description, brand)
     SELECT $1, 'P' || lpad(g::text, 6, '0'), 'Peça de teste ' || g || ' — filtro/travão/correia', 'MARCA' || (g % 40)
       FROM generate_series(1, $2::int) g`,
    [T.companyId, profile.skus],
  );
  const skuIds = (await t.owner.query<{ id: string }>('SELECT id FROM skus WHERE company_id = $1 ORDER BY code', [T.companyId])).rows.map(
    (r) => r.id,
  );

  const node = async (body: Record<string, unknown>) => ok(await T.admin.post(`/api/wms/w/${wh}/nodes`, body)).id as string;
  const zone = await node({ kind: 'ZONE', code: 'LZ', name: 'Zona de carga' });
  const aisle = await node({ kind: 'AISLE', code: 'LZ-A1', name: 'Corredor 1', parentId: zone });
  const rack = await node({ kind: 'RACK', code: 'LZ-A1-R1', name: 'Estante 1', parentId: aisle });
  const shelf = await node({ kind: 'SHELF', code: 'LZ-A1-R1-P1', name: 'Prateleira 1', parentId: rack });
  const bins: string[] = [];
  for (let b = 0; b < profile.bins; b++) {
    bins.push(await node({ kind: 'BIN', code: `LZ-B${String(b).padStart(5, '0')}`, name: `Compartimento ${b}`, parentId: shelf }));
  }
  // Opening stock: SKU i in bins (i + j·stride) mod bins — unique (sku, bin), spread evenly.
  const stride = Math.max(1, Math.floor(profile.bins / profile.positionsPerSku));
  const lines: Array<{ skuId: string; to: { nodeId: string }; qty: string }> = [];
  skuIds.forEach((skuId, i) => {
    for (let j = 0; j < profile.positionsPerSku; j++)
      lines.push({ skuId, to: { nodeId: bins[(i + j * stride) % profile.bins]! }, qty: '1000' });
  });
  for (let k = 0; k < lines.length; k += 500) {
    ok(await T.admin.post(`/api/wms/w/${wh}/stock/opening`, { lines: lines.slice(k, k + 500), note: 'load harness' }));
    if ((k / 500) % 20 === 19) log(`opening stock ${k + 500}/${lines.length}`);
  }
  const positions = (
    await t.owner.query<{ id: string; holder_node_id: string }>(
      `SELECT id, holder_node_id FROM stock_positions WHERE warehouse_id = $1 AND qty_on_hand > 0 ORDER BY id`,
      [wh],
    )
  ).rows;
  const totalBefore = (
    await t.owner.query<{ s: string }>('SELECT sum(qty_on_hand)::text AS s FROM stock_positions WHERE warehouse_id = $1', [wh])
  ).rows[0]!.s;
  const seedSeconds = (performance.now() - seedT0) / 1000;
  log(`seeded ${skuIds.length} SKUs, ${bins.length} bins, ${positions.length} positions in ${seedSeconds.toFixed(1)} s`);

  // ------------------------------------------------------------------ users
  const perms = ['wms.view', 'wms.putaway', 'wms.report'];
  const vus: Array<{ c: Client; positions: typeof positions; bins: string[] }> = [];
  for (let v = 0; v < profile.virtualUsers; v++) {
    vus.push({
      c: await staff(t, T, wh, perms),
      positions: positions.filter((_, i) => i % profile.virtualUsers === v),
      bins: bins.filter((_, i) => i % profile.virtualUsers === v),
    });
  }

  // ------------------------------------------------------------------ run
  const scenarios = Object.keys(cfg.mix) as Scenario[];
  const totalWeight = scenarios.reduce((s, k) => s + cfg.mix[k], 0);
  const pick = (): Scenario => {
    let r = Math.random() * totalWeight;
    for (const s of scenarios) if ((r -= cfg.mix[s]) < 0) return s;
    return scenarios[0]!;
  };
  const rnd = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;
  const lat: Record<Scenario, number[]> = { stock_by_sku: [], sku_search: [], global_search: [], ledger_page: [], stock_move: [] };
  const errors: Record<string, number> = {};
  let measuring = false;
  let stop = false;

  async function call(vu: (typeof vus)[number], s: Scenario): Promise<number> {
    switch (s) {
      case 'stock_by_sku':
        return (await vu.c.get(`/api/wms/w/${wh}/stock?skuId=${rnd(skuIds)}`)).status;
      case 'sku_search':
        return (await vu.c.get(`/api/wms/skus?q=P0${Math.floor(Math.random() * 100)}&limit=50`)).status;
      case 'global_search':
        return (
          await vu.c.get(
            `/api/wms/w/${wh}/search?q=${encodeURIComponent(
              `P${String(Math.floor(Math.random() * profile.skus))
                .padStart(6, '0')
                .slice(0, 4)}`,
            )}`,
          )
        ).status;
      case 'ledger_page':
        return (await vu.c.get(`/api/wms/w/${wh}/reports/ledger?limit=50`)).status;
      case 'stock_move': {
        const p = rnd(vu.positions);
        const to = rnd(vu.bins.filter((b) => b !== p.holder_node_id));
        return (await vu.c.post(`/api/wms/w/${wh}/stock/move`, { positionId: p.id, qty: '1', to: { nodeId: to }, reason: 'load' })).status;
      }
    }
  }

  async function worker(vu: (typeof vus)[number]) {
    while (!stop) {
      const s = pick();
      const t0 = performance.now();
      let status: number;
      try {
        status = await call(vu, s);
      } catch {
        status = 0;
      }
      const ms = performance.now() - t0;
      if (!measuring) continue;
      lat[s].push(ms);
      if (status < 200 || status >= 300) errors[`${s}:${status}`] = (errors[`${s}:${status}`] ?? 0) + 1;
    }
  }

  log(
    `running ${profileName}: ${profile.virtualUsers} virtual users, warm-up ${profile.warmupSeconds} s, measure ${profile.durationSeconds} s`,
  );
  const running = vus.map((vu) => worker(vu));
  await new Promise((r) => setTimeout(r, profile.warmupSeconds * 1000));
  measuring = true;
  const m0 = performance.now();
  await new Promise((r) => setTimeout(r, profile.durationSeconds * 1000));
  measuring = false;
  const measuredSeconds = (performance.now() - m0) / 1000;
  stop = true;
  await Promise.all(running);

  // ------------------------------------------------------------------ invariants
  const totalAfter = (
    await t.owner.query<{ s: string }>('SELECT sum(qty_on_hand)::text AS s FROM stock_positions WHERE warehouse_id = $1', [wh])
  ).rows[0]!.s;
  const recon = ok(await T.admin.get(`/api/wms/w/${wh}/stock/reconciliation`));
  const conservation = totalBefore === totalAfter;
  const reconciled = recon.ledgerMismatches.length === 0 && recon.reservationMismatches.length === 0;

  // ------------------------------------------------------------------ report
  const results = scenarios.map((s) => {
    const a = lat[s].slice().sort((x, y) => x - y);
    const errs = Object.entries(errors)
      .filter(([k]) => k.startsWith(`${s}:`))
      .reduce((n, [, v]) => n + v, 0);
    return {
      scenario: s,
      requests: a.length,
      errors: errs,
      p50Ms: +pct(a, 50).toFixed(1),
      p95Ms: +pct(a, 95).toFixed(1),
      p99Ms: +pct(a, 99).toFixed(1),
      maxMs: +(a.at(-1) ?? 0).toFixed(1),
      targetP95Ms: cfg.targets.p95Ms[s],
      ok: pct(a, 95) <= cfg.targets.p95Ms[s],
    };
  });
  const totalRequests = results.reduce((n, r) => n + r.requests, 0);
  const totalErrors = results.reduce((n, r) => n + r.errors, 0);
  const rps = totalRequests / measuredSeconds;
  const errorRate = totalRequests ? totalErrors / totalRequests : 1;
  const passed =
    results.every((r) => r.ok) &&
    errorRate <= cfg.targets.maxErrorRate &&
    rps >= cfg.targets.minThroughputRps &&
    conservation &&
    reconciled;
  const env = {
    node: process.version,
    cpus: `${cpus().length} × ${cpus()[0]?.model ?? '?'}`,
    memoryGb: +(totalmem() / 2 ** 30).toFixed(1),
    postgres: (await t.owner.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]!.v,
  };
  const report = {
    profile: profileName,
    targetsStatus: cfg.status,
    startedAt: startedAt.toISOString(),
    environment: env,
    dataset: { skus: skuIds.length, bins: bins.length, positions: positions.length, seedSeconds: +seedSeconds.toFixed(1) },
    virtualUsers: profile.virtualUsers,
    measuredSeconds: +measuredSeconds.toFixed(1),
    throughputRps: +rps.toFixed(1),
    errorRate: +errorRate.toFixed(5),
    errors,
    results,
    invariants: { stockConservation: conservation, totalBefore, totalAfter, reconciliationClean: reconciled },
    passed,
  };
  mkdirSync(resolve(ROOT, 'artifacts/perf'), { recursive: true });
  const stamp = startedAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  writeFileSync(resolve(ROOT, `artifacts/perf/${profileName}-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  const md = [
    `# Load test — last run of profile \`${profileName}\``,
    '',
    `<!-- GENERATED by tests/load/load-harness.ts — rerun \`pnpm test:load -- --profile ${profileName}\` to update. -->`,
    '',
    `Run ${report.startedAt} · targets **${cfg.status}** (docs/perf/targets.json) · ${passed ? '**PASSED**' : enforce ? '**FAILED**' : '**REPORT ONLY** — targets shown for comparison, not enforced'}.`,
    '',
    `Environment: Node ${env.node}, ${env.cpus}, ${env.memoryGb} GB RAM, PostgreSQL ${env.postgres}; load generator and API on the same machine, in-process (no network). Not the target environment.`,
    '',
    `Dataset: ${report.dataset.skus} SKUs, ${report.dataset.bins} bins, ${report.dataset.positions} stock positions (seeded in ${report.dataset.seedSeconds} s through the real opening-stock command). ${profile.virtualUsers} virtual users, ${report.measuredSeconds} s measured after ${profile.warmupSeconds} s warm-up.`,
    '',
    `Throughput **${report.throughputRps} req/s** (target ≥ ${cfg.targets.minThroughputRps}) · error rate **${report.errorRate}** (target ≤ ${cfg.targets.maxErrorRate}).`,
    '',
    '| Scenario | Requests | Errors | p50 ms | p95 ms | p99 ms | max ms | Target p95 | Result |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${r.scenario} | ${r.requests} | ${r.errors} | ${r.p50Ms} | ${r.p95Ms} | ${r.p99Ms} | ${r.maxMs} | ${r.targetP95Ms} | ${r.ok ? 'OK' : 'MISSED'} |`,
    ),
    '',
    `Invariants after the run: stock conservation **${conservation ? 'OK' : 'FAILED'}** (${totalBefore} → ${totalAfter}), ledger/reservation reconciliation **${reconciled ? 'clean' : 'MISMATCHES'}**.`,
    '',
  ].join('\n');
  writeFileSync(resolve(ROOT, `docs/perf/LAST_RUN_${profileName}.md`), md);
  console.log(md);
  if (!passed) {
    log(enforce ? 'FAILED (targets or invariants missed)' : 'targets missed (report only, not enforced)');
    if (enforce || !conservation || !reconciled) exitCode = 1;
  }
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  await t.close();
}
process.exit(exitCode);
