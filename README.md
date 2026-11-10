# AutoLemon ERP — v0.6.0 (WMS)

Secure TypeScript ERP foundation with a **fully autonomous Warehouse Management System** for
automotive-parts shops and distributors in Portugal (UI in pt-PT). Modular monolith: NestJS 12 +
Fastify API, React 19 SPA, PostgreSQL.

> **Status: development build — NOT production-ready.** WMS release gate state:
> **`WMS_IN_PROGRESS`** — tracked criterion by criterion in `docs/WMS_RELEASE_GATE.md` (generated
> from `docs/WMS_RELEASE_STATUS.json`; `pnpm gate:check`). Production
> release stays blocked until a real KMS, WAF/ZTNA/TLS/private networking, off-site immutable
> backups, load tests and an independent security review/penetration test are done. See
> `docs/PROJECT_STATE.md` and `docs/security/SECURITY_OPEN_ITEMS.md`.

## What works (implemented and tested on real PostgreSQL)

- **Platform:** companies/warehouses (tenant provisioning), users with default-deny permissions,
  Argon2id passwords, mandatory MFA (passkeys/WebAuthn or TOTP) + recovery codes, optional
  "administrators must use a passkey" policy (mandatory in production), self-service account
  security (password change, own sessions, passkeys, recovery codes), opaque sessions with CSRF
  protection, step-up for sensitive actions, bounded data-retention purge, AES-256-GCM field encryption with per-tenant keys and
  rotation, hash-chained security audit log, idempotent commands, transactional outbox,
  WMS-only module registry.
- **WMS:** warehouse topology (zones → aisles → racks → shelves → bins, direct locations,
  staging/inspection/quarantine/dispatch) and movable boxes; unlimited stock positions per SKU;
  append-only ledger; reservations; receiving (expected/unplanned, partial, shortages, damage);
  putaway with suggestions; outbound allocation, barcode-verified picking, packing, partial
  dispatch, backorders, un-pick/un-pack and cancellation after picking; barcode units of
  measure (a case scan = N units); quality status changes (quarantine/damaged ↔ available,
  audited, step-up to release); inter-warehouse transfers with in-transit tracking per lot and
  source-side cancellation; returns with disposition; blind counts with segregated approval;
  replenishment; node rename/deactivation and container close; audited corrections; reports,
  CSV export, printable labels.
- **Security boundaries:** staff see only their warehouse; admins switch among own-company
  warehouses; enforced in services, database FKs and RLS; all denials audited.

## Quick start

Release archive: `AutoLemon-ERP-v0.6.0-WMS.zip` (root folder `autolemon-erp/`, SHA-256 in
`AutoLemon-ERP-v0.6.0-WMS.zip.sha256`).

Prerequisites: Node.js ≥ 22.12 (Node 26 LTS recommended; verified on 22.23.4), pnpm **12.18.0**,
Docker (Engine/Desktop) for PostgreSQL 18. Full commands for macOS/Linux and Windows PowerShell:
**[README-LOCAL-TESTING.md](README-LOCAL-TESTING.md)**.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d
pnpm db:migrate && pnpm db:seed     # prints one-time invitation links (dev only)
pnpm dev                            # http://localhost:5173
```

## Architecture

```
apps/api            NestJS API (platform + wms), SQL migrations, CLIs
apps/web            React SPA (pt-PT)
packages/contracts  Shared Zod contracts and permission catalogue
tests/              integration, security, e2e (real Postgres)
scripts/            dev, test DB, security scan, backup/restore, handover, release
infra/              production reference templates (NOT DEPLOYED)
docs/               architecture, database, API, security, operations, ADRs
```

Start with `docs/ARCHITECTURE.md`, then `docs/WMS_STATE_MACHINES.md`, `docs/DATABASE.md` and
`docs/security/THREAT_MODEL.md`. Continuation: `docs/HANDOVER.md` and `docs/NEXT_TASKS.md`.

## Commands

| Command                                                                           | Purpose                                                             |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm dev`                                                                        | API (watch) + web dev server                                        |
| `pnpm build`                                                                      | production build of contracts, API and web                          |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check`                              | static checks (lint includes the documentation gate)                |
| `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset:dev`                          | database (reset refuses non-dev DBs)                                |
| `pnpm test:unit` / `test:integration` / `test:security` / `test:e2e` / `test:all` | tests (DB tests use a disposable database)                          |
| `pnpm api:check`                                                                  | OpenAPI spec matches code                                           |
| `pnpm gate:check` / `pnpm gate:render`                                            | WMS release-gate state machine check / regenerate the gate Markdown |
| `pnpm security:scan`                                                              | local security scanners + SBOM                                      |
| `pnpm backup:local` / `pnpm restore:smoke`                                        | encrypted local backup / disposable restore verification            |
| `pnpm verify:handover` / `pnpm release:zip`                                       | handover checks / build the release archive                         |

## Not in scope of v0.6

Sales, purchasing, accounting/invoicing, SAF-T, TecDoc, CRM, supplier integrations, legally
compliant Portuguese transport documents (the internal dispatch note says so explicitly).

License: proprietary (UNLICENSED). Synthetic data only.
