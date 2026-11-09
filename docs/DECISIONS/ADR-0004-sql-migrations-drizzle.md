# ADR-0004 — Hand-written SQL migrations; Drizzle as parameterised query layer

Status: Accepted. Owning module: platform/db.

**Context.** Security-critical schema features: composite tenant FKs, generated columns,
triggers (append-only, nesting, identity freeze), RLS policies, grants.
**Decision.** Forward-only SQL files with a checksum-verifying runner (advisory lock, one tx per
file). Drizzle ORM 0.45 (node-postgres driver) executes queries via the `sql` tagged template
(bound parameters). drizzle-kit is not used.
**Alternatives.** drizzle-kit generated migrations (cannot express all features cleanly; risk of
silently dropped policies), Prisma (heavier, less control of locking SQL).
**Consequences.** Every DDL change is explicit and reviewable; developers must write SQL.
Drizzle returns timestamps as strings from raw execute → `asDate()` helper.
**Maintenance.** Raw SQL identifier interpolation only via the allowlist enforced by security:scan.
