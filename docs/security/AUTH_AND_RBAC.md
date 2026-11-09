# Authentication, MFA, sessions, RBAC and tenant isolation — v0.5.0

Owning module: platform/auth, platform/authz. References: NIST SP 800-63B-4, OWASP ASVS 5.0.0,
OWASP Password Storage / Session Management / CSRF cheat sheets.

## 1. Passwords

- Argon2id via `@node-rs/argon2` 2.2.2, per-hash 16-byte random salt (library), PHC string.
- Defaults **m = 64 MiB, t = 3, p = 1** (above OWASP minimum m=19 MiB,t=2). Measured on the build
  VM: m=19 MiB/t=2 ≈ 11–14 ms per hash; the default is proportionally slower. Tune
  `ARGON2_MEMORY_KIB`/`ARGON2_ITERATIONS` on production hardware (target 100–500 ms).
- `needsRehash()` upgrades stored hashes after a successful login when parameters increase.
- Policy: 12–128 chars, any Unicode, no composition rules; rejected if in the local common/
  breached list, containing the e-mail local part or app name, or trivially repetitive.
- Anti-enumeration: unknown accounts still run one Argon2 verification against a startup-generated
  dummy hash; one generic error for unknown user / wrong password / disabled / not enrolled.
- Never logged: request body fields `password`, `token`, `code`, `recoveryCode` are redacted.

## 2. MFA

| Factor                                          | Status              | Notes                                                                                |
| ----------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step) | Implemented+Tested  | Seed AES-256-GCM encrypted; replay blocked via `last_used_step` (conditional update) |
| Recovery codes (10 × 80-bit)                    | Implemented+Tested  | SHA-256 stored; single use; use audited as alert                                     |
| WebAuthn / passkeys (phishing-resistant)        | **Not implemented** | Highest-priority next task (T-01); required for admins before production             |
| SMS / e-mail OTP                                | Not offered         | Deliberately excluded                                                                |

MFA is **mandatory** for every account: a user without a confirmed factor cannot log in.
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
- Step-up: `POST /api/auth/step-up` with a fresh TOTP stamps the session; valid 5 min for:
  role change (admin creation), warehouse re-assignment, MFA reset, password reset, key
  rotation, CSV export, inventory adjustment, count approval, PII read.
- No JWT, no bearer tokens in browser storage (ADR-0003).

## 4. Authorization model (default deny)

Roles: `ADMIN` (company administrator — all permissions, may switch among own-company
warehouses) and `STAFF` (exactly one warehouse, explicit permission list).

| Permission                                              | Allows                                                       | Staff-grantable     |
| ------------------------------------------------------- | ------------------------------------------------------------ | ------------------- |
| wms.view                                                | read stock, nodes, documents of own warehouse                | yes                 |
| wms.receive                                             | receive, close receipts                                      | yes                 |
| wms.putaway                                             | putaway, internal moves, container moves                     | yes                 |
| wms.pick / wms.pack / wms.dispatch                      | outbound execution; dispatch also decrypts recipient contact | yes                 |
| wms.transfer.dispatch / wms.transfer.receive            | source / destination side of transfers                       | yes                 |
| wms.returns                                             | returns and disposition                                      | yes                 |
| wms.count                                               | open/record/submit counts (blind)                            | yes                 |
| wms.count.approve                                       | approve counts (+step-up, not own count)                     | yes                 |
| wms.adjust                                              | opening stock, adjustments (+step-up), reversals             | yes                 |
| wms.replenish                                           | rules and replenishment moves                                | yes                 |
| wms.topology.manage / wms.sku.manage                    | structure / SKU master and CSV import                        | yes                 |
| wms.inbound.manage / wms.outbound.manage                | create/edit/cancel documents, allocate, close                | yes                 |
| wms.report / wms.export                                 | reports / CSV export (+step-up, audited)                     | yes                 |
| pii.read, admin.users, admin.security, admin.audit.read | administration                                               | **no (ADMIN only)** |

Enforcement points:

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

See `docs/security/SECURITY_TEST_MATRIX.md` (auth: `tests/security/attacks.test.ts`; isolation:
`tests/security/isolation.test.ts`; acceptance: `tests/integration/acceptance.test.ts`).
