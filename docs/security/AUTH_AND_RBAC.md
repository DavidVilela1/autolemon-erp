# Authentication, MFA, sessions, RBAC and tenant isolation — v0.6.0

Owning module: platform/auth, platform/authz. References: NIST SP 800-63B-4, OWASP ASVS 5.0.0,
OWASP Password Storage / Session Management / CSRF cheat sheets.

## 1. Passwords

- Argon2id via `@node-rs/argon2` 2.2.2, per-hash 16-byte random salt (library), PHC string.
- Defaults **m = 64 MiB, t = 3, p = 1** (above OWASP minimum m=19 MiB,t=2). Measured on the build
  VM: m=19 MiB/t=2 ≈ 11–14 ms per hash; the default is proportionally slower. Tune
  `ARGON2_MEMORY_KIB`/`ARGON2_ITERATIONS` on production hardware (target 100–500 ms).
- `needsRehash()` upgrades stored hashes after a successful login when parameters increase.
- Policy: 12–128 chars, any Unicode, no composition rules; rejected if in the local common/
  breached list (plus the optional offline corpus `BREACHED_PASSWORD_CORPUS`, ADR-0025), containing the e-mail local part or app name, or trivially repetitive.
- Anti-enumeration: unknown accounts still run one Argon2 verification against a startup-generated
  dummy hash; one generic error for unknown user / wrong password / disabled / not enrolled.
- Never logged: request body fields `password`, `token`, `code`, `recoveryCode` are redacted.

## 2. MFA

| Factor                                          | Status             | Notes                                                                                                                  |
| ----------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step) | Implemented+Tested | Seed AES-256-GCM encrypted; replay blocked via `last_used_step` (conditional update)                                   |
| Recovery codes (10 × 80-bit)                    | Implemented+Tested | SHA-256 stored; single use; use audited as alert                                                                       |
| WebAuthn / passkeys (phishing-resistant)        | Implemented+Tested | Second factor and step-up; admins passkey-only when `ADMIN_PASSKEY_REQUIRED=true` (mandatory in production) — ADR-0019 |
| SMS / e-mail OTP                                | Not offered        | Deliberately excluded                                                                                                  |

MFA is **mandatory** for every account: a user without a confirmed factor cannot log in.
Passkeys are added from _A minha conta_ after a step-up (`account.mfa.change`); challenges are
single-use, purpose-bound (REGISTER/AUTHENTICATE/STEP_UP), expire after 5 minutes and are bound to
`WEB_ORIGIN` and the RP id. Under the admin policy an administrator without a passkey can reach
only `@AccountSecurity()` routes (`PASSKEY_REGISTRATION_REQUIRED`), TOTP is refused once a passkey
exists (`PASSKEY_REQUIRED`) and the last passkey cannot be revoked (`LAST_PASSKEY`).
Enrolment only through a one-time token: INVITATION (72 h) or MFA_RESET (24 h, also requires the
current password). Confirming enrolment revokes all sessions and replaces recovery codes.

## 3. Sessions

- Cookie `__Host-al_sid` (when `COOKIE_SECURE=true`): HttpOnly, Secure, SameSite=Strict, Path=/,
  no Domain, session-scoped. Value: 256-bit random token; DB stores SHA-256 only.
- States: `MFA_PENDING` (5 min, only `/auth/mfa/verify`), `ACTIVE`.
- Rotation: the pending session is revoked and a new token issued after MFA.
- Expiry: idle 30 min (sliding, written at most once/minute), absolute 12 h.
- Revocation: logout, password reset, MFA enrolment/reset, deactivation, permission change,
  warehouse re-assignment, 5 failed MFA attempts.
- CSRF: `X-CSRF-Token` = HMAC-SHA256(`CSRF_SECRET`, session id), compared in constant time
  against the stored hash; plus Origin must equal `WEB_ORIGIN`, `Sec-Fetch-Site: cross-site`
  rejected, `X-Requested-With: autolemon` required. No CORS is enabled at all.
