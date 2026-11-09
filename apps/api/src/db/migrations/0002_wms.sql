-- =============================================================================
-- Migration 0002_wms — autonomous WMS: stock items, topology, containers, stock
-- positions, append-only ledger, reservations and operational documents.
-- Owning module: WMS. Reviewed: v0.5.0 (see docs/DATABASE.md, WMS_STATE_MACHINES.md).
--
-- Core rule: the same SKU may exist in unlimited independent positions per warehouse
-- and across warehouses. There is deliberately NO unique (sku, warehouse) constraint.
-- A position is identified by (warehouse, sku, holder, status, lot) and has EXACTLY
-- one holder: a stock-holding fixed node OR a movable container.
-- Quantities are numeric(18,3) (exact decimal arithmetic in the database).
-- =============================================================================

CREATE TABLE skus (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id),
  code              text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'),
  description       text NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  base_uom          text NOT NULL DEFAULT 'UN' CHECK (base_uom ~ '^[A-Z]{1,8}$'),
  brand             text CHECK (length(brand) <= 80),
  manufacturer_ref  text CHECK (length(manufacturer_ref) <= 80),
  tracking          text NOT NULL DEFAULT 'NONE' CHECK (tracking IN ('NONE', 'LOT', 'SERIAL')),
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BLOCKED', 'DISCONTINUED')),
  -- Optional simple attributes only (validated by the API); relationships belong in
  -- extension-owned relational tables, never here (no EAV model).
  attributes        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (id, company_id)
);

CREATE TABLE sku_barcodes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL,
  sku_id       uuid NOT NULL,
  barcode      text NOT NULL CHECK (barcode ~ '^[\x21-\x7e]{1,64}$'),
  uom          text NOT NULL CHECK (uom ~ '^[A-Z]{1,8}$'),
  qty_per_uom  numeric(18,3) NOT NULL CHECK (qty_per_uom > 0),
  UNIQUE (company_id, barcode),
  FOREIGN KEY (sku_id, company_id) REFERENCES skus (id, company_id)
);

-- Nesting rules for fixed nodes (also mirrored in TypeScript for early feedback).
CREATE FUNCTION wms_node_parent_allowed(child text, parent text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE child
    WHEN 'ZONE'       THEN parent IS NULL
    WHEN 'AISLE'      THEN parent = 'ZONE'
    WHEN 'RACK'       THEN parent IN ('ZONE', 'AISLE')
    WHEN 'SHELF'      THEN parent = 'RACK'
    WHEN 'BIN'        THEN parent IN ('RACK', 'SHELF')
    WHEN 'LOCATION'   THEN parent IN ('ZONE', 'AISLE', 'RACK', 'SHELF')
    WHEN 'STAGING'    THEN parent IS NULL OR parent = 'ZONE'
    WHEN 'INSPECTION' THEN parent IS NULL OR parent = 'ZONE'
    WHEN 'QUARANTINE' THEN parent IS NULL OR parent = 'ZONE'
    WHEN 'DISPATCH'   THEN parent IS NULL OR parent = 'ZONE'
    ELSE false
  END
$$;

CREATE TABLE storage_nodes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL,
  warehouse_id  uuid NOT NULL,
  parent_id     uuid,
  kind          text NOT NULL CHECK (kind IN ('ZONE','AISLE','RACK','SHELF','BIN','LOCATION','STAGING','INSPECTION','QUARANTINE','DISPATCH')),
  code          text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  holds_stock   boolean NOT NULL,
  depth         integer NOT NULL CHECK (depth BETWEEN 0 AND 15),
  path          text NOT NULL CHECK (length(path) <= 700),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, code),
  UNIQUE (id, company_id, warehouse_id),
  FOREIGN KEY (warehouse_id, company_id) REFERENCES warehouses (id, company_id),
  -- Parent must be in the SAME company AND warehouse (composite FK).
  FOREIGN KEY (parent_id, company_id, warehouse_id) REFERENCES storage_nodes (id, company_id, warehouse_id),
  CHECK (parent_id IS NULL OR parent_id <> id),
  -- Structural nodes never hold stock directly; operational nodes always do.
  CHECK (CASE WHEN kind IN ('ZONE','AISLE','RACK') THEN NOT holds_stock
              WHEN kind IN ('BIN','LOCATION','STAGING','INSPECTION','QUARANTINE','DISPATCH') THEN holds_stock
              ELSE true END)
);
CREATE INDEX storage_nodes_parent ON storage_nodes (parent_id);

