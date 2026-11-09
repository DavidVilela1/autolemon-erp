-- =============================================================================
-- Migration 0001_platform — shared platform: tenants, identity, sessions, MFA,
-- key registry, security audit log, idempotency log, outbox, document numbering.
-- Owning module: platform. Reviewed: v0.5.0 (see docs/DATABASE.md).
--
-- Design notes (why):
--  * Every tenant-owned table carries company_id and exposes UNIQUE (id, company_id)
--    so that child tables can use COMPOSITE foreign keys. A child row can therefore
--    never point at a parent that belongs to another company, even if application
--    code has a bug (tenant integrity enforced by the database, not by convention).
--  * Secrets (session tokens, CSRF tokens, recovery codes, one-time tokens) are
--    stored only as SHA-256 hashes of high-entropy random values. Passwords use
--    Argon2id (application side). TOTP seeds and PII are AES-256-GCM ciphertexts.
--  * Append-only tables are protected by triggers AND by missing UPDATE/DELETE grants
--    for the application role (defence in depth). A PostgreSQL superuser can still
--    alter history: production needs off-site write-once log shipping (AUDIT_LOGGING.md).
-- =============================================================================

-- Application runtime role (least privilege, no ownership, subject to RLS).
-- Production provisions LOGIN + credentials out of band; dev tooling sets a password.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autolemon_app') THEN
    CREATE ROLE autolemon_app NOLOGIN;
  END IF;
END $$;

-- Generic guard used by append-only tables: any UPDATE or DELETE raises.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- Tenant context helpers used by RLS policies. The application sets these with
-- set_config(..., is_local => true) at the start of EVERY transaction so a pooled
-- connection never carries a previous tenant's context. Missing context => NULL =>
-- no rows (fail closed).
CREATE FUNCTION app_company() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.company_id', true), '')::uuid
$$;

-- Warehouse visibility: '*' (company admin or system job scoped to one company) or one
-- specific warehouse UUID (warehouse staff).
CREATE FUNCTION app_wh_visible(wh uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.wh_scope', true), '') = '*'
      OR wh = nullif(nullif(current_setting('app.wh_scope', true), ''), '*')::uuid
$$;

CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (id, company_id)
);

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  email            text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  display_name     text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  role             text NOT NULL CHECK (role IN ('ADMIN', 'STAFF')),
  status           text NOT NULL DEFAULT 'INVITED' CHECK (status IN ('INVITED', 'ACTIVE', 'DISABLED')),
  warehouse_id     uuid,
  password_hash    text,                      -- Argon2id PHC string, never reversible
  password_changed_at timestamptz,
  mfa_enrolled_at  timestamptz,
  phone_enc        text,                      -- AES-256-GCM envelope (PII, see ENCRYPTION_AND_KEYS.md)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  -- Staff are bound to exactly one warehouse of THEIR company (composite FK).
  FOREIGN KEY (warehouse_id, company_id) REFERENCES warehouses (id, company_id),
  CHECK (role = 'ADMIN' OR warehouse_id IS NOT NULL)
);

CREATE TABLE user_permissions (
  user_id     uuid NOT NULL,
  company_id  uuid NOT NULL,
  permission  text NOT NULL CHECK (permission ~ '^[a-z.]{3,40}$'),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  uuid,
  PRIMARY KEY (user_id, permission),
  FOREIGN KEY (user_id, company_id) REFERENCES users (id, company_id)
);

-- Opaque server-side sessions. The cookie carries a 256-bit random token; only its
-- SHA-256 is stored, so a database read does not yield usable session cookies.
CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL,
  company_id          uuid NOT NULL,
  token_hash          bytea NOT NULL UNIQUE,
  csrf_hash           bytea NOT NULL,
  state               text NOT NULL CHECK (state IN ('MFA_PENDING', 'ACTIVE')),
  mfa_attempts        integer NOT NULL DEFAULT 0,
  active_warehouse_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  mfa_verified_at     timestamptz,
  step_up_at          timestamptz,
  revoked_at          timestamptz,
  revoke_reason       text,
  client_ip           text,
  user_agent          text CHECK (length(user_agent) <= 300),
  FOREIGN KEY (user_id, company_id) REFERENCES users (id, company_id),
  FOREIGN KEY (active_warehouse_id, company_id) REFERENCES warehouses (id, company_id)
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- TOTP enrolment. secret_enc is AES-256-GCM ciphertext bound (AAD) to company/user.
-- last_used_step prevents replay of a code within its validity window.
CREATE TABLE mfa_totp (
  user_id        uuid PRIMARY KEY,
  company_id     uuid NOT NULL,
  secret_enc     text NOT NULL,
  confirmed_at   timestamptz,
  last_used_step bigint NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, company_id) REFERENCES users (id, company_id)
);

