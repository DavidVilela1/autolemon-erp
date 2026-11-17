-- =============================================================================
-- Migration 0011_order_lookup_indexes — indexes for "the active reservations / packages of this
-- order" (ADR-0032). Owning module: wms. Reviewed: v0.6.13.
--
-- The v0.6.13 picking load test showed the order view (GET /outbound/{id}) at p50 172 ms /
-- p95 550 ms under load: with no index on reservations.outbound_line_id, and RLS predicates
-- that defeat the planner's row estimates, PostgreSQL started from every active reservation
-- and joined it with every SKU of the company before filtering on the order. Both tables keep
-- their whole history, so the cost would keep growing. The queries now start from the order's
-- lines (outbound.service.ts) and these indexes make that path O(lines of the order).
-- Plain CREATE INDEX (the migrator runs each file in a transaction): it blocks writes to the
-- two tables while it builds — seconds for millions of rows (OPERATIONS.md, "Migrations that
-- take locks").
-- Rollback: DROP INDEX reservations_outbound_line; DROP INDEX containers_outbound;
-- =============================================================================

CREATE INDEX reservations_outbound_line ON reservations (outbound_line_id) WHERE status = 'ACTIVE';
CREATE INDEX containers_outbound ON containers (outbound_id) WHERE outbound_id IS NOT NULL;
