# ADR-0009 — Counting: snapshot + optimistic version check, no freeze

Status: Accepted. Owning module: WMS.

**Decision.** Count lines snapshot qty + position version; any movement bumps the version;
submit/approve mark changed lines STALE and approval refuses them until recounted. Blind counts
for counters; approver ≠ counter; step-up MFA; adjustments as COUNT_ADJUST deltas.
**Alternatives.** Location freeze (blocks operations in busy shops).
**Consequence.** Busy locations may need recounts; operations never stop.
