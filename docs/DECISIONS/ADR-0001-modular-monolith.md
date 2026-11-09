# ADR-0001 — Modular monolith (not microservices)

Status: Accepted (2026-11-09). Owning module: architecture.

**Context.** Small/medium Portuguese auto-parts businesses; one team; strong transactional
consistency needed between stock, reservations and documents.
**Decision.** One NestJS API process + one PostgreSQL database; bounded contexts enforced by
directory structure, table ownership and service APIs; background work via a Postgres outbox.
**Alternatives.** Microservices + Kafka (rejected: distributed transactions for every stock move,
ops burden); serverless functions (rejected: connection/locking semantics).
**Consequences.** Simple deploys and ACID inventory; module boundaries rely on review and future
lint rules (T-08). Horizontal scaling = more API replicas on one DB.
**Maintenance.** Revisit only if a context needs independent scaling with clear evidence.
