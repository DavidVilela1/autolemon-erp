# Changelog

All notable changes. Owning module: repository. Format: Keep a Changelog; versioning: SemVer.

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
