# Encryption and key management — v0.6.6

Owning module: platform/crypto. Password hashing (Argon2id) is **not** encryption and is covered
in `AUTH_AND_RBAC.md`.

## 1. Application-level field encryption

- Algorithm: AES-256-GCM (Node.js `crypto`, OpenSSL). 96-bit CSPRNG nonce per value, 128-bit tag.
- Envelope: `alenc1.<keyVersion>.<b64url nonce>.<b64url ciphertext‖tag>` stored in `text`.
- AAD: `autolemon|field|v1|company:<id>|table:<t>|record:<id>|field:<f>|key:<version>` — moving a
  ciphertext to another tenant, row or column fails authentication (tested).
- Fail closed: any parse/authentication/key error ⇒ `DecryptionError` ⇒ HTTP 500
  `DECRYPTION_FAILED`; never plaintext fallback.
- Encrypted fields today (`ENCRYPTED_FIELDS`): `users.phone_enc` (PII), `mfa_totp.secret_enc`
  (MFA seed), `outbound_orders.recipient_contact_enc` (possible PII).
- Access: phone ⇒ `pii.read` + step-up + audit; recipient ⇒ `wms.dispatch` (masked otherwise);
  TOTP seeds ⇒ never returned after enrolment.
- Limits: encrypted columns are not searchable/sortable. If exact-match lookup is ever required,
  add a separate HMAC-SHA256 blind index with its own tenant-scoped key, never a plaintext mirror.
  Future commercial terms (prices/discounts) follow the same pattern; calculations happen in the
  service after authorised decryption, results are not persisted in plaintext.

## 2. Envelope keys

| Key | Scope                 | Storage                                                                                     | Rotation                                                                                                                                 |
| --- | --------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| DEK | per tenant, versioned | `tenant_data_keys.wrapped_dek` (wrapped, AAD = company+version+KEK id)                      | `POST /api/admin/keys/rotate` (step-up): new ACTIVE version, re-encrypt all registered fields; old versions RETIRED but kept for backups |
| KEK | platform              | **Production: KMS/HSM/vault (not implemented/deployed)**; dev: `LOCAL_DEV_KEKS` env keyring | add new KEK first in keyring ⇒ `rewrapAllDeks()` ⇒ remove old KEK after backup retention                                                 |

Providers (`key-provider.ts`): `LocalDevKeyProvider` (UNSAFE FOR PRODUCTION; refused when
`NODE_ENV=production`), `ExternalKmsProvider` (stub, fails closed — NOT DEPLOYED). Dev secrets are
generated into `.env` on first run, never committed or packaged; the release script refuses to
package if any are found.

## 3. In transit

- Production requirement: TLS 1.3 browser→proxy, proxy→app, app→Postgres (`DB_SSL=verify-full`
  enforced by config validation), app→KMS. TLS 1.2 only with a documented exception.
- HSTS sent by the API in production and by the proxy template.
- Local development uses plain HTTP/TCP on localhost only (not hardened).

## 4. At rest

- Production requirement: encrypted DB volumes/snapshots (provider-managed keys or CMK),
  encrypted object storage, encrypted backups with an independent key path. **NOT DEPLOYED.**
- Local demo backups: AES-256-GCM with `.local/backup.key` (separate from `backups/`).

## 5. Procedures

- **DEK rotation**: admin step-up → rotate → verify via `GET /api/admin/users/{id}/pii` and a
  step-up (TOTP seed decrypt) → record in change log.
- **KEK rotation**: provision new KEK in KMS → deploy keyring with new KEK first and old second →
  run rewrap job → verify `SELECT DISTINCT kek_id FROM tenant_data_keys` → keep old KEK disabled
  (not destroyed) until every backup encrypted under it expires.
- **Backup of keys**: KMS keys have their own backup/replication policy and a separate recovery
  role; never store KEKs alongside database backups.
- **Incident (suspected key compromise)**: rotate KEK and all DEKs, re-encrypt, revoke sessions,
  review audit log, assess GDPR Art. 33 notification with the DPO.

## 6. Tests (`tests/security/crypto.test.ts`)

Ciphertext ≠ plaintext and differs per encryption; tamper of nonce/ciphertext/version detected;
tenant/record/field binding; wrong KEK cannot unwrap; DEK rotation re-encrypts stored fields and
MFA keeps working; old-version ciphertext still decrypts; KEK rewrap; production refuses
`local-dev`. `restore:smoke` decrypts every encrypted field of the restored database.

## 7. Cryptographic inventory (ASVS 5.0 V11.1.2) and key lifecycle (V11.1.1)

| Use                               | Algorithm / parameters                                                                                  | Key / secret                            | Where it must NOT be used               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------- |
| Field encryption (PII, TOTP seed) | AES-256-GCM, 96-bit random nonce, 128-bit tag, AAD                                                      | per-tenant DEK (versioned)              | anything outside `FieldCrypto`          |
| DEK wrapping                      | AES-256-GCM (local dev) / KMS (production, not deployed)                                                | KEK (keyring / KMS)                     | data encryption directly                |
| Password storage                  | Argon2id, m=64 MiB, t=3, p=1, 16-byte salt                                                              | —                                       | —                                       |
| Session / one-time / CSRF tokens  | 256-bit CSPRNG; stored as SHA-256                                                                       | —                                       | —                                       |
| CSRF token binding                | HMAC-SHA256                                                                                             | `CSRF_SECRET`                           | any other MAC                           |
| Recovery codes                    | 120-bit CSPRNG (legacy 80-bit until regenerated); stored as SHA-256                                     | —                                       | —                                       |
| TOTP                              | RFC 6238 HMAC-SHA-1, 6 digits, 30 s (authenticator compatibility; HMAC-SHA-1 remains approved for HMAC) | per-user seed (encrypted)               | new designs                             |
| Passkeys                          | WebAuthn (ES256/EdDSA/RS256 via @simplewebauthn)                                                        | authenticator keys (public part stored) | —                                       |
| Audit chain                       | SHA-256 over canonical JSON                                                                             | —                                       | —                                       |
| Audit digests                     | Ed25519 signatures                                                                                      | operator-held digest key (ADR-0027)     | the API host                            |
| Alert webhook                     | HMAC-SHA256 over timestamp.body                                                                         | `ALERT_WEBHOOK_SECRET`                  | —                                       |
| Breached-password lookup          | SHA-1 as a lookup key only (HIBP format), not security                                                  | —                                       | any integrity/confidentiality purpose   |
| Common-password list              | SHA-256 prefixes (lookup only)                                                                          | —                                       | —                                       |
| Backups (local demo)              | AES-256-GCM                                                                                             | `.local/backup.key`                     | production (use provider backups + CMK) |
| Transport                         | TLS 1.3 (1.2 by exception), `DB_SSL=verify-full`                                                        | certificates (deployment)               | — (NOT DEPLOYED)                        |

Lifecycle (NIST SP 800-57 phases): **generation** (CSPRNG/KMS only) → **activation** (keyring
order / ACTIVE DEK version) → **use** (purpose-bound, AAD binds tenant+record+field) →
**rotation** (DEK yearly or on suspicion; KEK yearly via rewrap; digest key on staff change) →
**suspension/retirement** (RETIRED DEKs kept for backup restore) → **destruction** only after the
longest backup retention that may need the key. Keys are never shared between purposes, never
logged, never in the repository or archive. Agility: algorithms are identified by version fields
(DEK version + KEK id, PHC strings for passwords, digest format version), so a replacement can be
introduced alongside the old one and data migrated by re-encryption/rehash.
