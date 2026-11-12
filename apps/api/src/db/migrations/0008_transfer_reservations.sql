-- =============================================================================
-- Migration 0008_transfer_reservations — reservations at the source warehouse for planned
-- transfers (task T-26; ADR-0025). Owning module: WMS. Reviewed: v0.6.3.
--
-- A reservation now belongs to EXACTLY ONE demand: an outbound line (as before) or a transfer
-- line. Reservations stay in the source warehouse (warehouse_id = the position's warehouse),
-- so the existing warehouse-scoped RLS policy and the reconciliation invariant
-- qty_reserved(position) = Σ ACTIVE reservations hold unchanged for both kinds.
-- =============================================================================

ALTER TABLE reservations ALTER COLUMN outbound_line_id DROP NOT NULL;
ALTER TABLE reservations ADD COLUMN transfer_line_id uuid;
ALTER TABLE reservations ADD CONSTRAINT reservations_transfer_line_fk
  FOREIGN KEY (transfer_line_id, company_id) REFERENCES transfer_lines (id, company_id);
ALTER TABLE reservations ADD CONSTRAINT reservations_one_demand
  CHECK (num_nonnulls(outbound_line_id, transfer_line_id) = 1);
CREATE INDEX reservations_transfer_line ON reservations (transfer_line_id) WHERE status = 'ACTIVE';

-- Reserved quantity per transfer line, visible to BOTH sides (reservations themselves are only
-- visible in the source warehouse under RLS). Lets the destination see that stock is held and
-- refuse to close a planned transfer that the source still has reserved.
ALTER TABLE transfer_lines ADD COLUMN qty_reserved numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0);
