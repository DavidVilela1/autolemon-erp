-- =============================================================================
-- Migration 0005_wms_completion — operations needed to run a warehouse without manual
-- database intervention (review REVIEW-2026-11-10-v0.5, findings R-01, R-03, R-04, R-05).
-- Owning module: WMS. Reviewed: v0.6.0.
--
--   * New inventory transaction types:
--       STATUS_CHANGE  quality release/block (QUARANTINE/DAMAGED/INSPECTION ↔ AVAILABLE)
--       UNPICK         picked-but-unpacked units returned from packing to storage
--       UNPACK         packed-but-undispatched units taken back out of a package
--   * transfer_line_lots: lots travel with transfers (in-transit quantity per lot), so a
--     lot-tracked SKU keeps its lot from source shelf to destination shelf.
--   * outbound_package_lines.qty_unpacked: unpacking never edits or deletes packing history.
-- =============================================================================

ALTER TABLE inventory_transactions DROP CONSTRAINT inventory_transactions_txn_type_check;
ALTER TABLE inventory_transactions ADD CONSTRAINT inventory_transactions_txn_type_check CHECK (txn_type IN (
  'OPENING','RECEIPT','PUTAWAY','MOVE','CONTAINER_MOVE','PICK','PACK','DISPATCH',
  'TRANSFER_OUT','TRANSFER_IN','RETURN_RECEIPT','RETURN_DISPOSITION',
  'COUNT_ADJUST','ADJUST','REPLENISH','REVERSAL',
  'STATUS_CHANGE','UNPICK','UNPACK'));

-- ----------------------------------------------------------------- lots in transit
ALTER TABLE transfer_lines ADD CONSTRAINT transfer_lines_id_company_key UNIQUE (id, company_id);

CREATE TABLE transfer_line_lots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL,
  transfer_line_id  uuid NOT NULL,
  lot_code          text NOT NULL CHECK (length(lot_code) <= 40),
  qty_shipped       numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_shipped >= 0),
  qty_received      numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  qty_lost          numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_lost >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (qty_received + qty_lost <= qty_shipped),
  UNIQUE (transfer_line_id, lot_code),
  FOREIGN KEY (transfer_line_id, company_id) REFERENCES transfer_lines (id, company_id)
);
CREATE INDEX transfer_line_lots_line_idx ON transfer_line_lots (transfer_line_id);

-- Existing shipments (before lots were tracked) become one unlotted bucket per line.
INSERT INTO transfer_line_lots (company_id, transfer_line_id, lot_code, qty_shipped, qty_received, qty_lost)
SELECT company_id, id, '', qty_shipped, qty_received, qty_lost FROM transfer_lines WHERE qty_shipped > 0;

GRANT SELECT, INSERT, UPDATE ON transfer_line_lots TO autolemon_app;
ALTER TABLE transfer_line_lots ENABLE ROW LEVEL SECURITY;
-- Visible exactly when the parent line (hence the transfer, either side) is visible.
CREATE POLICY transfer_line_lot_sides ON transfer_line_lots
  USING (company_id = app_company() AND EXISTS (SELECT 1 FROM transfer_lines l WHERE l.id = transfer_line_id))
  WITH CHECK (company_id = app_company() AND EXISTS (SELECT 1 FROM transfer_lines l WHERE l.id = transfer_line_id));

-- ----------------------------------------------------------------- unpacking
ALTER TABLE outbound_package_lines
  ADD COLUMN qty_unpacked numeric(18,3) NOT NULL DEFAULT 0,
  ADD CONSTRAINT outbound_package_lines_unpacked_check CHECK (qty_unpacked >= 0 AND qty_unpacked <= qty);