- Step-up: `POST /api/auth/step-up` (fresh TOTP) or `POST /api/auth/step-up/passkey` stamps the
  session; valid 5 min for: role change (admin creation), warehouse re-assignment, MFA reset,
  password reset, key rotation, CSV export, inventory adjustment, reversal, release of blocked
  stock, count approval, PII read, passkey registration/removal, recovery-code regeneration.
- Self-service (`/api/auth/password/change`, `/sessions`, `/sessions/:id/revoke`,
  `/sessions/revoke-others`, `/recovery-codes/regenerate`, `/passkeys…`): password change needs
  the current password, is throttled (5 failures) and revokes every other session; users list
  and revoke only their own sessions (others' ids → 404).
- Retention: ended sessions, used tokens and old idempotency rows are purged by
  `app_retention_purge` (ADR-0020).
- No JWT, no bearer tokens in browser storage (ADR-0003).

## 4. Authorization model (default deny)

Roles: `ADMIN` (company administrator — all permissions, may switch among own-company
warehouses) and `STAFF` (exactly one warehouse, explicit permission list).

| Permission                                              | Allows                                                                             | Staff-grantable     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------- |
| wms.view                                                | read stock, nodes, documents of own warehouse                                      | yes                 |
| wms.receive                                             | receive, close receipts                                                            | yes                 |
| wms.putaway                                             | putaway, internal moves, container moves                                           | yes                 |
| wms.pick / wms.pack / wms.dispatch                      | outbound execution; dispatch also decrypts recipient contact                       | yes                 |
| wms.transfer.dispatch / wms.transfer.receive            | source / destination side of transfers                                             | yes                 |
| wms.returns                                             | returns and disposition                                                            | yes                 |
| wms.count                                               | open/record/submit counts (blind)                                                  | yes                 |
| wms.count.approve                                       | approve counts (+step-up, not own count)                                           | yes                 |
| wms.adjust                                              | opening stock, adjustments, reversals and stock release (+step-up); blocking stock | yes                 |
| wms.replenish                                           | rules and replenishment moves                                                      | yes                 |
| wms.topology.manage / wms.sku.manage                    | structure / SKU master and CSV import                                              | yes                 |
| wms.inbound.manage / wms.outbound.manage                | create/edit/cancel documents, allocate, close                                      | yes                 |
| wms.report / wms.export                                 | reports / CSV export (+step-up, audited)                                           | yes                 |
| pii.read, admin.users, admin.security, admin.audit.read | administration                                                                     | **no (ADMIN only)** |

Enforcement points:

0. `AuthGuard` (before any body parsing): `/api/admin/**` requires `ADMIN`; routes with `:wh`
   refuse staff of another warehouse (404). Proven for every route by
   `tests/security/route-inventory.test.ts`.
1. `requirePermission()` in every service method (`WmsRunner` for WMS).
2. `warehouseScope()` — object-level: staff ⇒ path warehouse must equal assigned warehouse;
   admin ⇒ warehouse must belong to the admin's company and be active. Failures are 404 and
   audited (`authz.denied`, reason `warehouse_scope`).
3. Every query additionally filters by `warehouse_id`/`company_id`.
4. RLS (transaction-local context) as defence in depth; composite FKs for physical integrity.
5. Background jobs (outbox dispatcher) process each tenant inside that tenant's RLS context.

Cross-warehouse transfers: the source acts in the source scope, the destination in its own
scope; transfer documents expose only warehouse codes/names and SKU quantities.

## 5. Tests

See `docs/security/SECURITY_TEST_MATRIX.md` (auth: `tests/security/attacks.test.ts`,
`tests/security/passkeys-account.test.ts`; isolation: `tests/security/isolation.test.ts`; route
inventory: `tests/security/route-inventory.test.ts`; retention: `tests/security/retention.test.ts`;
acceptance: `tests/integration/acceptance.test.ts`, `tests/integration/wms-completion.test.ts`).