-- Validates nesting on insert and freezes identity columns on update. Because a parent
-- must already exist when a child is inserted and parent_id can never change, cycles
-- are impossible by construction (no recursive check needed).
CREATE FUNCTION storage_nodes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_kind text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.kind <> OLD.kind
       OR NEW.company_id <> OLD.company_id OR NEW.warehouse_id <> OLD.warehouse_id
       OR NEW.code <> OLD.code OR NEW.depth <> OLD.depth OR NEW.path <> OLD.path THEN
      RAISE EXCEPTION 'storage node identity/parent is immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT kind INTO parent_kind FROM storage_nodes WHERE id = NEW.parent_id;
  END IF;
  IF NOT wms_node_parent_allowed(NEW.kind, parent_kind) THEN
    RAISE EXCEPTION 'nesting % under % is not supported', NEW.kind, coalesce(parent_kind, '(root)')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER storage_nodes_guard BEFORE INSERT OR UPDATE ON storage_nodes
  FOR EACH ROW EXECUTE FUNCTION storage_nodes_guard();

-- Movable containers. Supported nesting: container -> stock-holding fixed node ONLY.
-- Containers inside containers are NOT supported in v0.5 (no column exists for it).
CREATE TABLE containers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL,
  warehouse_id     uuid NOT NULL,
  code             text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'),
  kind             text NOT NULL CHECK (kind IN ('BOX', 'TOTE', 'PALLET', 'PACKAGE')),
  current_node_id  uuid NOT NULL,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISPATCHED', 'CLOSED')),
  outbound_id      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, code),
  UNIQUE (id, company_id, warehouse_id),
  FOREIGN KEY (current_node_id, company_id, warehouse_id) REFERENCES storage_nodes (id, company_id, warehouse_id),
  CHECK ((kind = 'PACKAGE') = (outbound_id IS NOT NULL))
);

-- A container may only sit on a stock-holding node; identity columns are frozen.
CREATE FUNCTION containers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.company_id <> OLD.company_id OR NEW.warehouse_id <> OLD.warehouse_id
       OR NEW.kind <> OLD.kind OR NEW.code <> OLD.code) THEN
    RAISE EXCEPTION 'container identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  SELECT holds_stock AND active INTO ok FROM storage_nodes WHERE id = NEW.current_node_id;
  IF NOT coalesce(ok, false) THEN
    RAISE EXCEPTION 'container must be placed on an active stock-holding node' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER containers_guard BEFORE INSERT OR UPDATE ON containers
  FOR EACH ROW EXECUTE FUNCTION containers_guard();

