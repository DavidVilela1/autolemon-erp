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
- Keep docs current: PROJECT_STATE, NEXT_TASKS, CHANGELOG, ADRs, SECURITY_OPEN_ITEMS at each
  milestone; regenerate OpenAPI (`pnpm --filter @autolemon/api openapi`).

## 3. Documentation standard (enforced partly by `pnpm lint`)

Every source file starts with `@file` + owning module; every exported symbol has TSDoc; complex
algorithms, state transitions, crypto, authorization branches, inventory corrections and
migrations carry "what and why" comments. The automated gate checks headers and exported-symbol
TSDoc presence (last run: 101 files, 303 exported symbols); comment quality needs human review.

## 4. Where to start next

`docs/NEXT_TASKS.md` T-01 (WebAuthn) and T-02 (run CI on Node 26 + PostgreSQL 18).

## 5. Release procedure

```bash
pnpm test:all && pnpm security:scan && pnpm restore:smoke
pnpm release:zip            # artifacts/AutoLemon-ERP-v<version>-WMS.zip + .sha256 + manifest
pnpm verify:handover        # checks docs, placeholders, secrets, archive integrity/exclusions
```

Then extract the ZIP into an empty directory and repeat the README-LOCAL-TESTING flow (clean room)
and record the results in `docs/PROJECT_STATE.md`. Bump versions in all `package.json` files and
the archive name together.
