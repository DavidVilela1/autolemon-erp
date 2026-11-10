-- =============================================================================
-- Migration 0006_retention — bounded data-retention purge (review finding R-15).
-- Owning module: platform. Reviewed: v0.6.0 (see docs/OPERATIONS.md "Retention").
--
-- The runtime role gets NO direct DELETE on these tables. It may only call this
-- SECURITY DEFINER function, which deletes strictly operational, expired data:
--   * command_log      idempotency records older than N days (replay window ends there);
--   * sessions         revoked/expired sessions whose end is older than N days;
--   * one_time_tokens  used/expired invitation/reset tokens older than N days;
--   * domain_outbox    events PUBLISHED more than N days ago (unpublished never deleted);
--   * auth_throttle    idle throttle windows older than 1 day and not locked.
-- Business history (inventory ledger/transactions, audit log, documents) is never purged.
-- Minimum retention is enforced here (7 days) so a misconfiguration cannot wipe live data.
-- =============================================================================

CREATE FUNCTION app_retention_purge(
  p_command_log_days integer,
  p_session_days integer,
  p_token_days integer,
  p_outbox_days integer
) RETURNS TABLE (command_log bigint, sessions bigint, one_time_tokens bigint, domain_outbox bigint, auth_throttle bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n1 bigint; n2 bigint; n3 bigint; n4 bigint; n5 bigint;
BEGIN
  IF least(p_command_log_days, p_session_days, p_token_days, p_outbox_days) < 7 THEN
    RAISE EXCEPTION 'retention below the 7-day minimum' USING ERRCODE = '22023';
  END IF;
  DELETE FROM command_log c WHERE c.created_at < now() - make_interval(days => p_command_log_days);
  GET DIAGNOSTICS n1 = ROW_COUNT;
  DELETE FROM sessions s
    WHERE coalesce(s.revoked_at, least(s.idle_expires_at, s.absolute_expires_at)) < now() - make_interval(days => p_session_days);
  GET DIAGNOSTICS n2 = ROW_COUNT;
  DELETE FROM one_time_tokens t
    WHERE coalesce(t.used_at, t.expires_at) < now() - make_interval(days => p_token_days);
  GET DIAGNOSTICS n3 = ROW_COUNT;
  DELETE FROM domain_outbox o
    WHERE o.published_at IS NOT NULL AND o.published_at < now() - make_interval(days => p_outbox_days);
  GET DIAGNOSTICS n4 = ROW_COUNT;
  DELETE FROM auth_throttle a
    WHERE a.window_started_at < now() - interval '1 day' AND (a.locked_until IS NULL OR a.locked_until < now());
  GET DIAGNOSTICS n5 = ROW_COUNT;
  RETURN QUERY SELECT n1, n2, n3, n4, n5;
END $$;

REVOKE ALL ON FUNCTION app_retention_purge(integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_retention_purge(integer, integer, integer, integer) TO autolemon_app;
