-- =============================================================================
-- Migration 0003_rls_and_grants — least-privilege grants for the runtime role and
-- PostgreSQL Row-Level Security as DEFENCE IN DEPTH for tenant/warehouse isolation.
-- Owning module: platform security. Reviewed: v0.5.0 (see docs/security/AUTH_AND_RBAC.md).
--
-- Primary enforcement is in the service layer (object-level authorization). RLS is a
-- second line that limits the blast radius of a missing WHERE clause. It is only safe
-- because the API sets app.company_id / app.wh_scope with set_config(..., true) INSIDE
-- every transaction (transaction-local), verified by negative tests that use a pooled
-- connection without context and with a foreign tenant context.
-- RLS does NOT protect against a compromised application process (it can set any
-- context) nor against superusers/table owners (they bypass RLS).
-- =============================================================================

GRANT USAGE ON SCHEMA public TO autolemon_app;

-- Mutable operational tables: read/insert/update, never delete.
GRANT SELECT, INSERT, UPDATE ON
  companies, warehouses, users, user_permissions, sessions, mfa_totp, mfa_recovery_codes,
  one_time_tokens, tenant_data_keys, command_log, domain_outbox, doc_sequences,
  skus, sku_barcodes, storage_nodes, containers, stock_positions, reservations,
  inbound_orders, inbound_lines, putaway_tasks, outbound_orders, outbound_lines,
  outbound_package_lines, transfers, transfer_lines, returns, return_lines,
  count_sessions, count_lines, replenishment_rules
TO autolemon_app;

-- Permission revocation requires delete on this one join table.
GRANT DELETE ON user_permissions TO autolemon_app;
-- Throttle rows may be cleared after successful login.
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_throttle TO autolemon_app;

-- Append-only tables: SELECT + INSERT only (triggers also block UPDATE/DELETE).
GRANT SELECT, INSERT ON security_audit_log, inventory_transactions, inventory_ledger, container_movements
TO autolemon_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO autolemon_app;
GRANT EXECUTE ON FUNCTION app_company(), app_wh_visible(uuid) TO autolemon_app;

-- ----------------------------------------------------------------- RLS policies

-- Company-scoped tables (no internal warehouse locations exposed).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['skus', 'sku_barcodes', 'command_log', 'doc_sequences', 'domain_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (company_id = app_company()) WITH CHECK (company_id = app_company())', t);
  END LOOP;
END $$;

-- Warehouse-scoped tables: company AND warehouse visibility.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'storage_nodes', 'containers', 'container_movements', 'stock_positions',
    'inventory_transactions', 'inventory_ledger', 'reservations',
    'inbound_orders', 'inbound_lines', 'putaway_tasks',
    'outbound_orders', 'outbound_lines', 'outbound_package_lines',
    'returns', 'return_lines', 'count_sessions', 'count_lines', 'replenishment_rules'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY warehouse_isolation ON %I USING (company_id = app_company() AND app_wh_visible(warehouse_id)) '
      'WITH CHECK (company_id = app_company() AND app_wh_visible(warehouse_id))', t);
  END LOOP;
END $$;

-- Transfers are visible to either side; lines carry no internal location data.
ALTER TABLE transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY transfer_sides ON transfers
  USING (company_id = app_company() AND (app_wh_visible(source_warehouse_id) OR app_wh_visible(dest_warehouse_id)))
  WITH CHECK (company_id = app_company() AND (app_wh_visible(source_warehouse_id) OR app_wh_visible(dest_warehouse_id)));

ALTER TABLE transfer_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY transfer_line_sides ON transfer_lines
  USING (company_id = app_company() AND EXISTS (SELECT 1 FROM transfers t WHERE t.id = transfer_id))
  WITH CHECK (company_id = app_company() AND EXISTS (SELECT 1 FROM transfers t WHERE t.id = transfer_id));