-- Posted inventory transactions (header of the ledger). Append-only.
CREATE TABLE inventory_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL,
  warehouse_id     uuid NOT NULL,
  txn_type         text NOT NULL CHECK (txn_type IN (
                     'OPENING','RECEIPT','PUTAWAY','MOVE','CONTAINER_MOVE','PICK','PACK','DISPATCH',
                     'TRANSFER_OUT','TRANSFER_IN','RETURN_RECEIPT','RETURN_DISPOSITION',
                     'COUNT_ADJUST','ADJUST','REPLENISH','REVERSAL')),
  actor_user_id    uuid NOT NULL,
  reference_type   text,
  reference_id     uuid,
  reversal_of      uuid UNIQUE,  -- a transaction can be reversed at most once
  note             text CHECK (length(note) <= 500),
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id, warehouse_id),
  FOREIGN KEY (warehouse_id, company_id) REFERENCES warehouses (id, company_id),
  FOREIGN KEY (reversal_of, company_id, warehouse_id) REFERENCES inventory_transactions (id, company_id, warehouse_id)
);
CREATE INDEX inventory_transactions_ref ON inventory_transactions (reference_type, reference_id);
CREATE INDEX inventory_transactions_time ON inventory_transactions (warehouse_id, created_at DESC);
CREATE TRIGGER inventory_transactions_append_only BEFORE UPDATE OR DELETE ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Container movement history (append-only). Moving a container never touches positions.
CREATE TABLE container_movements (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     uuid NOT NULL,
  warehouse_id   uuid NOT NULL,
  container_id   uuid NOT NULL,
  from_node_id   uuid NOT NULL,
  to_node_id     uuid NOT NULL,
  txn_id         uuid NOT NULL,
  actor_user_id  uuid NOT NULL,
  reason         text CHECK (length(reason) <= 200),
  moved_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (container_id, company_id, warehouse_id) REFERENCES containers (id, company_id, warehouse_id),
  FOREIGN KEY (from_node_id, company_id, warehouse_id) REFERENCES storage_nodes (id, company_id, warehouse_id),
  FOREIGN KEY (to_node_id, company_id, warehouse_id) REFERENCES storage_nodes (id, company_id, warehouse_id),
  FOREIGN KEY (txn_id, company_id, warehouse_id) REFERENCES inventory_transactions (id, company_id, warehouse_id)
);
CREATE TRIGGER container_movements_append_only BEFORE UPDATE OR DELETE ON container_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Stock positions = indexed balances. Reconciled against inventory_ledger.
CREATE TABLE stock_positions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL,
  warehouse_id         uuid NOT NULL,
  sku_id               uuid NOT NULL,
  holder_node_id       uuid,
  holder_container_id  uuid,
  holder_id            uuid GENERATED ALWAYS AS (coalesce(holder_node_id, holder_container_id)) STORED,
  stock_status         text NOT NULL CHECK (stock_status IN ('AVAILABLE','RECEIVED','INSPECTION','QUARANTINE','DAMAGED','PICKED')),
  lot_code             text NOT NULL DEFAULT '' CHECK (length(lot_code) <= 40),
  -- Negative on-hand is disallowed (v0.5 policy, not configurable).
  qty_on_hand          numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  qty_reserved         numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0 AND qty_reserved <= qty_on_hand),
  version              bigint NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((holder_node_id IS NULL) <> (holder_container_id IS NULL)),
  CHECK (qty_reserved = 0 OR stock_status = 'AVAILABLE'),
  UNIQUE (warehouse_id, sku_id, holder_id, stock_status, lot_code),
  UNIQUE (id, company_id, warehouse_id),
  FOREIGN KEY (warehouse_id, company_id) REFERENCES warehouses (id, company_id),
  FOREIGN KEY (sku_id, company_id) REFERENCES skus (id, company_id),
  FOREIGN KEY (holder_node_id, company_id, warehouse_id) REFERENCES storage_nodes (id, company_id, warehouse_id),
  FOREIGN KEY (holder_container_id, company_id, warehouse_id) REFERENCES containers (id, company_id, warehouse_id)
);
CREATE INDEX stock_positions_sku ON stock_positions (warehouse_id, sku_id) WHERE qty_on_hand > 0;
CREATE INDEX stock_positions_holder ON stock_positions (holder_id) WHERE qty_on_hand > 0;

-- Positions on fixed nodes require a stock-holding node; identity columns are frozen.
CREATE FUNCTION stock_positions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.company_id <> OLD.company_id OR NEW.warehouse_id <> OLD.warehouse_id
       OR NEW.sku_id <> OLD.sku_id OR NEW.holder_node_id IS DISTINCT FROM OLD.holder_node_id
       OR NEW.holder_container_id IS DISTINCT FROM OLD.holder_container_id
       OR NEW.stock_status <> OLD.stock_status OR NEW.lot_code <> OLD.lot_code) THEN
    RAISE EXCEPTION 'stock position identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.holder_node_id IS NOT NULL THEN
    SELECT holds_stock INTO ok FROM storage_nodes WHERE id = NEW.holder_node_id;
    IF NOT coalesce(ok, false) THEN
      RAISE EXCEPTION 'node does not hold stock' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_positions_guard BEFORE INSERT OR UPDATE ON stock_positions
  FOR EACH ROW EXECUTE FUNCTION stock_positions_guard();

