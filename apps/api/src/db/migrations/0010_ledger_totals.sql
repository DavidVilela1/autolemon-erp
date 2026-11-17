-- =============================================================================
-- Migration 0010_ledger_totals — per-position running ledger totals so routine
-- reconciliation no longer scans the whole ledger (ADR-0032). Owning module: wms.
-- Reviewed: v0.6.13.
--
-- position_ledger_totals holds, for every stock position, the sum of its ledger deltas. It is
-- maintained ONLY by the AFTER INSERT trigger on inventory_ledger (SECURITY DEFINER, owned by
-- the schema owner); the runtime role can read it (RLS) but never write it. Because the ledger
-- is append-only (UPDATE/DELETE are refused by inventory_ledger_append_only), the total is
-- exact and changes in the same transaction as the ledger row, so it never lags.
-- Every ledger insert happens while the inserting transaction holds the position's row lock
-- (engine applyDelta/relocate/ensurePosition), so the totals row is always written behind that
-- lock and adds no new lock-ordering risk.
-- Routine reconciliation compares stock_positions.qty_on_hand with these totals (O(positions));
-- the full ledger scan stays available as a deep check (?full=true, restore verifier).
-- Rollback: DROP TRIGGER inventory_ledger_totals ON inventory_ledger;
--           DROP FUNCTION inventory_ledger_totals(); DROP TABLE position_ledger_totals;
--           (the v0.6.12 code does not read the table).
-- =============================================================================

CREATE TABLE position_ledger_totals (
  position_id   uuid PRIMARY KEY,
  company_id    uuid NOT NULL,
  warehouse_id  uuid NOT NULL,
  total         numeric(18,3) NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (position_id, company_id, warehouse_id) REFERENCES stock_positions (id, company_id, warehouse_id)
);
CREATE INDEX position_ledger_totals_warehouse ON position_ledger_totals (warehouse_id);

ALTER TABLE position_ledger_totals ENABLE ROW LEVEL SECURITY;
CREATE POLICY warehouse_isolation ON position_ledger_totals
  USING (company_id = app_company() AND app_wh_visible(warehouse_id));
GRANT SELECT ON position_ledger_totals TO autolemon_app;

CREATE FUNCTION inventory_ledger_totals() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO position_ledger_totals (position_id, company_id, warehouse_id, total, updated_at)
  VALUES (NEW.position_id, NEW.company_id, NEW.warehouse_id, NEW.qty_delta, now())
  ON CONFLICT (position_id) DO UPDATE
    SET total = position_ledger_totals.total + EXCLUDED.total, updated_at = EXCLUDED.updated_at;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION inventory_ledger_totals() FROM PUBLIC;

-- Block ledger writers while the trigger is installed and the totals are back-filled, so no
-- row can be inserted between the back-fill snapshot and the trigger taking over.
LOCK TABLE inventory_ledger IN SHARE ROW EXCLUSIVE MODE;

CREATE TRIGGER inventory_ledger_totals AFTER INSERT ON inventory_ledger
  FOR EACH ROW EXECUTE FUNCTION inventory_ledger_totals();

INSERT INTO position_ledger_totals (position_id, company_id, warehouse_id, total)
SELECT position_id, company_id, warehouse_id, sum(qty_delta)
FROM inventory_ledger
GROUP BY position_id, company_id, warehouse_id;
