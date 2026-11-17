# WMS release evidence — v0.6.13

Owning module: release management. Companion of `docs/WMS_RELEASE_GATE.md` (criteria and
status, generated from `docs/WMS_RELEASE_STATUS.json`). This file records **how** each piece of
evidence was produced so anyone can reproduce it. Everything below was executed by the developer
(an AI assistant) in the build environment described; **none of it is an independent or human
verification**.

## 1. Environment of the recorded run (2026-11-12, Europe/Lisbon)

Ubuntu 24.04 VM, Node 22.23.4, pnpm 12.18.0, PostgreSQL 16.15 (disposable local cluster), Google
Chrome for Testing (Playwright via `PLAYWRIGHT_CHROME_PATH`). Docker/PostgreSQL 18/Node 26 not
available here. The product owner reported green GitHub Actions runs (PostgreSQL 18 service,
Node 22.x) for the v0.5 code after the CI fixes; those logs are not attached.

## 2. Commands and results

| Command                                    | Result                                                                                                                                                                      | Gate criteria                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `pnpm format:check`                        | all files formatted                                                                                                                                                         | E-05                                           |
| `pnpm lint`                                | 0 problems incl. module-boundary rules; documentation gate 141 files / 383 exported symbols                                                                                 | E-05, S-02                                     |
| `pnpm typecheck`                           | 0 errors                                                                                                                                                                    | —                                              |
| `pnpm api:check`                           | OpenAPI matches code (107 paths / 117 operations)                                                                                                                           | E-05                                           |
| `pnpm gate:check`                          | state `WMS_IN_PROGRESS`; PASS 20 · FAIL 3 · BLOCKED 10 · NOT_RUN 1                                                                                                          | all                                            |
| `pnpm test:unit`                           | 8 files, 52 passed                                                                                                                                                          | E-01                                           |
| `pnpm test:integration`                    | 7 files, 52 passed                                                                                                                                                          | F-*, E-01…E-03                                 |
| `pnpm test:security`                       | 13 files, 107 passed                                                                                                                                                        | F-01, S-*                                      |
| `pnpm test:e2e`                            | 2 passed (enrolment/TOTP login, structure, SKU, scan receipt, scan-verified putaway, quality block, search; passkey register/sign-in/step-up; axe on every screen)          | F-05, F-12, S-01                               |
| `pnpm test:all`                            | exit 0 (see `docs/PROJECT_STATE.md` §4)                                                                                                                                     | E-01                                           |
| `pnpm security:scan`                       | secrets, **gitleaks 8.24.3 with CI rules** , SAST-lite/raw-SQL/licences PASS; audit 0 critical, 0 high, 1 moderate (dev-only, SEC-OPEN-009); SBOM 122 production components | S-02, S-08                                     |
| `pnpm backup:local` + `pnpm restore:smoke` | backup of the current schema restored + verified (1.8 s); no migration in v0.6.8                                                                                            | E-03, S-03 (local key only), O-03 (local only) |
| `pnpm build`                               | contracts + API + web (390 kB JS / 109 kB gzip)                                                                                                                             | —                                              |
| Clean room from the ZIP                    | see `docs/PROJECT_STATE.md` §5                                                                                                                                              | E-06                                           |

## 2a. Load and performance (E-04, v0.6.8–v0.6.9, ADR-0030/0031)

v0.6.8 (ADR-0030) — read/move mix only; superseded by the v0.6.9 runs below, kept for history
(the stress profile was not re-run in v0.6.9):

| Profile        | Dataset / users                          | Throughput | Errors | p95 (ms) stock · sku search · global search · ledger · move | Invariants | Result                    |
| -------------- | ---------------------------------------- | ---------- | ------ | ----------------------------------------------------------- | ---------- | ------------------------- |
| smoke          | 500 SKUs, 2 000 positions, 8 users       | 439 req/s  | 0      | ≤ 110 (all)                                                 | clean      | PASSED (provisional)      |
| representative | 20 000 SKUs, 100 000 positions, 25 users | 275 req/s  | 0      | 101 · 156 · 146 · 111 · 130                                 | clean      | PASSED (provisional)      |
| stress         | same dataset, 60 users                   | 250 req/s  | 0      | 276 · 328 · 313 · 283 · 308                                 | clean      | report only (degradation) |

v0.6.9 (ADR-0031) — mix now includes `order_allocate` (create + allocate an order on the 20
hottest SKUs, 10 %); deadlocks counted per run:

| Profile        | Dataset / users                             | Throughput | Errors | p95 (ms) stock · sku · global · ledger · move · allocate | Deadlocks | One-offs (ms)                                                                 | Result               |
| -------------- | ------------------------------------------- | ---------- | ------ | -------------------------------------------------------- | --------- | ----------------------------------------------------------------------------- | -------------------- |
| smoke          | 500 SKUs, 2 000 positions, 8 users          | 257 req/s  | 0      | all ≤ 177                                                | 0         | all OK                                                                        | PASSED (provisional) |
| representative | 20 000 SKUs, 100 000 positions, 25 users    | 196 req/s  | 0      | 120 · 191 · 185 · 129 · 155 · 442                        | 0         | reconciliation 509 · CSV run window 116 · by SKU 16                           | PASSED (provisional) |
| ledger-growth  | same + **10 100 000 ledger rows**, 25 users | 191 req/s  | 0      | 123 · 193 · 185 · 132 · 161 · 457                        | 0         | reconciliation 11 232 · CSV run window 709 · over-cap 409 in 1 920 · by SKU 7 | PASSED (provisional) |

