# ADR-0019 — Passkeys (WebAuthn) as second factor; administrators passkey-only in production

Status: Accepted (v0.6.0). Owning module: platform/auth. Supersedes the interim part of ADR-0011.

**Context.** TOTP is phishing-susceptible (SEC-OPEN-001). Administrators hold the highest-impact
permissions (users, keys, audit, PII).

**Decision.**

- `@simplewebauthn/server` 14.1.0 / `@simplewebauthn/browser` 14.0.0 (exact pins). Passkeys are
  the **second factor** after the password (password + passkey), not a passwordless login, so the
  existing throttling, session rotation and audit flow is reused unchanged.
- Registration requires a recent step-up (`account.mfa.change`); `userVerification: required`;
  attestation `none` (no device allow-listing; privacy-preserving); `residentKey: preferred`.
- Challenges are stored on the session row (`webauthn_challenge`, purpose, 5-minute expiry),
  consumed atomically (`UPDATE … FROM (SELECT … FOR UPDATE) RETURNING old values`), single use and
  purpose-bound (REGISTER / AUTHENTICATE / STEP_UP). Origin = `WEB_ORIGIN`, RP id =
  `WEBAUTHN_RP_ID` or its host name.
- Assertions must match a non-revoked credential **of the same user**; the sign counter and last
  use are updated.
- `ADMIN_PASSKEY_REQUIRED` (mandatory `true` in production, enforced by `loadConfig`): an admin
  without a passkey may only reach routes marked `@AccountSecurity()` (session, account, passkey
  registration); once a passkey exists, TOTP is refused for that admin's login and step-up
  (`PASSKEY_REQUIRED`), and the last passkey cannot be revoked (`LAST_PASSKEY`). Recovery codes
  remain the break-glass path (an admin MFA reset by another admin is audited).
- Staff keep TOTP or may add passkeys voluntarily.

**Evidence.** `tests/security/passkeys-account.test.ts` generates real attestation/assertion
objects with a software P-256 authenticator (`tests/helpers/soft-authenticator.ts`) so the library
verification runs unmodified; `tests/e2e/warehouse.spec.ts` registers, signs in and steps up with
a Chrome DevTools virtual authenticator.

**Consequences.** Admin onboarding needs a platform authenticator or security key. Lost-device
recovery for admins goes through recovery codes or another admin. Attestation-based authenticator
allow-listing is out of scope (would need an MDS feed).
