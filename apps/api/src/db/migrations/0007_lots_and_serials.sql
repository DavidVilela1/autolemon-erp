-- =============================================================================
-- Migration 0007_lots_and_serials — lot master with expiry (FEFO) and serial-number
-- uniqueness (gate F-07 open action, task T-20). Owning module: WMS. Reviewed: v0.6.2.
--
--   * sku_lots: one row per (company, SKU, lot/serial code) with an optional expiry date.
--     Lot attributes are company-wide so a lot keeps its expiry across warehouses and
--     transfers. The runtime role may only fill in a missing expiry (column-level UPDATE on
--     expires_on; the application only updates rows WHERE expires_on IS NULL); a receipt that
--     states a different expiry for a lot that has one is refused (LOT_EXPIRY_MISMATCH).
--   * outbound_lines.lot_code: optional requested lot for a line (allocation honours it).
--   * Serial-number invariant enforced in the database (defence in depth, all writers):
--     for a SKU tracked by SERIAL, a position holds at most 1 unit, and a serial may be on
--     hand in only ONE position of the company at a time.
-- =============================================================================

CREATE TABLE sku_lots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  sku_id      uuid NOT NULL,
  lot_code    text NOT NULL CHECK (length(lot_code) BETWEEN 1 AND 40),
  expires_on  date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, sku_id, lot_code),
  FOREIGN KEY (sku_id, company_id) REFERENCES skus (id, company_id)
);

-- Existing lots (positions and transfers) become master rows without expiry.
INSERT INTO sku_lots (company_id, sku_id, lot_code)
SELECT DISTINCT company_id, sku_id, lot_code FROM stock_positions WHERE lot_code <> ''
ON CONFLICT DO NOTHING;
INSERT INTO sku_lots (company_id, sku_id, lot_code)
SELECT DISTINCT x.company_id, l.sku_id, x.lot_code
FROM transfer_line_lots x JOIN transfer_lines l ON l.id = x.transfer_line_id
WHERE x.lot_code <> ''
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT ON sku_lots TO autolemon_app;
GRANT UPDATE (expires_on) ON sku_lots TO autolemon_app;
ALTER TABLE sku_lots ENABLE ROW LEVEL SECURITY;
CREATE POLICY sku_lots_company ON sku_lots
  USING (company_id = app_company()) WITH CHECK (company_id = app_company());

ALTER TABLE outbound_lines ADD COLUMN lot_code text CHECK (lot_code IS NULL OR length(lot_code) BETWEEN 1 AND 40);

-- Serial uniqueness. SECURITY DEFINER so the check sees every warehouse of the company (the
-- caller's RLS scope may be a single warehouse); it only reads, and only rows of NEW's company.
-- The advisory lock serialises concurrent receipts of the same serial (two warehouses at once).
CREATE FUNCTION wms_serial_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.qty_on_hand <= 0 OR NEW.lot_code = '' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM skus s WHERE s.id = NEW.sku_id AND s.tracking = 'SERIAL') THEN
    RETURN NEW;
  END IF;
  IF NEW.qty_on_hand > 1 THEN
    RAISE EXCEPTION 'serial-tracked position above 1 unit' USING ERRCODE = '23514', CONSTRAINT = 'serial_single_unit';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.company_id::text || ':' || NEW.sku_id::text || ':' || NEW.lot_code, 7));
  IF EXISTS (
    SELECT 1 FROM stock_positions p
    WHERE p.company_id = NEW.company_id AND p.sku_id = NEW.sku_id AND p.lot_code = NEW.lot_code
      AND p.qty_on_hand > 0 AND p.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'serial already on hand' USING ERRCODE = '23514', CONSTRAINT = 'serial_unique';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION wms_serial_guard() FROM PUBLIC;
CREATE TRIGGER stock_positions_serial_guard
  BEFORE INSERT OR UPDATE OF qty_on_hand, lot_code ON stock_positions
  FOR EACH ROW EXECUTE FUNCTION wms_serial_guard();
