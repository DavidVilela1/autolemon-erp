# ADR-0008 — Inventory model: positions + append-only ledger

Status: Accepted. Owning module: WMS.

**Decision.** Balances in `stock_positions` keyed by (warehouse, sku, holder, status, lot) with a
generated `holder_id`; every change via `applyDelta()` which also appends `inventory_ledger`.
numeric(18,3) quantities, negative on-hand forbidden (CHECK), reservations per position.
Containers are holders, so moving a box never touches positions.
**Alternatives.** Ledger-only with on-the-fly sums (slow for availability); one row per
(sku, warehouse) (violates the core rule).
**Consequences.** Fast indexed availability; reconciliation proves ledger = balances.
Zero-quantity positions are kept (history anchor) and filtered in queries.
