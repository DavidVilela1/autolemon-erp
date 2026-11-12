# Handover — how to continue AutoLemon ERP

Owning module: repository. A continuation developer should be able to start from the ZIP and
`docs/PROJECT_STATE.md` alone.

## 1. First hour

1. Follow `README-LOCAL-TESTING.md` until `pnpm test:all` is green on your machine.
2. Read, in order: `docs/ARCHITECTURE.md` → `docs/WMS_STATE_MACHINES.md` → `docs/DATABASE.md` →
   `docs/security/THREAT_MODEL.md` → `docs/security/AUTH_AND_RBAC.md` → ADRs.
3. Open `apps/api/src/wms/inventory/engine.ts` and `apps/api/src/wms/runner.ts`: every stock
   change and every WMS command goes through these two files.

## 2. Rules you must keep

- Never write stock tables outside the engine; never update/delete ledger or audit rows.
- Every WMS service method goes through `WmsRunner.read/command` (permission → warehouse scope →
  RLS tx → idempotency). New platform methods call `requirePermission` first.
- New SQL: `sql` template only; `sql.raw` requires adding the file to the allowlist in
  `scripts/security-scan.mjs` with a reason, and a review.
- Migrations are forward-only and never edited after merge (checksum guard).
- Strict Zod DTOs for every input; quantities as decimal strings.
- No secrets in code, comments, logs, URLs, browser storage; dev secrets are generated into `.env`.
- Keep docs current: PROJECT_STATE, NEXT_TASKS, CHANGELOG, ADRs, SECURITY_OPEN_ITEMS and
  `WMS_RELEASE_GATE.md` at each milestone; regenerate OpenAPI
  (`pnpm --filter @autolemon/api openapi`) — the route-inventory security test reads it, so a new
  route is automatically checked for authentication, CSRF and warehouse/admin scope.
- Operator/admin manual: `docs/MANUAL_OPERADOR_E_ADMIN.md`; incident and maintenance runbooks:
  `docs/runbooks/RUNBOOKS.md` — keep both in sync with UI labels when screens change.
- Any new receipt-like stock path must call `registerLot()` (lot required for tracked SKUs,
  expiry master, serial in-transit check); the serial trigger then guards every writer (ADR-0024).
- New account-security routes that must stay reachable for an admin without a passkey need
  `@AccountSecurity()`; everything else is blocked for them under `ADMIN_PASSKEY_REQUIRED`.
- **Product-owner rule:** no Sales/Purchasing/CRM/Accounting/other ERP module until the WMS is
  production-ready, independently verified and approved. The gate lives in
  `docs/WMS_RELEASE_STATUS.json`; after changing it run `pnpm gate:render`. `pnpm gate:check`
  refuses any state the evidence does not support (ADR-0021). Governing instructions: the
  product owner's _Reusable Continuation Prompt v0.6_ and _WMS Production Readiness Gate v0.6_.

## 3. Documentation standard (enforced partly by `pnpm lint`)

Every source file starts with `@file` + owning module; every exported symbol has TSDoc; complex
algorithms, state transitions, crypto, authorization branches, inventory corrections and
migrations carry "what and why" comments. The automated gate checks headers and exported-symbol
TSDoc presence (last run: see `docs/PROJECT_STATE.md` §4); comment quality needs human review.

## 4. Where to start next

`docs/WMS_RELEASE_GATE.md` — every criterion that is not PASS — in the order of
`docs/NEXT_TASKS.md` "Next three WMS tasks", then the
infrastructure block (T-03, T-05…T-07, T-13), which needs the product owner's authorisation.

## 5. Release procedure

```bash
pnpm test:all && pnpm security:scan && pnpm restore:smoke
pnpm release:zip            # artifacts/AutoLemon-ERP-v<version>-WMS.zip + .sha256 + manifest
pnpm verify:handover        # checks docs, placeholders, secrets, archive integrity/exclusions
```

Then extract the ZIP into an empty directory and repeat the README-LOCAL-TESTING flow (clean room)
and record the results in `docs/PROJECT_STATE.md`. Bump versions in all `package.json` files and
the archive name together.
