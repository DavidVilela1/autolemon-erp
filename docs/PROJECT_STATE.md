# Project state — AutoLemon ERP v0.5.0-WMS

Owning module: repository. Last updated: 2026-11-09 (Europe/Lisbon). Archive:
`AutoLemon-ERP-v0.5.0-WMS.zip` (root `autolemon-erp/`); its SHA-256 is in the adjacent
`AutoLemon-ERP-v0.5.0-WMS.zip.sha256` (a file cannot contain its own hash).

## 1. Summary

A working, tested **development** build of the platform foundation and the autonomous WMS. All
15 acceptance scenarios of the master specification have automated or scripted evidence (table
§3). **Not production-ready**: production remains blocked by the items in
`docs/security/SECURITY_OPEN_ITEMS.md` (WebAuthn, KMS, deployed WAF/ZTNA/TLS/private network,
off-site immutable backups, executed CI, DAST, independent pentest).

## 2. Status by area

| Area                                                                                                                                   | Status                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Monorepo, pinned deps, lockfile, SBOM                                                                                                  | Completed & tested                                                                                         |
| Identity: Argon2id, invitation enrolment, TOTP MFA, recovery codes, password/MFA reset, sessions, CSRF, throttling, step-up            | Completed & tested                                                                                         |
| WebAuthn / passkeys                                                                                                                    | **Incomplete — not implemented** (T-01)                                                                    |
| RBAC (default deny), warehouse scope, tenant isolation, RLS, composite FKs                                                             | Completed & tested                                                                                         |
| Field encryption (AES-256-GCM, envelope DEKs, rotation, rewrap)                                                                        | Completed & tested (local-dev provider only)                                                               |
| External KMS provider                                                                                                                  | **Incomplete** — fail-closed stub (T-03)                                                                   |
| Hash-chained audit log + verification                                                                                                  | Completed & tested; off-site shipping **not deployed**                                                     |
| WMS topology, containers, SKU master, CSV import                                                                                       | Completed & tested                                                                                         |
| Inventory engine, ledger, reservations, idempotency, concurrency                                                                       | Completed & tested (incl. property-based)                                                                  |
| Inbound/putaway, outbound/pick/pack/dispatch/backorder, transfers, returns, counts, replenishment, corrections, reports/export, labels | Completed & tested (API); UI implemented — e2e covers login/MFA, structure, SKU, receiving, putaway, stock |
| UI screens other than those in the e2e flow                                                                                            | Implemented, manually unverified in a browser (typecheck/lint/build pass)                                  |
| Lot/serial full flow, UoM conversions                                                                                                  | Partially implemented (data model + lot capture on receipt); T-20/T-21                                     |
| Outbox dispatcher                                                                                                                      | Completed & tested (no subscribers in WMS-only mode)                                                       |
| CI workflow (SHA-pinned)                                                                                                               | Implemented, **never executed** (no runner)                                                                |
| Dockerfile / production compose / nginx / Postgres / pgBackRest templates                                                              | Implemented as templates, **NOT DEPLOYED / UNVERIFIED**                                                    |
| Local encrypted backup + disposable restore verification                                                                               | Completed & tested                                                                                         |
| Documentation set, ADRs (18), threat model, ASVS self-assessment                                                                       | Completed (documentation gate passes; quality needs human review)                                          |

## 3. Acceptance evidence (spec §8)

| #   | Scenario                                                                                                                                                                                                                                           | Evidence                                                                                                             | Result                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1–9 | Company/warehouses/staff; receive 28/30 (short 2); 3 positions/28; reserve 12 → ATA 16; pick/pack 2 packages/dispatch → 16; transfer 5 → Porto 11/Lisboa 5; return 1 saleable + 1 quarantine; count + approved adjustment + ledger; whole-box move | `tests/integration/acceptance.test.ts`                                                                               | PASS                                                          |
| 10  | Cross-warehouse/tenant, unauthorized export/decryption                                                                                                                                                                                             | `tests/security/isolation.test.ts` (14 tests)                                                                        | PASS                                                          |
| 11  | SQLi/XSS/CSRF/MFA bypass/session replay/cookie tampering/invalid ids/CSV/duplicates/competing reservations                                                                                                                                         | `tests/security/attacks.test.ts` (21), `tests/integration/inventory-property.test.ts`, `tests/e2e/warehouse.spec.ts` | PASS                                                          |
| 12  | WMS-only startup                                                                                                                                                                                                                                   | acceptance test 12 + module registry                                                                                 | PASS                                                          |
| 13  | Encryption round-trip, tamper, denial, rotation                                                                                                                                                                                                    | `tests/security/crypto.test.ts` (7)                                                                                  | PASS                                                          |
| 14  | Disposable local backup restore + integrity                                                                                                                                                                                                        | `pnpm backup:local` + `pnpm restore:smoke`                                                                           | PASS (1.3–1.4 s on synthetic data; off-site **not verified**) |
| 15  | Clean install from the final ZIP                                                                                                                                                                                                                   | clean-room run, §5                                                                                                   | see §5                                                        |

## 4. Last verified command outputs (workspace, 2026-11-09)

Environment: Ubuntu 24.04, Node **22.23.4**, pnpm **12.18.0**, PostgreSQL **16.15** (disposable
local cluster), Google Chrome for Testing 153 for Playwright. Docker Hub and nodejs.org were not
reachable, so Docker Compose/PostgreSQL 18 and Node 26 were **not** exercised (ADR-0016).

