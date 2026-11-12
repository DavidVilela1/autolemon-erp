# Project state — AutoLemon ERP v0.6.2-WMS

Owning module: repository. Last updated: 2026-11-10 (Europe/Lisbon). Archive:
`AutoLemon-ERP-v0.6.2-WMS.zip` (root `autolemon-erp/`); its SHA-256 is in the adjacent
`AutoLemon-ERP-v0.6.2-WMS.zip.sha256` (a file cannot contain its own hash).

## 1. Summary

Continuation of v0.5.0 (nothing restarted). Governing instructions: the product owner's
Development Priority Update (WMS first), **Reusable Continuation Prompt v0.6** and **WMS
Production Readiness Gate v0.6**. WMS release gate state: **`WMS_IN_PROGRESS`**
(`docs/WMS_RELEASE_GATE.md`: PASS 20 · FAIL 4 · BLOCKED 9 · NOT_RUN 1). **Not production-ready.**
No other ERP business module has been started.

v0.6.2 session (continuation): lots with expiry and FEFO allocation, requested lots, serial-number
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
| Audit log (hash chain) + retention purge                                                               | Completed & tested; off-site digests/monitoring **not deployed**                                                            |
| WMS operations (see gate F-01…F-13)                                                                    | Implemented & tested except activity export/search (F-12), FEFO/serials, transfer reservations                              |
| Scan verification of destinations                                                                      | Server-side check + required in UI for putaway/moves/container moves                                                        |
| Reliability: idempotency, concurrency, failure injection, rollback, upgrade rehearsal                  | Completed & tested                                                                                                          |
| Accessibility                                                                                          | axe clean on every screen; manual screen-reader pass **not done**                                                           |
| CI workflow                                                                                            | green on GitHub per owner report (v0.5 code); now also runs `api:check` and `gate:check`; signing/gated deploy **not done** |
| Production infrastructure (WAF/ZTNA/TLS/private DB/backups/monitoring)                                 | Templates only — **NOT DEPLOYED / UNVERIFIED**                                                                              |
| Load/performance                                                                                       | **Not run** — targets not agreed                                                                                            |

## 3. Migrations and rollback plan

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

## 4. Last verified command outputs (workspace, 2026-11-10)

Environment: Ubuntu 24.04, Node **22.23.4**, pnpm **12.18.0**, PostgreSQL **16.15** (disposable
local cluster), Google Chrome for Testing for Playwright. Docker, PostgreSQL 18 and Node 26 were not
available here.

| Command                 | Result                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`     | all files formatted                                                                                                                 |
| `pnpm lint`             | 0 problems; documentation gate 121 files, 334 exported symbols                                                                      |
| `pnpm typecheck`        | 0 errors                                                                                                                            |
| `pnpm api:check`        | OpenAPI matches code (100 paths / 110 operations)                                                                                   |
| `pnpm gate:check`       | `WMS_IN_PROGRESS`; PASS 20 · FAIL 4 · BLOCKED 9 · NOT_RUN 1                                                                         |
| `pnpm test:unit`        | 7 files, **37 passed**                                                                                                              |
| `pnpm test:integration` | 6 files, **46 passed**                                                                                                              |
| `pnpm test:security`    | 8 files, **74 passed**                                                                                                              |
| `pnpm test:e2e`         | **2 passed** (≈ 1.5 min; axe WCAG 2.2 AA clean on all 17 navigation screens, login and account)                                     |
| `pnpm test:all`         | exit 0                                                                                                                              |
| `pnpm security:scan`    | all PASS incl. **gitleaks 8.24.3** (CI rules); audit 0 critical / 0 high / 1 moderate (dev-only, SEC-OPEN-009); SBOM 122 components |
| `pnpm backup:local`     | encrypted backup written; off-site copy NOT CONFIGURED                                                                              |
| `pnpm restore:smoke`    | PASSED (2.7 s)                                                                                                                      |
| `pnpm build`            | contracts + API + web (382 kB JS / 107 kB gzip)                                                                                     |

Not run here: Docker Compose stack, PostgreSQL 18, Node 26, CodeQL/gitleaks/Trivy (CI only), DAST,
load tests, screen-reader testing, any production control.

## 5. Clean-room verification from the ZIP

Run 2026-11-10 on the v0.6.2 archive: copied only the ZIP + `.sha256` into an empty directory and
followed `README-LOCAL-TESTING.md` "Without Docker (native PostgreSQL)" (local PostgreSQL 16.15,
fresh database; Playwright via `PLAYWRIGHT_CHROME_PATH`).

| Step                                                        | Result                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `sha256sum -c`                                              | OK                                                                                         |
| extract → `autolemon-erp/`                                  | OK — no `.env`, `node_modules`, `.git`, `invitations-dev.txt`, backups or artifacts inside |
| `pnpm install --frozen-lockfile`                            | OK (Node 22.23.4, pnpm 12.18.0)                                                            |
| `cp .env.example .env` → `pnpm db:migrate` → `pnpm db:seed` | 7 migrations applied; seed OK                                                              |
| `pnpm typecheck` / `pnpm lint`                              | exit 0 / exit 0                                                                            |
| `pnpm test:all`                                             | **exit 0** — unit 37, integration 46, security 74, e2e 2; gate check OK                    |
| `pnpm security:scan` (with `GITLEAKS_BIN`)                  | exit 0                                                                                     |
| `pnpm restore:smoke`                                        | PASSED (2.7 s)                                                                             |
| `pnpm build`                                                | exit 0                                                                                     |
| `pnpm dev`                                                  | web :5173 → 200; `/api/health` → 200; `/api/auth/session` without cookie → 401             |

The final archive differs from the clean-room archive only in this section.

## 6. Known vulnerabilities and residual risks

- `pnpm audit`: 1 moderate dev-only advisory (SEC-OPEN-009, time-boxed exception).
- Release blockers: SEC-OPEN-002/003/004/005/007/008/010/012/013/018 (see
  `docs/security/SECURITY_OPEN_ITEMS.md`).
- Residual: staff may still use TOTP (phishable); API clients may omit the destination scan;
  same-company idempotency-key existence is observable (accepted, SEC-OPEN-019).

## 7. Next three WMS tasks

1. T-26 transfer reservations at the source; near-expiry report.
2. S-05/S-06 code parts: security-event metrics/alert hooks, breached-password corpus check.
3. E-04 load harness once targets are agreed. Owner-side: confirm the new CI jobs, branch
   protection, KMS, staging, penetration test, warehouse pilot.