v0.6.10 re-run of `ledger-growth` (after the reconciliation fix): 198 req/s, 0 errors, 0
deadlocks, p95 118 · 180 · 176 · 123 · 151 · 432 ms, reconciliation 9 603 ms (budget 60 s), CSV run
window 618 ms, over-cap 409 in 1 931 ms, by SKU 24 ms — PASSED (provisional). On the owner's
Windows workstation the v0.6.9 reconciliation exceeded the 15 s statement limit (HTTP 500);
fixed in v0.6.10 (`tests/integration/query-limits.test.ts`), owner re-run pending.

v0.6.13 (ADR-0032) — mix adds `order_pick` (order → allocate → read → pick into one shared
packing node, half unpicked; 10 %); reconciliation measured in both forms:

| Profile        | Dataset / users                          | Throughput | Errors | p95 (ms) stock · sku · global · ledger · move · allocate · pick | Deadlocks | One-offs (ms)                                                                            | Result                                         |
| -------------- | ---------------------------------------- | ---------- | ------ | --------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| smoke          | 500 SKUs, 2 000 positions, 8 users       | 171 req/s  | 0      | 26 · 27 · 30 · 32 · 54 · 171 · 340                              | 0         | reconciliation 21 · full 29                                                              | PASSED (provisional)                           |
| representative | 20 000 SKUs, 100 000 positions, 25 users | 125 req/s  | 0      | 134 · 193 · 188 · 144 · 172 · 481 · **1 017**                   | 0         | reconciliation 306 · full 561 · CSV window 164 · by SKU 7                                | **FAILED** (`order_pick` > 1 000, provisional) |
| ledger-growth  | same + **10 100 000 ledger rows**        | 130 req/s  | 0      | 128 · 185 · 186 · 136 · 164 · 461 · 986                         | 0         | reconciliation **467** · full 11 072 · CSV window 819 · over-cap 409 in 2 406 · by SKU 9 | PASSED (provisional)                           |

Found and fixed in v0.6.13: three relocation deadlocks (race tests; HTTP 500 under sustained
contention) and the order view starting from all active reservations (p95 550 → 36 ms in smoke).
Closed-loop users without think time saturate the 2 vCPUs; multi-request flows (`order_pick`)
are the first to cross their targets (ADR-0032).

Found and fixed during these runs: deadlocks in allocation/moves (10 per smoke run before the
fix, 0 after; `tests/integration/lock-ordering.test.ts`) and the ledger page joining the whole
ledger before limiting (4.1 s at 300 000 rows before, 132 ms p95 at 10 M rows after).

2 vCPU / 7.8 GB workspace, generator in the same process, no network; targets PROVISIONAL —
E-04 stays BLOCKED until they are agreed and repeated on production-equivalent hardware.
Details: `docs/perf/LAST_RUN_*.md`.

## 2b. Owner workstation runs (Windows, PostgreSQL 18)

Reported by the owner (console output pasted into the session; not re-run by the assistant):

| Date       | Version | Command                                       | Result                                                                                                                                                                                                      |
| ---------- | ------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-16 | v0.6.9  | `ledger-growth`                               | Seeded 10 M rows; reconciliation returned HTTP 500 (statement timeout) → fixed in v0.6.10                                                                                                                   |
| 2026-11-17 | v0.6.10 | `pnpm test:all`                               | format, lint, typecheck, OpenAPI, gate: OK; unit 52/52, integration 56/56 (incl. lock-ordering, query-limits), security 107/107; **e2e did not start**: `'C:\Program' is not recognized` → fixed in v0.6.11 |
| 2026-11-17 | v0.6.11 | `pnpm test:all`                               | e2e started; afterwards the API server kept running and logged "database does not exist" every 5 s (orphaned process) → fixed in v0.6.12                                                                    |
| 2026-11-17 | v0.6.12 | `pnpm test:all`, commit, push, GitHub Actions | Owner reported the suite passed (no output pasted), committed v0.6.9–v0.6.12 together and pushed; owner reported the CI run green (job list not pasted)                                                     |

The e2e failure was in the test tooling, not the product: `scripts/with-test-db.mjs` ran Node's own
path through the Windows shell unquoted. All repository scripts now spawn through `shellSafe`
(`tests/security/script-spawn.test.ts`). Owner re-run of `ledger-growth` pending; owner run of v0.6.13 (`pnpm test:all`) pending.

## 3. Test files → criteria

