# ADR-0006 — Tenant/warehouse isolation: service checks + composite FKs + RLS

Status: Accepted. Owning module: platform/authz.

**Decision.** (1) Primary: service-layer permission + object-level warehouse scope on every call.
(2) Physical integrity: composite FKs (id, company_id[, warehouse_id]). (3) Defence in depth:
RLS with transaction-local `set_config(..., true)`, app connects as non-owner role without
BYPASSRLS. Out-of-scope objects return 404 and are audited.
**Alternatives.** Schema-per-tenant / DB-per-tenant (stronger isolation, much higher ops cost;
can be revisited for large tenants).
**Risks.** RLS does not protect against a compromised app process or superusers — documented.