| Command                                                                        | Result                                                                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm format:check`                                                            | All matched files use Prettier code style                                                                                            |
| `pnpm lint`                                                                    | ESLint 0 problems; documentation gate: 101 files, 303 exported symbols documented                                                    |
| `pnpm typecheck`                                                               | 0 errors (contracts, api, web, web vite config, tests)                                                                               |
| `pnpm api:check`                                                               | OpenAPI spec matches code (79 paths / 89 operations)                                                                                 |
| `pnpm test:unit`                                                               | 7 files, **35 passed**                                                                                                               |
| `pnpm test:integration`                                                        | 2 files, **13 passed** (12 acceptance + 1 property test: 12 runs × ≤ 25 commands)                                                    |
| `pnpm test:security`                                                           | 3 files, **42 passed**                                                                                                               |
| `pnpm test:e2e`                                                                | **1 passed** (≈ 37 s; includes waiting for a fresh TOTP step; axe WCAG 2.2 AA: 0 violations on login and stock screens)              |
| `pnpm test:all`                                                                | exit 0                                                                                                                               |
| `pnpm build`                                                                   | contracts + API (tsc) + web (Vite: 356 kB JS / 100 kB gzip, 15.6 kB CSS)                                                             |
| Built API smoke (`node apps/api/dist/main.js`)                                 | `/api/health` 200 with CSP + request id; `/api/auth/session` 401 JSON                                                                |
| `pnpm security:scan`                                                           | all PASS; pnpm audit: 0 critical, 0 high, 1 moderate (dev-only minimatch, SEC-OPEN-009); SBOM 110 production components; no copyleft |
| `pnpm restore:smoke`                                                           | PASSED: checksums + GCM OK; positions=4 ledger=4 audit=2 chains=1 decrypted=1                                                        |
| `pnpm db:reset:dev` with `NODE_ENV=production` / remote host / `prod_erp` name | refused (3/3)                                                                                                                        |

Skipped / could not run here: Docker Compose stack, PostgreSQL 18, Node 26, CI workflow
(CodeQL, gitleaks, Trivy, container build/scan), DAST, load tests, WebAuthn, screen-reader pass.

## 5. Clean-room verification from the ZIP (2026-11-09)

Procedure: copied only `AutoLemon-ERP-v0.5.0-WMS.zip` + `.sha256` into an empty `/tmp/cleanroom`,
then followed `README-LOCAL-TESTING.md` (macOS/Linux section). Deviations forced by the build
environment: (a) PostgreSQL ran as the local 16.15 cluster instead of `docker compose up -d`, so
`DATABASE_URL`/`APP_DATABASE_URL` in `.env` pointed to it (database `autolemon_cleanroom`);
(b) Playwright used `PLAYWRIGHT_CHROME_PATH=/opt/google/chrome/chrome` instead of
`pnpm exec playwright install chromium`. The pnpm content store on the machine was reused as a
package cache (packages still verified against the lockfile).

| Step                                                                                                         | Result                                                                                                   |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `sha256sum -c AutoLemon-ERP-v0.5.0-WMS.zip.sha256`                                                           | OK                                                                                                       |
| `unzip … -d AutoLemon-ERP-extracted` → `autolemon-erp/`                                                      | OK                                                                                                       |
| `node --version` / `pnpm --version`                                                                          | v22.23.4 / 12.18.0                                                                                       |
| `pnpm install --frozen-lockfile`                                                                             | OK (postinstall builds `@autolemon/contracts`)                                                           |
| `cp .env.example .env` → `pnpm db:migrate`                                                                   | dev secrets generated; 3 migrations applied                                                              |
| `pnpm db:seed`                                                                                               | OK, invitation links printed                                                                             |
| `pnpm test:all` (format, lint + doc gate, typecheck, api:check, unit 35, integration 13, security 42, e2e 1) | **exit 0**                                                                                               |
| `pnpm security:scan`                                                                                         | exit 0 (0 critical/high; 1 moderate dev-only)                                                            |
| `pnpm restore:smoke`                                                                                         | PASSED (disposable DB created, verified, dropped)                                                        |
| `pnpm build`                                                                                                 | exit 0                                                                                                   |
| `pnpm dev`                                                                                                   | web http://localhost:5173 → 200; `/api/health` via proxy → 200; `/api/auth/session` without cookie → 401 |

Defects found by the clean room and fixed before the final archive: (1) `@autolemon/contracts`
`dist/` is not shipped → added root `postinstall` build; (2) the SBOM copied into `docs/sbom/`
failed `prettier --check` → excluded from formatting. The clean room was then repeated from a
freshly built archive with the results above. The final archive differs from the clean-room archive only in documentation (`docs/PROJECT_STATE.md`, `docs/HANDOVER.md`: result recording and two corrected counts); no code, test or configuration file changed — compare the two manifests to confirm.

## 6. Unresolved vulnerabilities and skipped checks

- `pnpm audit`: 1 moderate (GHSA-g3hv-75wg-m249, minimatch via eslint tooling, dev-only) —
  time-boxed exception SEC-OPEN-009.
- Not run: CI workflow jobs (CodeQL, gitleaks, Trivy fs/image), container build, DAST, load
  tests, Node 26 / PostgreSQL 18 runs, WebAuthn (not implemented), screen-reader testing,
  production network/backup controls (NOT DEPLOYED / UNVERIFIED).

## 7. Next step

`docs/NEXT_TASKS.md` T-01 (WebAuthn) and T-02 (execute CI on Node 26 + PostgreSQL 18), then the
staging hardening block T-03…T-07.
