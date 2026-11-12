# Project state — AutoLemon ERP v0.6.5-WMS

Owning module: repository. Last updated: 2026-11-12 (Europe/Lisbon). Archive:
`AutoLemon-ERP-v0.6.5-WMS.zip` (root `autolemon-erp/`); its SHA-256 is in the adjacent
`AutoLemon-ERP-v0.6.5-WMS.zip.sha256` (a file cannot contain its own hash).

## 1. Summary

Continuation of v0.5.0 (nothing restarted). Governing instructions: the product owner's
Development Priority Update (WMS first), **Reusable Continuation Prompt v0.6** and **WMS
Production Readiness Gate v0.6**. WMS release gate state: **`WMS_IN_PROGRESS`**
(`docs/WMS_RELEASE_GATE.md`: PASS 20 · FAIL 4 · BLOCKED 9 · NOT_RUN 1). **Not production-ready.**
No other ERP business module has been started.

v0.6.5 session (continuation): signed audit-chain digests for off-site write-once storage
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

## 4. Last verified command outputs (workspace, 2026-11-12)

Environment: Ubuntu 24.04, Node **22.23.4**, pnpm **12.18.0**, PostgreSQL **16.15** (disposable
local cluster), Google Chrome for Testing for Playwright. Docker, PostgreSQL 18 and Node 26 were not
available here.

| Command                 | Result                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`     | all files formatted                                                                                                                 |
| `pnpm lint`             | 0 problems; documentation gate 132 files, 373 exported symbols                                                                      |
| `pnpm typecheck`        | 0 errors                                                                                                                            |
| `pnpm api:check`        | OpenAPI matches code (105 paths / 115 operations)                                                                                   |
| `pnpm gate:check`       | `WMS_IN_PROGRESS`; PASS 20 · FAIL 4 · BLOCKED 9 · NOT_RUN 1                                                                         |
| `pnpm test:unit`        | 7 files, **38 passed**                                                                                                              |
| `pnpm test:integration` | 7 files, **52 passed**                                                                                                              |
| `pnpm test:security`    | 10 files, **91 passed** (new `audit-digests`, 5 tests, 3× in isolation; whole project 3× with shuffled file order)                  |
| `pnpm test:e2e`         | **2 passed** (≈ 1.4 min; axe WCAG 2.2 AA clean on every navigation screen)                                                          |
| `pnpm test:all`         | exit 0                                                                                                                              |
| `pnpm security:scan`    | all PASS incl. **gitleaks 8.24.3** (CI rules); audit 0 critical / 0 high / 1 moderate (dev-only, SEC-OPEN-009); SBOM 122 components |
| `pnpm backup:local`     | encrypted backup written; off-site copy NOT CONFIGURED                                                                              |
| `pnpm restore:smoke`    | PASSED (2.3 s); no migration in this version, so no upgrade rehearsal was needed                                                    |
| `pnpm build`            | contracts + API + web (388 kB JS / 109 kB gzip)                                                                                     |
| `pnpm audit:digest …`   | keygen → create → verify on the development database: OK (exit 0)                                                                   |

Not run here: Docker Compose stack, PostgreSQL 18, Node 26, CodeQL/Trivy (CI only), DAST, load
tests, screen-reader testing, Windows run of `audit:digest` (path handling uses `INIT_CWD`; file
modes are not enforced by Windows), write-once storage, any production control.

## 5. Clean-room verification from the ZIP

Run 2026-11-12 on the v0.6.5 archive: copied only the ZIP + `.sha256` into an empty directory and
followed `README-LOCAL-TESTING.md` "Without Docker (native PostgreSQL)" (local PostgreSQL 16.15,
fresh database; Playwright via `PLAYWRIGHT_CHROME_PATH`).

| Step                                                        | Result                                                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `sha256sum -c`                                              | OK                                                                                                    |
| extract → `autolemon-erp/`                                  | OK — no `.env`, `node_modules`, `.git`, `invitations-dev.txt`, backups, artifacts, `*.pem` or digests |
| `pnpm install --frozen-lockfile`                            | OK (Node 22.23.4, pnpm 12.18.0)                                                                       |
| `cp .env.example .env` → `pnpm db:migrate` → `pnpm db:seed` | 9 migrations applied (0001…0009); seed OK                                                             |
| `pnpm typecheck` / `pnpm lint`                              | exit 0 / exit 0                                                                                       |
| `pnpm test:all`                                             | **exit 0** — unit 38, integration 52, security 91, e2e 2; gate check OK                               |
| `pnpm security:scan` (with `GITLEAKS_BIN`)                  | exit 0                                                                                                |
| `pnpm restore:smoke`                                        | PASSED (2.8 s)                                                                                        |
| `pnpm build`                                                | exit 0                                                                                                |
| `pnpm audit:digest keygen` → `create` → `verify`            | OK (exit 0), keys and digests outside the repository                                                  |
| `pnpm dev`                                                  | web :5173 → 200; `/api/health` → 200; `/api/auth/session` without cookie → 401                        |

The final archive differs from the clean-room archive only in this section.

## 6. Known vulnerabilities and residual risks

- `pnpm audit`: 1 moderate dev-only advisory (SEC-OPEN-009, time-boxed exception).
- Release blockers: SEC-OPEN-002/003/004 (corpus to be provisioned)/005/007/008/010/012/013/018 (see
  `docs/security/SECURITY_OPEN_ITEMS.md`).
- Residual: staff may still use TOTP (phishable); API clients may omit the destination scan;
  same-company idempotency-key existence is observable (accepted, SEC-OPEN-019); transfer
  reservations do not expire on their own (a forgotten transfer keeps stock reserved until it is
  dispatched or cancelled — visible in the transfer's "Reservado" column); security alert
  thresholds are per company, not per user/IP; with several API replicas a new alert can be
  delivered twice (receivers de-duplicate on `alert.id`); consistent audit rewrites after the
  latest stored digest are not detected until compared with the next one (digest interval =
  exposure window).

## 7. Next three WMS tasks

1. O-02: owner reports the CI results of the v0.6.3–v0.6.5 pushes; then container image signing
   (cosign keyless) and a deployment workflow gated on manual approval (no deployment).
2. E-04 load harness once targets are agreed.
3. S-06: line-by-line ASVS 5.0 L2 self-assessment refresh and code-level gap closure. Owner-side:
   branch protection, KMS (S-03), staging with log shipping/paging and the daily digest job,
   breached-corpus provisioning, penetration test, warehouse pilot.
