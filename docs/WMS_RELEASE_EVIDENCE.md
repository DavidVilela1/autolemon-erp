# WMS release evidence — v0.6.2

Owning module: release management. Companion of `docs/WMS_RELEASE_GATE.md` (criteria and
status, generated from `docs/WMS_RELEASE_STATUS.json`). This file records **how** each piece of
evidence was produced so anyone can reproduce it. Everything below was executed by the developer
(an AI assistant) in the build environment described; **none of it is an independent or human
verification**.

## 1. Environment of the recorded run (2026-11-10, Europe/Lisbon)

Ubuntu 24.04 VM, Node 22.23.4, pnpm 12.18.0, PostgreSQL 16.15 (disposable local cluster), Google
Chrome for Testing (Playwright via `PLAYWRIGHT_CHROME_PATH`). Docker/PostgreSQL 18/Node 26 not
available here. The product owner reported green GitHub Actions runs (PostgreSQL 18 service,
Node 22.x) for the v0.5 code after the CI fixes; those logs are not attached.

## 2. Commands and results

| Command                                    | Result                                                                                                                                                                                                                                    | Gate criteria                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `pnpm format:check`                        | all files formatted                                                                                                                                                                                                                       | E-05                                           |
| `pnpm lint`                                | 0 problems incl. module-boundary rules; documentation gate 121 files / 334 exported symbols                                                                                                                                               | E-05, S-02                                     |
| `pnpm typecheck`                           | 0 errors                                                                                                                                                                                                                                  | —                                              |
| `pnpm api:check`                           | OpenAPI matches code (100 paths / 110 operations)                                                                                                                                                                                         | E-05                                           |
| `pnpm gate:check`                          | state `WMS_IN_PROGRESS`; PASS 20 · FAIL 4 · BLOCKED 9 · NOT_RUN 1                                                                                                                                                                         | all                                            |
| `pnpm test:unit`                           | 7 files, 37 passed                                                                                                                                                                                                                        | E-01                                           |
| `pnpm test:integration`                    | 6 files, 46 passed                                                                                                                                                                                                                        | F-*, E-01…E-03                                 |
| `pnpm test:security`                       | 8 files, 74 passed                                                                                                                                                                                                                        | F-01, S-*                                      |
| `pnpm test:e2e`                            | 2 passed (enrolment/TOTP login, structure, SKU, scan receipt, scan-verified putaway, quality block, search; passkey register/sign-in/step-up; axe on every screen)                                                                        | F-05, F-12, S-01                               |
| `pnpm test:all`                            | exit 0 (see `docs/PROJECT_STATE.md` §4)                                                                                                                                                                                                   | E-01                                           |
| `pnpm security:scan`                       | secrets, **gitleaks 8.24.3 with CI rules** (a planted `const key = '…'` probe was detected, then removed), SAST-lite/raw-SQL/licences PASS; audit 0 critical, 0 high, 1 moderate (dev-only, SEC-OPEN-009); SBOM 122 production components | S-02, S-08                                     |
| `pnpm backup:local` + `pnpm restore:smoke` | backup of the current schema restored + verified (2.0 s); a **v0.5.0 backup** restored, upgraded forward (0004–0006) and verified (1.9 s)                                                                                                 | E-03, S-03 (local key only), O-03 (local only) |
| `pnpm build`                               | contracts + API + web (382 kB JS / 107 kB gzip)                                                                                                                                                                                           | —                                              |
| Clean room from the ZIP                    | see `docs/PROJECT_STATE.md` §5                                                                                                                                                                                                            | E-06                                           |

## 3. Test files → criteria

| File                                           | Tests | Proves                                                                                                                                                 |
| ---------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/integration/acceptance.test.ts`         | 12    | master-spec scenarios 1–9, 12 (F-02…F-11, F-13)                                                                                                        |
| `tests/integration/inventory-property.test.ts` | 1     | random command sequences keep ledger/balance/reservation invariants (F-06, E-01)                                                                       |
| `tests/integration/wms-completion.test.ts`     | 16    | UoM, quality status, un-pick/un-pack/cancel, topology lifecycle, lots in transit, transfer cancel, SoD, replenishment, reversal (F-02…F-11)            |
| `tests/integration/reports-search.test.ts`     | 5     | activity export (authz, step-up, bounded period, formula safety, audit) and cross-document search (scope, literal matching, injection) — F-12          |
| `tests/integration/lots-serials.test.ts`       | 7     | lot master + expiry, FEFO (expired never allocated), requested lot, serial uniqueness across warehouses, in transit and under concurrency — F-02, F-07 |
| `tests/integration/reliability.test.ts`        | 5     | scan verification (F-05), failure injection + rollback + same-key retry (E-02), v0.5 → current upgrade (E-03), FULL count with recount (F-11)          |
| `tests/security/isolation.test.ts`             | 14    | tenant/warehouse isolation, RLS, composite FKs, append-only, audit tamper, export/PII authz (F-01, S-05)                                               |
| `tests/security/attacks.test.ts`               | 21    | injection, XSS, CSRF, MFA bypass, sessions, CSV, idempotency, concurrency (S-01, S-02, E-02)                                                           |
| `tests/security/crypto.test.ts`                | 7     | AEAD round-trip, tamper, rotation, rewrap (S-03, local provider)                                                                                       |
| `tests/security/passkeys-account.test.ts`      | 18    | WebAuthn ceremonies and attacks, admin passkey policy, MFA reset revokes passkeys, self-service account security (S-01)                                |
| `tests/security/route-inventory.test.ts`       | 5     | every API operation: anonymous, CSRF, cross-warehouse, admin-only, malformed ids (F-01, S-01)                                                          |
| `tests/security/retention.test.ts`             | 2     | bounded purge, runtime role without DELETE (S-05)                                                                                                      |
| `tests/security/module-boundaries.test.ts`     | 4     | lint-enforced module boundaries (architecture invariant)                                                                                               |
| `tests/security/release-gate.test.ts`          | 3     | the release-gate guard refuses unearned states (process)                                                                                               |
| `tests/e2e/warehouse.spec.ts`                  | 2     | real browser flows + axe on every screen (F-05, F-12, S-01)                                                                                            |

## 4. What is explicitly NOT evidenced

Load/performance (E-04, targets not agreed); production environment controls, TLS/at-rest
encryption, WAF/ZTNA, monitoring, off-site backups and DR rehearsal (S-04, O-01, O-03…O-05);
external KMS (S-03); DAST, human code review and penetration test (S-06…S-08); signed artifacts and
gated deployment (O-02; the attested release job exists but has not run yet); operator pilot (O-06); release-owner approval (O-07); rehearsal of the
runbooks (O-04) and staff review of the manual (O-06).
