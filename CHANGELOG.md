# Changelog

All notable changes. Owning module: repository. Format: Keep a Changelog; versioning: SemVer.

## [0.6.12-WMS] — 2026-11-17

Follow-up to v0.6.11 from the owner's Windows run. Gate state stays **`WMS_IN_PROGRESS`**
(PASS 20 · FAIL 3 · BLOCKED 10 · NOT_RUN 1). Test tooling only; no product code or migration.

### Fixed

- **e2e left the API server running on Windows.** After e2e, the API kept logging "database
  … does not exist" every 5 s: the script stopped only the `cmd.exe` wrapper, and `tsx` runs the
  server in a child Node process, so the server survived and its jobs hit the dropped test
  database. New `startTree()` / `killTree()` in `scripts/dev-env.mjs` stop the whole process
  tree (`taskkill /T /F` on Windows, process group on POSIX); `e2e-inner.mjs` uses them, also on
  Ctrl+C.
- **`script-spawn.test.ts` flagged the helper file itself** (the new `killTree` checks the
  platform); `dev-env.mjs` is exempt from that guard.
- **Typed import instead of a suppression:** new `scripts/dev-env.d.mts` declares the helpers, so
  the test imports them with real types (no `@ts-expect-error`).

## [0.6.11-WMS] — 2026-11-17

Fix found by the owner running `pnpm test:all` (v0.6.10) on Windows: every check passed except
e2e, which did not start (`'C:\Program' is not recognized as an internal or external command`).
Gate state stays **`WMS_IN_PROGRESS`** (PASS 20 · FAIL 3 · BLOCKED 10 · NOT_RUN 1). Test tooling
only; no product code or migration.

### Fixed

- **Repository scripts on Windows when a path contains a space.** The scripts use a shell on
  Windows (the `pnpm`/`tsx`/`vitest` shims are `.cmd` files), and Node joins command and arguments
  unquoted, so `C:\Program Files\nodejs\node.exe` (passed by `run-e2e.mjs`) broke at the space.
  This bug dates back to the v0.5.0 baseline. The same pattern would also break `restore:smoke`, `security:scan` (e.g. `GITLEAKS_BIN`
  under Program Files) and every disposable-DB test run for a repository under a folder with a
  space (`C:\Users\Ana Silva\…`). New `shellSafe()` in `scripts/dev-env.mjs` quotes command and
  arguments on Windows and uses no shell elsewhere; all 13 spawn sites in `with-test-db`,
  `e2e-inner`, `restore-smoke`, `security-scan` and `dev` use it.

### Added

- `tests/security/script-spawn.test.ts`: runs a script in a folder with a space through the real
  shell (cmd.exe on Windows), shows the old unquoted form fails, and fails if any script spawns a
  Windows shell without `shellSafe`.

## [0.6.10-WMS] — 2026-11-16

Fix found by the owner running the v0.6.9 `ledger-growth` profile on a Windows workstation. Gate
state stays **`WMS_IN_PROGRESS`** (PASS 20 · FAIL 3 · BLOCKED 10 · NOT_RUN 1). No migration.

### Fixed

- **Reconciliation returned HTTP 500 at 10 M ledger rows** (ADR-0031 addendum): it exceeded the
  API's 15 s statement limit on slower hardware, and the cancelled statement surfaced as
  "Erro interno". Reconciliation now aggregates the ledger first (1.7× faster at 2 M rows; 11.2 → 9.6 s at 10 M), runs with its own
  60 s budget, and allows one run per warehouse at a time (409 `RECONCILIATION_RUNNING`).
- **Any statement timeout now returns 503 `QUERY_TIMEOUT`** with a clear message instead of 500.

### Added

- `DB_STATEMENT_TIMEOUT_MS` (default 15 000) — the pool's per-statement limit, previously
  hard-coded. The restore verifier runs without a limit and uses the aggregate-first query.
- `tests/integration/query-limits.test.ts` (fails on v0.6.9, passes now).

## [0.6.9-WMS] — 2026-11-16

Continuation (Reusable Continuation Prompt v0.6). Gate state stays **`WMS_IN_PROGRESS`**
(PASS 20 · FAIL 3 · BLOCKED 10 · NOT_RUN 1). Extending the load harness to the contended write
path and to a 10 M-row ledger found two real defects (deadlocks; a ledger query that grew with
history); both are fixed and covered by tests. E-04 stays BLOCKED
(targets not agreed; no production-equivalent hardware).

