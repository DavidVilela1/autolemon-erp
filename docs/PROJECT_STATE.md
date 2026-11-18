# Project state — AutoLemon ERP v0.6.14-WMS

Owning module: repository. Last updated: 2026-11-16 (Europe/Lisbon). Archive:
`AutoLemon-ERP-v0.6.14-WMS.zip` (root `autolemon-erp/`); its SHA-256 is in the adjacent
`AutoLemon-ERP-v0.6.14-WMS.zip.sha256` (a file cannot contain its own hash).

## 1. Summary

Continuation of v0.5.0 (nothing restarted). Governing instructions: the product owner's
Development Priority Update (WMS first), **Reusable Continuation Prompt v0.6** and **WMS
Production Readiness Gate v0.6**. WMS release gate state: **`WMS_IN_PROGRESS`**
(`docs/WMS_RELEASE_GATE.md`: PASS 20 · FAIL 3 · BLOCKED 10 · NOT_RUN 1). **Not production-ready.**
No other ERP business module has been started.

v0.6.14 (2026-11-18, owner CI report): `security:scan` failed in CI on a newly published
advisory in development tooling (GHSA-fc5q-39xc-vjpf, picomatch ReDoS, high, no fix released).
Production dependencies are clean. The audit policy is now enforced per advisory from
`docs/security/audit-exceptions.json` (production HIGH/CRITICAL always block; dev-only need a
dated exception, at most 90 days); SEC-OPEN-020 accepted until 2026-12-31. No product change.

v0.6.13 (2026-11-17, continuation, T-11 remainder): reconciliation is now incremental — a
database trigger keeps a running ledger total per position (migration 0010), so the routine check
reads one row per position; `?full=true` still sums the whole ledger. New race tests found three
more deadlocks (pick vs unpick, replenishment vs move, opposite status changes; under sustained
contention they failed with HTTP 500) — fixed with `lockRelocation`; exhausted deadlock retries
now return 503 `BUSY_RETRY`. A new picking load scenario found the order view slow under load
(p95 550 ms) — fixed with order-first queries and migration 0011 (p95 36 ms). ADR-0032.

v0.6.12 (2026-11-17, owner report): after e2e on Windows the API server kept running (only its
`cmd.exe` wrapper was stopped) and logged errors against the dropped test database every 5 s.
e2e now stops the whole process tree (`killTree`, `taskkill /T` on Windows). The owner commits
only releases that pass `pnpm test:all` on the Windows workstation (`docs/HANDOVER.md`).

v0.6.11 (2026-11-17, owner report): on Windows `pnpm test:all` passed everything except e2e,
which did not start — the test scripts ran `C:\Program Files\nodejs\node.exe` through the shell
unquoted. All scripts now spawn through `shellSafe` (regression test runs cmd.exe on Windows).
Tooling only.

v0.6.10 (2026-11-16, owner report): the `ledger-growth` reconciliation returned HTTP 500 on the
owner's Windows workstation — it exceeded the API's 15 s statement limit. Reconciliation now
aggregates first, has its own 60 s budget with one run per warehouse (409 otherwise), and every
statement timeout returns 503 `QUERY_TIMEOUT`. New setting `DB_STATEMENT_TIMEOUT_MS`. No
migration.

v0.6.9 session (continuation): the load harness gained the contended write path (create +
allocate outbound orders on the hottest SKUs), which exposed **deadlocks** in allocation and
stock moves, hidden from users by the retry but costing ~1 s each. Fixed with ordered row
locking (ADR-0031) and a regression test that reads PostgreSQL's deadlock counter (verified to
fail without the fix). New `ledger-growth` profile (10 M ledger rows), which found the activity
(ledger) page joining the whole ledger before limiting (4.1 s at 300 000 rows → 2.5 ms after
the fix). No migration.

v0.6.8 session: reproducible load harness (`pnpm test:load`, ADR-0030) with
provisional targets and a measured baseline — representative profile (20 000 SKUs, 100 000
positions, 25 users) met all provisional targets; stress (60 users) degraded without errors.
E-04 stays BLOCKED until the owner agrees the targets. No migration.

v0.6.7 session: control-bypass signals in the audit trail (V16.3.3) and a
recorded identity check for account recovery (V6.4.4) — ADR-0029. S-06 moved to BLOCKED (no
known code-level ASVS L2 gap; DAST/ENV items need an environment). No migration.

v0.6.6 session: requirement-level ASVS 5.0.0 L1+L2 self-assessment as code
(253 requirements, CI-checked; ADR-0028) and the code-level gaps it found: administrator session
controls, step-up for ending other own sessions, top-5000 common passwords, context-word screening,
120-bit recovery codes, Fetch-Metadata on reads, Clear-Site-Data on logout. No migration.

