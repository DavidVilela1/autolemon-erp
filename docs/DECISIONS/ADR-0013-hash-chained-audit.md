# ADR-0013 — Hash-chained security audit log

Status: Accepted. Owning module: platform/audit.

**Decision.** Per-tenant chains, SHA-256(prev ‖ canonical JSON), advisory lock for ordering,
append-only trigger + grants, verify endpoint; denials recorded in a separate transaction.
**Limitation.** Superusers can rewrite consistently ⇒ off-site signed checkpoints required.