-- Append-only movement ledger: one row per position delta.
CREATE TABLE inventory_ledger (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id           uuid NOT NULL,
  warehouse_id         uuid NOT NULL,
  txn_id               uuid NOT NULL,
  position_id          uuid NOT NULL,
  sku_id               uuid NOT NULL,
  holder_node_id       uuid,
  holder_container_id  uuid,
  stock_status         text NOT NULL,
  lot_code             text NOT NULL,
  qty_delta            numeric(18,3) NOT NULL CHECK (qty_delta <> 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (txn_id, company_id, warehouse_id) REFERENCES inventory_transactions (id, company_id, warehouse_id),
  FOREIGN KEY (position_id, company_id, warehouse_id) REFERENCES stock_positions (id, company_id, warehouse_id)
);
CREATE INDEX inventory_ledger_position ON inventory_ledger (position_id);
CREATE INDEX inventory_ledger_sku_time ON inventory_ledger (warehouse_id, sku_id, created_at DESC);
CREATE INDEX inventory_ledger_txn ON inventory_ledger (txn_id);
CREATE TRIGGER inventory_ledger_append_only BEFORE UPDATE OR DELETE ON inventory_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ----------------------------------------------------------------- inbound

CREATE TABLE inbound_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL,
  warehouse_id  uuid NOT NULL,
  number        text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('EXPECTED', 'UNPLANNED')),
  status        text NOT NULL CHECK (status IN ('DRAFT', 'OPEN', 'RECEIVING', 'CLOSED', 'CANCELLED')),
  external_ref  text CHECK (length(external_ref) <= 80),
  note          text CHECK (length(note) <= 500),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  UNIQUE (warehouse_id, number),
  UNIQUE (id, company_id, warehouse_id),
  FOREIGN KEY (warehouse_id, company_id) REFERENCES warehouses (id, company_id)
);

CREATE TABLE inbound_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL,
  warehouse_id  uuid NOT NULL,
  inbound_id    uuid NOT NULL,
  line_no       integer NOT NULL,
  sku_id        uuid NOT NULL,
  qty_expected  numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_expected >= 0),
  qty_received  numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  qty_damaged   numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_damaged >= 0 AND qty_damaged <= qty_received),
  qty_short     numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_short >= 0),
  qty_excess    numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_excess >= 0),
  UNIQUE (inbound_id, line_no),
  UNIQUE (id, company_id, warehouse_id),
  FOREIGN KEY (inbound_id, company_id, warehouse_id) REFERENCES inbound_orders (id, company_id, warehouse_id),
  FOREIGN KEY (sku_id, company_id) REFERENCES skus (id, company_id)
);

CREATE TABLE putaway_tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL,
  warehouse_id        uuid NOT NULL,
  source_type         text NOT NULL CHECK (source_type IN ('INBOUND', 'TRANSFER')),
  source_id           uuid NOT NULL,
  sku_id              uuid NOT NULL,
  source_position_id  uuid NOT NULL,
  qty_total           numeric(18,3) NOT NULL CHECK (qty_total > 0),
  qty_done            numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_done >= 0 AND qty_done <= qty_total),
  status              text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE', 'CANCELLED')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id, warehouse_id),
  FOREIGN KEY (source_position_id, company_id, warehouse_id) REFERENCES stock_positions (id, company_id, warehouse_id),
  FOREIGN KEY (sku_id, company_id) REFERENCES skus (id, company_id)
);

-- ----------------------------------------------------------------- outbound

CREATE TABLE outbound_orders (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL,
  warehouse_id           uuid NOT NULL,
  number                 text NOT NULL,
  status                 text NOT NULL CHECK (status IN ('DRAFT', 'ALLOCATED', 'IN_PROGRESS', 'CLOSED', 'CANCELLED')),
  external_ref           text CHECK (length(external_ref) <= 80),
  recipient_contact_enc  text,           -- AES-256-GCM envelope (may contain PII)
  backorder_of           uuid,
  created_by             uuid NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  closed_at              timestamptz,
  UNIQUE (warehouse_id, number),
  UNIQUE (id, company_id, warehouse_id),
  FOREIGN KEY (warehouse_id, company_id) REFERENCES warehouses (id, company_id),
  FOREIGN KEY (backorder_of, company_id, warehouse_id) REFERENCES outbound_orders (id, company_id, warehouse_id)
);