v0.6.5 session: signed audit-chain digests for off-site write-once storage
(SEC-OPEN-008 tooling, ADR-0027) — `pnpm audit:digest keygen|create|verify`; detects consistent
superuser rewrites and deletions that the hash chain alone cannot. No migration.

v0.6.4 session: in-application security monitoring (gate S-05 code part,
ADR-0026, migration 0009) — threshold and event alerts from the audit log, incremental + daily
full audit-chain verification, log + optional signed webhook delivery, Segurança page with
one-way acknowledgement.

v0.6.3 session: transfer reservations at the source (T-26: allocate → pick list →
dispatch consumes reservations; cancel releases; destination close guarded), near-expiry lot
report, offline breached-password corpus (T-04 code part) — ADR-0025, migration 0008.

v0.6.2 session: lots with expiry and FEFO allocation, requested lots, serial-number
uniqueness (database trigger), Node 26 CI job and attested release-candidate job (ADR-0024).

v0.6.1 session: activity export + cross-document search (F-12), operator/admin
manual and runbooks (E-05), replenishment scan prompt, gitleaks in the local security scan, and
a security fix — MFA reset now revokes passkeys.

v0.6.0 session: review of v0.5 (`docs/reviews/REVIEW-2026-11-10-v0.5.md`), passkeys and account
security, the missing WMS operations (quality status, units of measure, lots in transit,
un-pick/un-pack, topology lifecycle, transfer cancel), scan-verified destinations, retention,
module boundaries, route-inventory authorization, failure-injection and migration-upgrade tests,
accessibility sweep, and the release gate as code.

## 2. Status by area

| Area                                                                                                   | Status                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Identity: Argon2id, TOTP, **passkeys (WebAuthn)**, recovery codes, sessions, CSRF, throttling, step-up | Completed & tested (automated); admin passkey policy mandatory in production                                                |
| Self-service account security (password change, own sessions, passkeys, recovery codes)                | Completed & tested                                                                                                          |
| RBAC, warehouse scope, tenant isolation, RLS, composite FKs, route-level guard                         | Completed & tested (every API operation checked)                                                                            |
| Field encryption (AES-256-GCM envelope)                                                                | Completed & tested with the local dev provider; **external KMS not implemented**                                            |
| Audit log (hash chain) + retention purge + security alerts + signed digests                            | Completed & tested; digest schedule/write-once storage, log shipping and paging **not deployed**                            |
| WMS operations (see gate F-01…F-13)                                                                    | Implemented & tested (F-01…F-13 PASS at developer level; pilot sign-off pending)                                            |
| Scan verification of destinations                                                                      | Server-side check + required in UI for putaway/moves/container moves                                                        |
| Reliability: idempotency, concurrency, failure injection, rollback, upgrade rehearsal                  | Completed & tested                                                                                                          |
| Accessibility                                                                                          | axe clean on every screen; manual screen-reader pass **not done**                                                           |
| CI workflow                                                                                            | green on GitHub per owner report (v0.5 code); now also runs `api:check` and `gate:check`; signing/gated deploy **not done** |
| Production infrastructure (WAF/ZTNA/TLS/private DB/backups/monitoring)                                 | Templates only — **NOT DEPLOYED / UNVERIFIED**                                                                              |
| Load/performance                                                                                       | **Not run** — targets not agreed                                                                                            |

## 3. Migrations and rollback plan

v0.6.13 adds **`0010_ledger_totals.sql`** (new table `position_ledger_totals`, `SECURITY DEFINER`
trigger on the ledger, back-fill under a ledger write lock) and **`0011_order_lookup_indexes.sql`**
(two indexes). Both additive. Upgrade: `pnpm db:migrate` in a quiet period (OPERATIONS.md,
"Migrations that take locks"). Rehearsed by restoring a **pre-0010 backup** (16 Nov 2026, schema 0009) with `pnpm restore:smoke
<manifest>`: 0010 and 0011 applied, verifier PASSED including the new totals-vs-ledger check (small
dataset: 4 positions); and by the upgrade test (populated v0.5.0 schema → current, totals
back-filled exactly). On the 10.1 M-row ledger the back-fill aggregate took 1.5 s with the data
freshly written and cached; expect more from a cold disk. Rollback: redeploy
v0.6.12 — it does not read the new table and the trigger only maintains it; to remove both
migrations: `DROP TRIGGER inventory_ledger_totals ON inventory_ledger; DROP FUNCTION
inventory_ledger_totals(); DROP TABLE position_ledger_totals; DROP INDEX reservations_outbound_line;
DROP INDEX containers_outbound; DELETE FROM schema_migrations WHERE version IN ('0010','0011');` —
or restore the pre-upgrade backup.

v0.6.9–v0.6.12 add **no migration**. v0.6.10 adds the optional setting `DB_STATEMENT_TIMEOUT_MS`
(ignored by older versions). Rollback: redeploy v0.6.8.