### Fixed

- **Deadlocks in allocation and stock moves** (ADR-0031). Outbound and transfer allocation
  locked candidate positions line by line, and a move locked source before target, so
  concurrent orders with SKUs in opposite order, or opposite moves between two positions,
  deadlocked. The API's retry hid the errors; each cost ~1 s (`deadlock_timeout`), seen as a 2–3 s
  allocation tail. Positions are now always locked in ascending id order in one statement:
  `lockAllocationCandidates` (all candidates of the document's SKUs, before the line loop) and
  `lockMoveSourceAndTarget` (source + existing target together; `CONCURRENT_CHANGE` 409 if the
  source changed in between). Smoke: 10 deadlocks → 0; slowest allocation 2.1 s → 113 ms.
- **Activity (ledger) page and CSV export slowed down linearly with history** (ADR-0031). The
  RLS predicates defeat the planner's row estimates, so it joined the whole ledger before
  keeping the newest 50 rows (4.1 s with 300 000 history rows). Both queries now select the
  ledger page first and join only those rows: 4 146 ms → 2.5 ms on the same data. No migration.

### Added

- `tests/integration/lock-ordering.test.ts`: concurrent opposite-order outbound and transfer
  allocations plus opposite moves; asserts PostgreSQL's `pg_stat_database.deadlocks` is
  unchanged, stock conserved and reconciliation clean. Verified to fail without the fix.
- `reports-search.test.ts`: ledger page ordering and SKU/type/period/limit filters (passes on
  the old and the new query, so the rewrite returns the same rows).
- Load harness: `order_allocate` scenario (create + allocate an order on the 20 hottest SKUs,
  half cancelled) with per-step timings; deadlock count per run (non-zero fails the run);
  `overReserved` invariant; one-off timings (reconciliation, CSV export of the run window,
  over-cap export refused with 409, ledger by SKU).
- `ledger-growth` profile: representative dataset plus 10 000 000 synthetic ledger rows.

## [0.6.8-WMS] — 2026-11-16

Continuation (Reusable Continuation Prompt v0.6). Gate state stays **`WMS_IN_PROGRESS`**
(PASS 20 · FAIL 3 · BLOCKED 10 · NOT_RUN 1). E-04 now has a harness and a measured baseline;
it stays BLOCKED until the owner agrees the targets and the run is repeated on
production-equivalent hardware.

### Added

- **Load/performance harness** (ADR-0030): `pnpm test:load [-- --profile smoke|representative|stress]`
  on a disposable database; dataset seeded through the real opening-stock command; weighted
  operator mix (stock by SKU, SKU search, global search, ledger page, stock move) through the full
  HTTP stack; stock conservation and reconciliation checked after every run; JSON results in
  `artifacts/perf/`, generated reports in `docs/perf/LAST_RUN_*.md`.
- **Provisional targets** in `docs/perf/targets.json` for the owner to confirm.
- Baseline (2 vCPU, generator on the same machine): representative 20 000 SKUs / 100 000
  positions / 25 users — 275 req/s, 0 errors, p95 101–156 ms (all targets met); stress 60 users —
  250 req/s, 0 errors, p95 283–328 ms (degrades, invariants hold).
- CI `verify` job runs `pnpm asvs:check` and the load smoke profile; uploads `artifacts/perf/`.

## [0.6.7-WMS] — 2026-11-13

Continuation (Reusable Continuation Prompt v0.6). Gate state stays **`WMS_IN_PROGRESS`**
(PASS 20 · FAIL 3 · BLOCKED 10 · NOT_RUN 1): S-06 moved from FAIL to BLOCKED — no code-level ASVS
L2 gap is known; DAST and environment items need a staging environment, then independent review.

### Added

- **Control-bypass signals in the audit trail** (ASVS V16.3.3, ADR-0029): every 400/413/415/429
  is recorded as `security.input_rejected` / `security.rate_limited` — first event per source and
  5-minute window plus a summary, bounded memory, no request contents. Monitor rules
  `security.probing` and `security.unauthenticated_probing`; overview counter `controlBypass`.
- **Recorded identity check for account recovery** (V6.4.4): MFA and password resets require a
  verification method and reference (audited); self-recovery refused
  (`409 SELF_RECOVERY_FORBIDDEN`); form in Administração.
- Tests: `recovery-and-signals` (7, incl. the first end-to-end test of the administrator-issued
  password reset), `security-signals` unit (3).

### Changed

- **Breaking (API):** `POST /api/admin/users/{id}/mfa-reset` and `…/password-reset` require a
  body (the bundled UI is updated).
- OpenAPI now documents the request bodies of the reset and alert-acknowledgement endpoints.
- ASVS assessment v0.6.7: I+T 93 · I 67 · P 2 · O 0 · ENV 13 · N/A 78. V6.4.3 had been marked I+T
  without a dedicated test — corrected with the new test; V3.4.6 and V16.5.1 got explicit tests.

## [0.6.6-WMS] — 2026-11-12

Continuation (Reusable Continuation Prompt v0.6). Gate state stays **`WMS_IN_PROGRESS`**
(PASS 20 · FAIL 4 · BLOCKED 9 · NOT_RUN 1). S-06 code-level review done (ADR-0028).

### Added

- **Requirement-level ASVS 5.0.0 L1+L2 self-assessment as code**: canonical 253 ids from the
  official CSV, `assessment.json` with status/evidence/note, `pnpm asvs:render` / `asvs:check`,
  generated `ASVS_L2_ASSESSMENT.md`, test that fails on stale or invalid assessments. Result:
  I+T 91 · I 67 · P 4 · O 0 · ENV 13 · N/A 78.
- **Administrator session controls** (V7.4.5): `POST /api/admin/users/{id}/sessions/revoke` and
  `POST /api/admin/sessions/revoke-all` (admin.security + step-up, audited, caller's session
  kept); buttons _Terminar sessões_ (Administração) and _Terminar todas as sessões_ (Segurança).
- **Top 5000 policy-length common passwords** (V6.2.4) as SHA-256 prefixes, generated by
  `scripts/build-common-passwords.mjs` from SecLists (MIT).
- **Context-word screening** (V6.1.2/V6.2.11): documented list + company code/name + display
  name.
- Docs: crypto inventory and key lifecycle, concurrent-session policy, authentication pathways.
- Tests: `session-controls` (7), `asvs-assessment` (2), password/env/totp unit additions.

### Changed

- Ending another own session or all other sessions now needs step-up (V7.5.2).
- `Sec-Fetch-Site: cross-site` refused on every API request, reads included (V3.5.3).
- Logout sends `Clear-Site-Data: "cache", "storage"` (V14.3.1).
- New recovery codes carry 120 bits (6 × 4 base32, V6.5.2); legacy 80-bit codes stay valid
  until used or regenerated.
- Runbook §1 and OPERATIONS §6 use the new session controls instead of SQL.

## [0.6.5-WMS] — 2026-11-12

Continuation (Reusable Continuation Prompt v0.6). Gate state stays **`WMS_IN_PROGRESS`**
(PASS 20 · FAIL 4 · BLOCKED 9 · NOT_RUN 1); SEC-OPEN-008 tooling done (storage/schedule open).

### Added

- **Signed audit-chain digests** (ADR-0027): `pnpm audit:digest keygen|create|verify`. Ed25519
  signatures over each chain head; `verify` walks each chain once and reports `HASH_MISMATCH`
  (consistent superuser rewrite), `ENTRIES_MISSING` (deleted entries) and `CHAIN_BROKEN`; optional
  `--chain` scope; exit codes 0/1/2. Keys refused inside the repository, private key 0600 and never
  printed, digest files written once and read-only.
- `*.pem` and `audit-digest-*.json` ignored by git, excluded from the archive and rejected by
  `verify:handover`.
- Tests: `audit-digests` (5).

### Changed

- `computeEntryHash()` exported from the audit service (single source of the hash formula).
- The security-monitoring test no longer assumes it is the only file tampering with chains in
  the shared test database (files now pass in shuffled order).

### Fixed (re-issued archive, same version)

- `audit-digests` CLI test failed on Windows (status `null`): it spawned the `node_modules/.bin/tsx`
  shim, which is a `.cmd` file there. It now runs tsx's JS entry with the current Node, surfaces
  spawn errors, and skips the POSIX 0600 check on Windows (no permission bits; use NTFS ACLs).
- Removed a leftover debug `console.log` (`DBG …`) from the security-monitoring test (since v0.6.4).

## [0.6.4-WMS] — 2026-11-12

Continuation (Reusable Continuation Prompt v0.6). Gate state stays **`WMS_IN_PROGRESS`**
(PASS 20 · FAIL 4 · BLOCKED 9 · NOT_RUN 1); S-05 code part done (deployment still open).

### Added

- **Security monitoring** (ADR-0026, migration 0009): rules over the audit log (login/MFA failure
  bursts, unknown-account spraying, access-denied spikes, recovery-code use, MFA resets, PII-read
  and export bursts, key rotation), event alerts (broken audit chain, stuck outbox, failed
  retention/outbox jobs), one open alert per company and rule, incremental audit-chain
  verification with a daily full pass, delivery to the log (`securityAlert: true`) and an
  optional HMAC-signed webhook with bounded retries.
- Admin API `GET /api/admin/security/overview`, `GET /api/admin/security/alerts`,
  `POST /api/admin/security/alerts/{id}/ack` (step-up, audited, one-way) and the **Segurança**
  page.
- Configuration `SECURITY_MONITOR_INTERVAL_SECONDS`, `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_SECRET`
  (unsafe webhook settings refused at start-up).
- Tests: `security-monitoring` (12).

### Changed

- Audit-chain verification reads in pages (`verifyRange`), so memory stays bounded.
- Retention/outbox job failures now raise system alerts in addition to the error log.

## [0.6.3-WMS] — 2026-11-12

Continuation (Reusable Continuation Prompt v0.6). Gate state stays **`WMS_IN_PROGRESS`**
(PASS 20 · FAIL 4 · BLOCKED 9 · NOT_RUN 1); F-07/F-08 open action (T-26) closed; S-06 open
items narrowed (breached-password corpus).

### Added

- **Transfer reservations at the source** (ADR-0025, migration 0008): _Reservar stock_ reserves
  the open quantity of each line (FEFO, expired lots excluded) so outbound allocation cannot
  take it; pick list per reserved position with _Expedir daqui_; dispatch consumes reservations
  first; fully shipped lines and cancel release them; destination close refused while the
  source holds reservations (`409 TRANSFER_RESERVED`). New route
  `POST /api/wms/w/{wh}/transfers/{id}/allocate`; lines expose `qtyReserved`.
- **Near-expiry report** `GET /api/wms/w/{wh}/reports/expiry?days=` and the Relatórios panel
  "Validades a expirar" (expired lots flagged).
- **Offline breached-password corpus** (`BREACHED_PASSWORD_CORPUS`,
  `scripts/prepare-breached-corpus.mjs`): binary search over a fixed-width SHA-1 file built from
  the HIBP download; applied at enrolment, password change and reset completion.
- Tests: `transfer-reservations` (6, incl. a concurrent-allocation race and conservation across
  warehouses), corpus unit test.

### Changed

- Outbound and transfer allocation share one candidate query (`allocationCandidates()` in the
  inventory engine).

## [0.6.2-WMS] — 2026-11-10

Continuation (Reusable Continuation Prompt v0.6). Gate state stays **`WMS_IN_PROGRESS`**
(PASS 20 · FAIL 4 · BLOCKED 9 · NOT_RUN 1); F-07 open action narrowed, O-02 progressed.

### Added

- **Lots with expiry and FEFO allocation** (ADR-0024, migration 0007): company-wide lot master
  (`sku_lots`), expiry captured on receipt/opening/return/found stock, allocation by earliest
  expiry → lot code → fullest position, **expired lots never allocated** (flagged "Expirado" in
  Stock), optional requested lot per outbound line, lot shown on the pick list.
- **Serial-number uniqueness** enforced by a database trigger for every writer (1 unit per
  serial, one on-hand position per company, advisory lock against concurrent receipts) plus an
  in-transit check; errors `SERIAL_QTY` / `SERIAL_DUPLICATE`.
- Receipt screen: lot/serial and expiry fields; outbound creation: optional requested lot.
- CI: `node-next` job (Node 26: typecheck, unit tests, build) and `release-candidate` job on
  `main` (release ZIP + `verify:handover` + SLSA build-provenance attestation, 90-day
  retention); branch-protection instructions in `docs/security/CI-CD-SECURITY.md`.
- Tests: `lots-serials` (7, incl. a concurrency race).

### Changed

- LOT/SERIAL-tracked SKUs now require a lot on opening stock, returns and found stock too (was
  only enforced on inbound receipts).

## [0.6.1-WMS] — 2026-11-10

Continuation (Reusable Continuation Prompt v0.6). Gate state stays **`WMS_IN_PROGRESS`**
(PASS 20 · FAIL 4 · BLOCKED 9 · NOT_RUN 1).

### Added

- **Pesquisa** screen and `GET …/search`: documents by number or external reference (transfers
  from either side), SKUs by code/description/barcode, locations, containers (ADR-0023).
- **Activity CSV export** for a period (`GET …/reports/ledger.csv`, step-up + audit, ≤ 366 days,
  refused above 100 000 rows) with the document number on each line; export form in Histórico.
- Replenishment screen asks for the destination label scan (F-05 complete in the UI).
- `pnpm security:scan` runs **gitleaks 8.24.3 with the CI rules** over the authored files when
  the binary is available (`GITLEAKS_BIN`/PATH); otherwise reports `WARN … NOT RUN`.
- `docs/runbooks/RUNBOOKS.md` (incident response, lost device, break-glass, audit-chain failure,
  reconciliation mismatch, stuck documents, jobs, maintenance) and
  `docs/MANUAL_OPERADOR_E_ADMIN.md` (pt-PT operator and administrator manual).
- README-LOCAL-TESTING: running without Docker on a native PostgreSQL (Windows and macOS/Linux).
- Tests: `reports-search` (5), MFA-reset-revokes-passkeys, e2e search step.

### Fixed

- **Security:** an administrator's MFA reset now also revokes the user's passkeys (previously a
  lost/stolen passkey stayed valid after the reset).
- CI gitleaks false positive in `tests/integration/reliability.test.ts` (variable renamed).
- CSV export: plain negative quantities are no longer prefixed with `'` (they stayed text in
  spreadsheets); formula-like cells are still neutralised.
- Step-up message mentions passkeys; `invitations-dev.txt` is git-ignored and can never be
  packaged.

## [0.6.0-WMS] — 2026-11-10

Continuation of v0.5.0 (no restart). Priority rule from the product owner: complete the
autonomous WMS before any other ERP module. Review: `docs/reviews/REVIEW-2026-11-10-v0.5.md`;
evidence register: `docs/WMS_RELEASE_GATE.md`.

### Added

- **Passkeys (WebAuthn)** as second factor and for step-up (`@simplewebauthn/server` 14.1.0,
  `@simplewebauthn/browser` 14.0.0); `ADMIN_PASSKEY_REQUIRED` policy (mandatory in production);
  login button "Usar chave de acesso"; step-up dialog offers the passkey (ADR-0019).
- **A minha conta**: passkeys (register/list/remove), password change (revokes other sessions),
  own sessions (list, end one, end all others), recovery-code regeneration.
- WMS: quality status change (`/stock/status`: block, audited release with step-up); barcode
  units of measure applied on receive/pick/pack; lots carried through transfers
  (`transfer_line_lots`, per-lot receipt and loss); un-pick and un-pack; cancel after un-picking;
  empty packages closed with their order; node rename/deactivate/reactivate; container close;
  source-side cancel of draft transfers; UI for all of these.
- Data-retention purge (`app_retention_purge`, every 6 h, bounded windows, audited; ADR-0020).
- Lint-enforced module boundaries (`no-restricted-imports`) with a test proving they fire.
- Tests: `passkeys-account` (17), `wms-completion` (16), `reliability` (5), `route-inventory`
  (5, all 108 API operations), `retention` (2), `module-boundaries` (4), `release-gate` (3); e2e
  passkey flow with a Chrome DevTools virtual authenticator; axe sweep over every screen. Totals:
  unit 37, integration 34, security 73, e2e 2.
- Migrations 0004 (passkeys/account), 0005 (WMS completion), 0006 (retention).
- **WMS release gate as code** (product owner's Readiness Gate v0.6): `docs/WMS_RELEASE_STATUS.json`
  (source of truth), generated `docs/WMS_RELEASE_GATE.md`, `docs/WMS_RELEASE_EVIDENCE.md`,
  `pnpm gate:check` / `gate:render` (fail-closed state machine, in `test:all` and CI; ADR-0021).
- **Scan-verified destinations** for putaway, stock moves, container moves and replenishment
  (`scan` field, `SCAN_MISMATCH`; required in the UI; ADR-0022).
- Reliability tests: failure injection mid-command (full rollback, same-key retry, replay),
  migration upgrade rehearsal from the v0.5.0 schema, FULL count with recount.
- `pnpm restore:smoke` upgrades a backup taken by an older build forward before verifying it.

### Changed

- `AuthGuard` now refuses `/api/admin/**` for non-admins and cross-warehouse `:wh` routes for staff
  **before** request bodies are parsed (previously a 400 validation error could precede the 403/404).
- Transaction reversal now requires step-up, like the equivalent adjustment.
- Session refresh no longer unmounts the current screen (kept success messages/new codes visible).
- Native checkboxes are 24×24 px (WCAG 2.5.8); wide tables and the location tree are keyboard
  scrollable (WCAG 2.1.1).

### Known gaps

Gate state **`WMS_IN_PROGRESS`** (PASS 18 · FAIL 6 · BLOCKED 9 · NOT_RUN 1). Code-level FAILs:
activity export/search (F-12), runbooks/operator manual (E-05), external KMS (S-03), monitoring
(S-05), ASVS open items (S-06), signed artifacts/gated deployment (O-02). Also open: FEFO/serials,
transfer reservations, load tests (targets to be agreed), manual screen-reader pass. **Not
production-ready.**

## [0.5.0-WMS] — 2026-11-09

First implementation (greenfield; no prior code in the workspace).

### Added

- Monorepo (pnpm 12.18.0): `apps/api` (NestJS 12 + Fastify 5), `apps/web` (React 19 + Vite 8 +
  Tailwind 4, pt-PT), `packages/contracts` (Zod 4 DTOs + permission catalogue).
- PostgreSQL schema (3 migrations): tenants, identity, sessions, MFA, key registry, hash-chained
  audit log, idempotency log, outbox; full WMS model with composite tenant FKs, triggers and RLS.
- Authentication: Argon2id, mandatory TOTP MFA with replay protection, recovery codes,
  invitation/MFA-reset/password-reset one-time tokens, opaque sessions with rotation and
  timeouts, HMAC CSRF tokens, throttling with backoff, step-up for high-risk actions.
- Authorization: default-deny permission catalogue, object-level warehouse scope, admin-only
  permissions, field masking, audited denials.
- Encryption: AES-256-GCM field encryption with per-tenant envelope DEKs, KEK provider
  abstraction (local-dev provider refused in production), DEK rotation and KEK rewrap.
- WMS: topology (nodes with validated nesting, movable containers), SKU master + barcodes + CSV
  import, opening stock, moves, audited adjustments, reversals, inbound (expected/unplanned,
  partial, shortage/excess, damaged), putaway with suggestions, outbound (allocation, scanner
  picking, short picks, packing, partial dispatch, backorders, internal dispatch note),
  inter-warehouse transfers, returns with disposition, counts (blind, recount, segregated
  approval), replenishment + purchase suggestions, reports, CSV export, labels.
- Tests: 35 unit/property, 13 integration (12 acceptance + DB property test), 42 security,
  1 browser e2e with axe — all on real PostgreSQL.
- Tooling: `security:scan` (secrets, SAST-lite, raw-SQL gate, audit, SBOM, licenses),
  `backup:local`, `restore:smoke`, `verify:handover`, `release:zip`, documentation gate,
  generated OpenAPI with drift check, SHA-pinned CI workflow, infra templates.
- Documentation set (architecture, database, state machines, API, security, operations, ADRs).

### Known gaps

See `docs/security/SECURITY_OPEN_ITEMS.md` and `docs/NEXT_TASKS.md` (WebAuthn, KMS, deployment
controls, CI execution, pentest).