CREATE TABLE outbound_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL,
  warehouse_id    uuid NOT NULL,
  outbound_id     uuid NOT NULL,
  line_no         integer NOT NULL,
  sku_id          uuid NOT NULL,
  qty_requested   numeric(18,3) NOT NULL CHECK (qty_requested > 0),
  qty_allocated   numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_allocated >= 0),   -- currently reserved, not yet picked
  qty_picked      numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_picked >= 0),
  qty_packed      numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_packed >= 0 AND qty_packed <= qty_picked),
  qty_dispatched  numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_dispatched >= 0 AND qty_dispatched <= qty_packed),
  qty_short       numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_short >= 0),
  CHECK (qty_allocated + qty_picked + qty_short <= qty_requested),
  UNIQUE (outbound_id, line_no),
  UNIQUE (id, company_id, warehouse_id),
  FOREIGN KEY (outbound_id, company_id, warehouse_id) REFERENCES outbound_orders (id, company_id, warehouse_id),
  FOREIGN KEY (sku_id, company_id) REFERENCES skus (id, company_id)
);

-- Reservations bind outbound lines to specific positions. Invariant (tested):
-- stock_positions.qty_reserved = SUM(qty_open) of ACTIVE reservations on that position.
CREATE TABLE reservations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL,
  warehouse_id      uuid NOT NULL,
  position_id       uuid NOT NULL,
  outbound_line_id  uuid NOT NULL,
  qty_initial       numeric(18,3) NOT NULL CHECK (qty_initial > 0),
  qty_open          numeric(18,3) NOT NULL CHECK (qty_open >= 0 AND qty_open <= qty_initial),
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'ACTIVE' OR qty_open = 0),
  UNIQUE (id, company_id, warehouse_id),
  FOREIGN KEY (position_id, company_id, warehouse_id) REFERENCES stock_positions (id, company_id, warehouse_id),
  FOREIGN KEY (outbound_line_id, company_id, warehouse_id) REFERENCES outbound_lines (id, company_id, warehouse_id)
);
CREATE INDEX reservations_position ON reservations (position_id) WHERE status = 'ACTIVE';

-- Packing traceability: which outbound line quantities went into which package.
CREATE TABLE outbound_package_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL,
  warehouse_id      uuid NOT NULL,
  package_id        uuid NOT NULL,
  outbound_line_id  uuid NOT NULL,
  qty               numeric(18,3) NOT NULL CHECK (qty > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (package_id, company_id, warehouse_id) REFERENCES containers (id, company_id, warehouse_id),
  FOREIGN KEY (outbound_line_id, company_id, warehouse_id) REFERENCES outbound_lines (id, company_id, warehouse_id)
);
ALTER TABLE containers ADD FOREIGN KEY (outbound_id, company_id, warehouse_id)
  REFERENCES outbound_orders (id, company_id, warehouse_id);

-- ----------------------------------------------------------------- transfers

-- In-transit quantity = qty_shipped - qty_received - qty_lost (held by the document, not
-- by any stock position), so company totals never double-count.
CREATE TABLE transfers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL,
  number              text NOT NULL,
  source_warehouse_id uuid NOT NULL,
  dest_warehouse_id   uuid NOT NULL,
  status              text NOT NULL CHECK (status IN ('DRAFT', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED')),
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  dispatched_at       timestamptz,
  closed_at           timestamptz,
  UNIQUE (company_id, number),
  UNIQUE (id, company_id),
  CHECK (source_warehouse_id <> dest_warehouse_id),
  FOREIGN KEY (source_warehouse_id, company_id) REFERENCES warehouses (id, company_id),
  FOREIGN KEY (dest_warehouse_id, company_id) REFERENCES warehouses (id, company_id)
);

CREATE TABLE transfer_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL,
  transfer_id    uuid NOT NULL,
  line_no        integer NOT NULL,
  sku_id         uuid NOT NULL,
  qty_requested  numeric(18,3) NOT NULL CHECK (qty_requested > 0),
  qty_shipped    numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_shipped >= 0 AND qty_shipped <= qty_requested),
  qty_received   numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  qty_lost       numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_lost >= 0),
  CHECK (qty_received + qty_lost <= qty_shipped),
  UNIQUE (transfer_id, line_no),
  FOREIGN KEY (transfer_id, company_id) REFERENCES transfers (id, company_id),
  FOREIGN KEY (sku_id, company_id) REFERENCES skus (id, company_id)
);

-- ----------------------------------------------------------------- returns

CREATE TABLE returns (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL,
  warehouse_id        uuid NOT NULL,
  number              text NOT NULL,
  status              text NOT NULL CHECK (status IN ('INSPECTION', 'CLOSED')),
  external_ref        text CHECK (length(external_ref) <= 80),
  inspection_node_id  uuid NOT NULL,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, number),
  UNIQUE (id, company_id, warehouse_id),
  FOREIGN KEY (inspection_node_id, company_id, warehouse_id) REFERENCES storage_nodes (id, company_id, warehouse_id)
);