-- Single-use recovery codes, stored as SHA-256 of 80-bit random codes.
CREATE TABLE mfa_recovery_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  company_id  uuid NOT NULL,
  code_hash   bytea NOT NULL UNIQUE,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, company_id) REFERENCES users (id, company_id)
);

-- Invitation / MFA reset / password reset tokens. One-time, short-lived, hashed.
CREATE TABLE one_time_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  company_id  uuid NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('INVITATION', 'MFA_RESET', 'PASSWORD_RESET')),
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, company_id) REFERENCES users (id, company_id)
);

-- Login / MFA throttling with exponential backoff (shared across API instances).
CREATE TABLE auth_throttle (
  throttle_key      text PRIMARY KEY CHECK (length(throttle_key) <= 200),
  failures          integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  locked_until      timestamptz
);

-- Envelope encryption: per-tenant data-encryption keys (DEKs), stored only WRAPPED by a
-- key-encryption key (KEK) that lives in the KMS / secrets provider, never in this DB.
CREATE TABLE tenant_data_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  version     integer NOT NULL CHECK (version > 0),
  kek_id      text NOT NULL CHECK (length(kek_id) <= 200),
  wrapped_dek bytea NOT NULL,
  status      text NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, version)
);
CREATE UNIQUE INDEX tenant_data_keys_one_active ON tenant_data_keys (company_id) WHERE status = 'ACTIVE';

-- Security audit log, hash-chained per chain_key (company or the pre-auth chain).
-- hash = SHA-256(prev_hash || canonical JSON of the entry). Verified by /admin/audit/verify.
CREATE TABLE security_audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_key      uuid NOT NULL,
  seq            bigint NOT NULL,
  company_id     uuid,
  occurred_at    timestamptz NOT NULL,
  actor_user_id  uuid,
  action         text NOT NULL CHECK (length(action) <= 80),
  resource_type  text CHECK (length(resource_type) <= 60),
  resource_id    text CHECK (length(resource_id) <= 80),
  warehouse_id   uuid,
  outcome        text NOT NULL CHECK (outcome IN ('SUCCESS', 'DENIED', 'FAILURE')),
  request_id     text CHECK (length(request_id) <= 80),
  client_ip      text CHECK (length(client_ip) <= 60),
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash      bytea NOT NULL,
  hash           bytea NOT NULL,
  UNIQUE (chain_key, seq)
);
CREATE INDEX security_audit_company_time ON security_audit_log (company_id, occurred_at DESC);
CREATE TRIGGER security_audit_append_only BEFORE UPDATE OR DELETE ON security_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Idempotency log: a repeated command with the same key returns the stored response;
-- a different payload under the same key is rejected (409).
CREATE TABLE command_log (
  company_id      uuid NOT NULL REFERENCES companies(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,80}$'),
  user_id         uuid NOT NULL,
  command         text NOT NULL,
  request_hash    bytea NOT NULL,
  response        jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, idempotency_key)
);

-- Transactional outbox for versioned domain events (written in the same transaction as
-- the state change; a dispatcher publishes them later). No consumers exist in v0.5.
CREATE TABLE domain_outbox (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     uuid NOT NULL REFERENCES companies(id),
  warehouse_id   uuid,
  event_type     text NOT NULL CHECK (event_type ~ '^[a-z]+(\.[a-z_]+)+$'),
  event_version  integer NOT NULL CHECK (event_version > 0),
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0
);
CREATE INDEX domain_outbox_pending ON domain_outbox (id) WHERE published_at IS NULL;

-- Human-readable document numbers (e.g. ENT-PORTO-000001), gap-tolerant, per scope.
CREATE TABLE doc_sequences (
  company_id  uuid NOT NULL REFERENCES companies(id),
  scope       text NOT NULL,
  doc_type    text NOT NULL,
  next_value  bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, scope, doc_type)
);