v0.6.8 adds **no migration** and no runtime change (test tooling, CI and docs only). Rollback:
redeploy v0.6.7.

v0.6.7 adds **no migration**. Rollback: redeploy v0.6.6 (the reset endpoints then accept requests
without a verification body again; recorded audit entries stay).

v0.6.6 adds **no migration**. Rollback: redeploy v0.6.5. Recovery codes issued by v0.6.6 (6 groups)
are rejected by v0.6.5's format check — users who enrolled or regenerated codes under v0.6.6 must
regenerate them after a rollback (TOTP and passkeys are unaffected).

v0.6.5 adds **no migration** (tooling only). Rollback: redeploy v0.6.4; existing digest files
stay verifiable with any later version.

v0.6.4 adds **`0009_security_monitoring.sql`** (additive: two new platform tables, one trigger,
one index on `security_audit_log (occurred_at, action)`). Upgrade: `pnpm db:migrate`; rehearsed by
restoring the **v0.6.3 backup** of this session, which applied 0009 and verified. Rollback:
redeploy v0.6.3 (it ignores the new tables; alerts simply stop) or restore the pre-upgrade backup.

v0.6.3 adds **`0008_transfer_reservations.sql`** (additive: nullable `reservations.transfer_line_id`
with composite FK, `outbound_line_id` relaxed to nullable, CHECK "exactly one demand line" — true
for every existing row —, partial index, `transfer_lines.qty_reserved` default 0). Upgrade:
`pnpm db:migrate`; rehearsed by restoring a **v0.6.2 backup** (`restore:smoke <manifest>`), which
applied 0008 and verified. Rollback: first cancel or dispatch transfers that hold reservations
(v0.6.2 code cannot consume or release transfer reservations, so that stock would stay
reserved), then redeploy v0.6.2; or restore the pre-upgrade backup.

v0.6.2 adds **`0007_lots_and_serials.sql`** (additive: new table, nullable column, trigger;
existing lots back-filled without expiry). Rollback: redeploy v0.6.1 — it ignores the new table
and column, but the serial trigger stays active (it only refuses states that were already
invalid). To remove it, restore the pre-upgrade backup.

New: `0004_passkeys_and_account.sql`, `0005_wms_completion.sql`, `0006_retention.sql` — all
additive (new tables/columns with defaults, widened CHECK, back-fill of lots in transit, a
SECURITY DEFINER purge function). Upgrade: `pnpm db:migrate`. Rehearsed by
`tests/integration/reliability.test.ts` (v0.5 schema + data → current) and by `pnpm restore:smoke`
restoring a real v0.5 backup and upgrading it. Rollback: redeploy the previous application (the
schema change is backward compatible) or restore the pre-upgrade backup; no down migrations
(`docs/DATABASE.md` §1a).

## 4. Last verified command outputs (workspace, 2026-11-18; load profiles 2026-11-17)

Environment: Ubuntu 24.04, Node **22.23.4**, pnpm **12.18.0**, PostgreSQL **16.15** (disposable
local cluster), 2 vCPU / 7.8 GB, Google Chrome for Testing for Playwright. Docker, PostgreSQL 18
and Node 26 were not available here.