| File                                              | Tests | Proves                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/acceptance.test.ts`            | 12    | master-spec scenarios 1–9, 12 (F-02…F-11, F-13)                                                                                                                                                                                                                                                |
| `tests/integration/inventory-property.test.ts`    | 1     | random command sequences keep ledger/balance/reservation invariants (F-06, E-01)                                                                                                                                                                                                               |
| `tests/integration/wms-completion.test.ts`        | 16    | UoM, quality status, un-pick/un-pack/cancel, topology lifecycle, lots in transit, transfer cancel, SoD, replenishment, reversal (F-02…F-11)                                                                                                                                                    |
| `tests/integration/reports-search.test.ts`        | 5     | activity export (authz, step-up, bounded period, formula safety, audit) and cross-document search (scope, literal matching, injection) — F-12                                                                                                                                                  |
| `tests/integration/lots-serials.test.ts`          | 7     | lot master + expiry, FEFO (expired never allocated), requested lot, serial uniqueness across warehouses, in transit and under concurrency — F-02, F-07                                                                                                                                         |
| `tests/integration/transfer-reservations.test.ts` | 6     | source reservations (FEFO), outbound cannot take reserved stock, destination close guard and RLS on the pick list, dispatch consumes / full shipment and cancel release, concurrent allocation, cross-warehouse conservation, expiry report (F-07, F-08, F-12)                                 |
| `tests/integration/reliability.test.ts`           | 5     | scan verification (F-05), failure injection + rollback + same-key retry (E-02), v0.5 → current upgrade (E-03), FULL count with recount (F-11)                                                                                                                                                  |
| `tests/security/isolation.test.ts`                | 14    | tenant/warehouse isolation, RLS, composite FKs, append-only, audit tamper, export/PII authz (F-01, S-05)                                                                                                                                                                                       |
| `tests/security/attacks.test.ts`                  | 21    | injection, XSS, CSRF, MFA bypass, sessions, CSV, idempotency, concurrency (S-01, S-02, E-02)                                                                                                                                                                                                   |
| `tests/security/crypto.test.ts`                   | 7     | AEAD round-trip, tamper, rotation, rewrap (S-03, local provider)                                                                                                                                                                                                                               |
| `tests/security/passkeys-account.test.ts`         | 18    | WebAuthn ceremonies and attacks, admin passkey policy, MFA reset revokes passkeys, self-service account security (S-01)                                                                                                                                                                        |
| `tests/security/route-inventory.test.ts`          | 5     | every API operation: anonymous, CSRF, cross-warehouse, admin-only, malformed ids (F-01, S-01)                                                                                                                                                                                                  |
| `tests/security/security-monitoring.test.ts`      | 12    | alert rules and dedupe (incl. concurrent monitors), acknowledgement authz/step-up/one-way/isolation/audit, re-raise only for new events, incremental and daily full chain tamper detection, outbox/job-failure alerts, signed webhook without PII, DB guards, webhook config validation (S-05) |
| `tests/security/audit-digests.test.ts`            | 5     | signed digests: content without audit data, forgery/other key/malformed/non-Ed25519 rejected, consistent superuser rewrite detected (chain check alone passes), truncation and plain edits detected, CLI key handling and exit codes (S-05, SEC-OPEN-008)                                      |
| `tests/security/session-controls.test.ts`         | 7     | admin ends one user's/all sessions (step-up, isolation, audit), step-up for ending other own sessions, idle/absolute expiry, cross-site reads refused, TRACE, Clear-Site-Data, 120-bit and legacy recovery codes (S-06)                                                                        |
| `tests/security/asvs-assessment.test.ts`          | 2     | ASVS 5.0.0 L1+L2 assessment complete/current; checker fails closed (S-06)                                                                                                                                                                                                                      |
| `tests/security/recovery-and-signals.test.ts`     | 7     | recorded identity check for MFA/password reset, self-recovery refused, admin-issued password reset end to end, control-bypass signals (validation, parsers, throttling) once per window with summary and no payload, `security.probing` alert, framing/generic-error evidence (S-06)           |
| `tests/security/retention.test.ts`                | 2     | bounded purge, runtime role without DELETE (S-05)                                                                                                                                                                                                                                              |
| `tests/security/module-boundaries.test.ts`        | 4     | lint-enforced module boundaries (architecture invariant)                                                                                                                                                                                                                                       |
| `tests/security/release-gate.test.ts`             | 3     | the release-gate guard refuses unearned states (process)                                                                                                                                                                                                                                       |
| `tests/e2e/warehouse.spec.ts`                     | 2     | real browser flows + axe on every screen (F-05, F-12, S-01)                                                                                                                                                                                                                                    |

## 4. What is explicitly NOT evidenced

Load/performance (E-04, targets not agreed); production environment controls, TLS/at-rest
encryption, WAF/ZTNA, log shipping/paging (the in-app alerts exist), off-site backups and DR rehearsal (S-04, O-01, O-03…O-05);
external KMS (S-03); the full HIBP breached-password corpus (only synthetic corpora were tested); DAST, human code review and penetration test (S-06…S-08); signed artifacts and
gated deployment (O-02; the attested release job exists but has not run yet); operator pilot (O-06); release-owner approval (O-07); rehearsal of the
runbooks (O-04) and staff review of the manual (O-06).
