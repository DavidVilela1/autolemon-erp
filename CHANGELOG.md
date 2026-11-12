# Changelog

All notable changes. Owning module: repository. Format: Keep a Changelog; versioning: SemVer.

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
