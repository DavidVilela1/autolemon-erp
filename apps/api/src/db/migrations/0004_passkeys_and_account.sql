-- =============================================================================
-- Migration 0004_passkeys_and_account — WebAuthn/passkey credentials (phishing-resistant
-- MFA) and per-session challenge storage.
-- Owning module: platform/auth. Reviewed: v0.6.0 (see docs/security/AUTH_AND_RBAC.md).
--
-- Why: TOTP can be phished (relayed in real time). WebAuthn binds the signature to the
-- origin (RP ID), so a look-alike site cannot reuse it. Only the PUBLIC key is stored; the
-- private key never leaves the authenticator. sign_count detects some cloned authenticators.
-- A challenge is single-use: it lives on the session row, expires after 5 minutes and is
-- cleared when consumed (verification succeeds or fails).
-- =============================================================================

CREATE TABLE webauthn_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  company_id     uuid NOT NULL,
  credential_id  text NOT NULL UNIQUE CHECK (credential_id ~ '^[A-Za-z0-9_-]+$' AND length(credential_id) BETWEEN 16 AND 1400),  -- base64url
  public_key     bytea NOT NULL CHECK (length(public_key) BETWEEN 32 AND 2048),          -- COSE key
  sign_count     bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports     text[] NOT NULL DEFAULT '{}',
  device_type    text NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up      boolean NOT NULL DEFAULT false,
  aaguid         text NOT NULL DEFAULT '' CHECK (length(aaguid) <= 40),
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  FOREIGN KEY (user_id, company_id) REFERENCES users (id, company_id)
);
CREATE INDEX webauthn_credentials_user ON webauthn_credentials (user_id) WHERE revoked_at IS NULL;

ALTER TABLE sessions
  ADD COLUMN webauthn_challenge text CHECK (length(webauthn_challenge) <= 200),
  ADD COLUMN webauthn_challenge_purpose text CHECK (webauthn_challenge_purpose IN ('REGISTER', 'AUTHENTICATE', 'STEP_UP')),
  ADD COLUMN webauthn_challenge_expires_at timestamptz;

GRANT SELECT, INSERT, UPDATE ON webauthn_credentials TO autolemon_app;