CREATE TABLE return_lines (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid NOT NULL,
  warehouse_id            uuid NOT NULL,
  return_id               uuid NOT NULL,
  line_no                 integer NOT NULL,
  sku_id                  uuid NOT NULL,
  inspection_position_id  uuid NOT NULL,
  qty_received            numeric(18,3) NOT NULL CHECK (qty_received > 0),
  qty_saleable            numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_saleable >= 0),
  qty_quarantined         numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_quarantined >= 0),
  qty_damaged             numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_damaged >= 0),
  qty_scrapped            numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_scrapped >= 0),
  CHECK (qty_saleable + qty_quarantined + qty_damaged + qty_scrapped <= qty_received),
  UNIQUE (return_id, line_no),
  UNIQUE (id, company_id, warehouse_id),
  FOREIGN KEY (return_id, company_id, warehouse_id) REFERENCES returns (id, company_id, warehouse_id),
  FOREIGN KEY (inspection_position_id, company_id, warehouse_id) REFERENCES stock_positions (id, company_id, warehouse_id),
  FOREIGN KEY (sku_id, company_id) REFERENCES skus (id, company_id)
);

-- ----------------------------------------------------------------- counts

-- Counting policy: snapshot + optimistic version check (no warehouse freeze).
-- Each line stores the position version at snapshot time; approval refuses lines whose
-- position changed since (STALE => recount).
CREATE TABLE count_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL,
  warehouse_id  uuid NOT NULL,
  number        text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('FULL', 'PARTIAL', 'CYCLE')),
  status        text NOT NULL CHECK (status IN ('OPEN', 'SUBMITTED', 'APPROVED', 'CANCELLED')),
  scope         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid NOT NULL,
  approved_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  submitted_at  timestamptz,
  approved_at   timestamptz,
  UNIQUE (warehouse_id, number),
  UNIQUE (id, company_id, warehouse_id),
  FOREIGN KEY (warehouse_id, company_id) REFERENCES warehouses (id, company_id)
);

CREATE TABLE count_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL,
  warehouse_id         uuid NOT NULL,
  session_id           uuid NOT NULL,
  position_id          uuid,
  sku_id               uuid NOT NULL,
  holder_node_id       uuid,
  holder_container_id  uuid,
  stock_status         text NOT NULL,
  lot_code             text NOT NULL DEFAULT '',
  qty_snapshot         numeric(18,3) NOT NULL CHECK (qty_snapshot >= 0),
  version_snapshot     bigint NOT NULL,
  qty_counted          numeric(18,3) CHECK (qty_counted >= 0),
  counted_by           uuid,
  counted_at           timestamptz,
  state                text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'COUNTED', 'STALE', 'APPROVED')),
  adjustment_txn_id    uuid,
  CHECK ((holder_node_id IS NULL) <> (holder_container_id IS NULL)),
  UNIQUE (id, company_id, warehouse_id),
  FOREIGN KEY (session_id, company_id, warehouse_id) REFERENCES count_sessions (id, company_id, warehouse_id),
  FOREIGN KEY (position_id, company_id, warehouse_id) REFERENCES stock_positions (id, company_id, warehouse_id),
  FOREIGN KEY (sku_id, company_id) REFERENCES skus (id, company_id)
);

-- ----------------------------------------------------------------- replenishment

CREATE TABLE replenishment_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL,
  warehouse_id  uuid NOT NULL,
  sku_id        uuid NOT NULL,
  pick_node_id  uuid NOT NULL,
  min_qty       numeric(18,3) NOT NULL CHECK (min_qty >= 0),
  target_qty    numeric(18,3) NOT NULL CHECK (target_qty > 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (target_qty >= min_qty),
  UNIQUE (warehouse_id, sku_id, pick_node_id),
  UNIQUE (id, company_id, warehouse_id),
  FOREIGN KEY (pick_node_id, company_id, warehouse_id) REFERENCES storage_nodes (id, company_id, warehouse_id),
  FOREIGN KEY (sku_id, company_id) REFERENCES skus (id, company_id)
);