| Command                                      | Result                                                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check` / `lint` / `typecheck`   | clean; documentation gate 149 files, 391 exported symbols                                                                                                              |
| `pnpm api:check` / `asvs:check`              | OpenAPI matches code (107 paths) / 253 ASVS requirements OK                                                                                                            |
| `pnpm gate:check`                            | `WMS_IN_PROGRESS`; PASS 20 · FAIL 3 · BLOCKED 10 · NOT_RUN 1                                                                                                           |
| `pnpm test:all`                              | exit 0 — unit 54, integration 59, security 120, e2e 2; no API/Vite process left afterwards                                                                             |
| `pnpm test:load` (smoke)                     | PASSED — 500 SKUs / 2 000 positions / 8 users: 171 req/s, 0 errors, 0 deadlocks                                                                                        |
| `pnpm test:load -- --profile representative` | **FAILED** one provisional target — 25 users: 125 req/s, 0 errors, 0 deadlocks, `order_pick` p95 1 017 ms (> 1 000); everything else within targets                    |
| `pnpm test:load -- --profile ledger-growth`  | PASSED — 10.1 M ledger rows: 130 req/s, 0 errors, 0 deadlocks; routine reconciliation 467 ms, deep 11.1 s                                                              |
| `pnpm security:scan`                         | all PASS incl. **gitleaks 8.24.3**; production audit clean; all-deps 1 high + 1 moderate, both dev-only and excepted (SEC-OPEN-020, SEC-OPEN-009); SBOM 122 components |
| `pnpm backup:local` / `restore:smoke`        | written (off-site NOT CONFIGURED) / PASSED (2.1 s); pre-0010 backup restored and upgraded through 0010/0011: PASSED                                                    |
| `pnpm build`                                 | contracts + API + web (390 kB JS / 109 kB gzip)                                                                                                                        |

Not run here: Docker Compose stack, PostgreSQL 18, Node 26, CodeQL/Trivy (CI only), DAST, the
stress profile (last run v0.6.8), load on production-equivalent hardware or over a network,
availability/soak tests, screen-reader testing, the owner's Windows run of v0.6.13, any
production control.

## 5. Clean-room verification from the ZIP

Run 2026-11-18 on the v0.6.14 archive: copied only the ZIP + `.sha256` into an empty directory
**whose path contains a space** (`/tmp/cr 20`) and followed `README-LOCAL-TESTING.md` "Without
Docker (native PostgreSQL)" (local PostgreSQL 16.15, fresh database; Playwright via
`PLAYWRIGHT_CHROME_PATH`). Linux only.

| Step                                                        | Result                                                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `sha256sum -c`                                              | OK                                                                                                    |
| extract → `autolemon-erp/`                                  | OK — no `.env`, `node_modules`, `.git`, `invitations-dev.txt`, backups, artifacts, `*.pem` or digests |
| `pnpm install --frozen-lockfile`                            | OK (Node 22.23.4, pnpm 12.18.0)                                                                       |
| `cp .env.example .env` → `pnpm db:migrate` → `pnpm db:seed` | 11 migrations applied (0001…0011); seed OK                                                            |
| `pnpm test:all` (format, lint, typecheck, OpenAPI, gate…)   | **exit 0** — unit 54, integration 59, security 120, e2e 2; no API/Vite process left afterwards        |
| `pnpm security:scan` without / with `GITLEAKS_BIN`          | exit 0 / exit 0 (picomatch advisory accepted as dev-only until 2026-12-31)                            |
| `pnpm test:load` (smoke)                                    | PASSED — 203 req/s                                                                                    |
| `pnpm restore:smoke`                                        | PASSED (2.4 s)                                                                                        |
| `pnpm build`                                                | exit 0                                                                                                |
| `pnpm dev`                                                  | web :5173 → 200; `/api/health` → 200; `/api/auth/session` without cookie → 401                        |

The final archive differs from the clean-room archive only in this section.

## 6. Known vulnerabilities and residual risks

- `pnpm audit`: production clean; 2 dev-only advisories under dated exceptions until 2026-12-31 —
  picomatch high (SEC-OPEN-020, no fix released yet) and minimatch moderate (SEC-OPEN-009).
- Release blockers: SEC-OPEN-002/003/004 (corpus to be provisioned)/005/007/008/010/012/013/018 (see
  `docs/security/SECURITY_OPEN_ITEMS.md`).
- Residual: staff may still use TOTP (phishable); API clients may omit the destination scan;
  same-company idempotency-key existence is observable (accepted, SEC-OPEN-019); transfer
  reservations do not expire on their own (a forgotten transfer keeps stock reserved until it is
  dispatched or cancelled — visible in the transfer's "Reservado" column); security alert
  thresholds are per company, not per user/IP; with several API replicas a new alert can be
  delivered twice (receivers de-duplicate on `alert.id`); consistent audit rewrites after the
  latest stored digest are not detected until compared with the next one (digest interval =
  exposure window); ASVS partial items V12.3.1, V13.2.4 and 13 environment items (ADR-0028/0029); control-bypass
  signal counts are per API process; parser-level rejections carry no actor; load
  baseline measured on 2 vCPU with the generator on the same machine, targets provisional;
  allocation now locks all candidate positions of the document's SKUs up front, so two orders for
  the same hot SKU serialise for the whole allocation (ADR-0031); stock relocations lock source and
  target together (ADR-0032); pack/unpack rely on the order lock (reviewed, not race-tested);
  the deep reconciliation (`?full=true`) is still linear in ledger size (60 s budget, one per
  warehouse) — the routine check is not; every ledger insert also updates one totals row;
  migrations 0010/0011 block writes while they run (ledger back-fill; two indexes); no fixed cap on concurrent sessions per user (documented compensating controls).

## 7. Next three WMS tasks

1. Owner decisions (quick): O-02 — branch protection on `main`, confirm the `node-next` and
   `release-candidate` jobs, decide on the single-developer reviewer alternative, run
   `gh attestation verify`; E-04 — agree or change `docs/perf/targets.json`.
2. S-05 code part (no owner input): scheduled daily signed audit digest (ADR-0027) with a
   pluggable hand-off to write-once storage, monitored by the security monitor (missed digest →
   alert). Deploying the storage itself stays blocked on the target environment.
3. S-03: external KMS provider for envelope encryption — needs the owner's choice (AWS KMS,
   Azure Key Vault, Google Cloud KMS or self-hosted Vault Transit); no purchase without approval.
