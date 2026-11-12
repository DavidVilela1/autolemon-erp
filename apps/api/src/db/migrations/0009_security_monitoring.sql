-- =============================================================================
-- Migration 0009_security_monitoring — security alerts and incremental audit-chain
-- verification checkpoints (gate S-05 code part; ADR-0026). Owning module: platform.
-- Reviewed: v0.6.4.
--
-- security_alerts: one row per raised alert. At most ONE open alert per (company, rule)
--   (partial unique index), so a sustained attack updates the open alert instead of
--   flooding administrators. company_id NULL = system-wide alert (pre-authentication chain,
--   retention job); those are never shown to a company and are delivered via log/webhook.
--   The runtime role may only update the bookkeeping columns, and a trigger makes the
--   acknowledgement one-way (OPEN -> ACKNOWLEDGED, never back, ack fields immutable).
-- audit_chain_checkpoints: last verified (seq, hash) per audit chain so the periodic monitor
--   verifies only new entries; a full pass from seq 0 is restarted every 24 hours.
-- Neither table holds personal data: details carry counts, rule ids and sequence numbers.
-- =============================================================================

CREATE TABLE security_alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid REFERENCES companies(id),
  rule             text NOT NULL CHECK (rule ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' AND char_length(rule) <= 60),
  severity         text NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED')),
  occurrences      integer NOT NULL CHECK (occurrences >= 1),
  window_minutes   integer NOT NULL CHECK (window_minutes BETWEEN 1 AND 10080),
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  acknowledged_at  timestamptz,
  acknowledged_by  uuid,
  ack_note         text CHECK (char_length(ack_note) <= 300),
  notified_at      timestamptz,
  notify_attempts  integer NOT NULL DEFAULT 0 CHECK (notify_attempts >= 0),
  notify_error     text CHECK (char_length(notify_error) <= 200),
  CONSTRAINT security_alerts_ack_consistent CHECK ((status = 'ACKNOWLEDGED') = (acknowledged_at IS NOT NULL)),
  -- System alerts cannot be acknowledged by a company user.
  CONSTRAINT security_alerts_ack_company CHECK (acknowledged_by IS NULL OR company_id IS NOT NULL),
  -- The acknowledging user belongs to the alert's company (composite tenant FK).
  CONSTRAINT security_alerts_ack_user_fk FOREIGN KEY (acknowledged_by, company_id) REFERENCES users (id, company_id)
);
CREATE UNIQUE INDEX security_alerts_one_open
  ON security_alerts (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), rule) WHERE status = 'OPEN';
CREATE INDEX security_alerts_company_time ON security_alerts (company_id, first_seen_at DESC);
CREATE INDEX security_alerts_pending_notify ON security_alerts (first_seen_at) WHERE notified_at IS NULL;
-- Rule evaluation counts recent audit entries per action across all companies (and the
-- pre-authentication chain, company_id NULL); the existing (company_id, occurred_at) index
-- cannot serve a cross-company time range.
CREATE INDEX security_audit_time_action ON security_audit_log (occurred_at, action);

CREATE FUNCTION security_alerts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'ACKNOWLEDGED' AND NEW.status <> 'ACKNOWLEDGED' THEN
    RAISE EXCEPTION 'an acknowledged alert cannot be reopened' USING ERRCODE = '23514', CONSTRAINT = 'security_alert_one_way';
  END IF;
  IF OLD.acknowledged_at IS NOT NULL AND (NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
      OR NEW.acknowledged_by IS DISTINCT FROM OLD.acknowledged_by OR NEW.ack_note IS DISTINCT FROM OLD.ack_note) THEN
    RAISE EXCEPTION 'acknowledgement is immutable' USING ERRCODE = '23514', CONSTRAINT = 'security_alert_one_way';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.rule <> OLD.rule OR NEW.first_seen_at <> OLD.first_seen_at THEN
    RAISE EXCEPTION 'alert identity is immutable' USING ERRCODE = '23514', CONSTRAINT = 'security_alert_one_way';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER security_alerts_guard BEFORE UPDATE ON security_alerts
  FOR EACH ROW EXECUTE FUNCTION security_alerts_guard();

CREATE TABLE audit_chain_checkpoints (
  chain_key             uuid PRIMARY KEY,
  seq                   bigint NOT NULL CHECK (seq >= 0),
  hash                  bytea NOT NULL CHECK (octet_length(hash) = 32),
  verified_at           timestamptz NOT NULL DEFAULT now(),
  full_pass_started_at  timestamptz NOT NULL DEFAULT now(),
  last_result           text NOT NULL CHECK (last_result IN ('OK', 'BROKEN')),
  broken_at_seq         bigint
);

-- Runtime role: no DELETE; UPDATE limited to bookkeeping columns.
GRANT SELECT, INSERT ON security_alerts TO autolemon_app;
GRANT UPDATE (status, occurrences, details, last_seen_at, acknowledged_at, acknowledged_by, ack_note,
              notified_at, notify_attempts, notify_error) ON security_alerts TO autolemon_app;
GRANT SELECT, INSERT, UPDATE ON audit_chain_checkpoints TO autolemon_app;
