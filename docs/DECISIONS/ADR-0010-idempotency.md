# ADR-0010 — Idempotency keys for every WMS command

Status: Accepted. Owning module: WMS.

**Decision.** Mandatory `Idempotency-Key`; `command_log` row inserted first in the same
transaction (PK conflict serialises duplicates); fingerprint = SHA-256(command, warehouse,
canonical payload); replay returns the stored response; mismatched reuse ⇒ 409.
**Consequence.** Safe client retries; storage grows (add retention job: T-12).
