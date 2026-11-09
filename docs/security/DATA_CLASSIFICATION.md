# Data classification — v0.5.0

Owning module: security. Classes: **Public**, **Internal**, **Confidential**, **Confidential-PII**,
**Secret**. GDPR applies to all personal data of EU data subjects; legal compliance is **not**
claimed without expert review.

| Data                                                           | Class                             | Protection now                                                                                  | Notes / future                                     |
| -------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Passwords                                                      | Secret                            | Argon2id (never reversible), redacted from logs                                                 | —                                                  |
| TOTP seeds                                                     | Secret                            | AES-256-GCM, tenant-bound AAD, never re-shown                                                   | —                                                  |
| Recovery codes, session/CSRF/one-time tokens                   | Secret                            | SHA-256 of 80–256-bit random values                                                             | —                                                  |
| KEK / DEKs / backup keys / CSRF secret                         | Secret                            | KMS (prod, not deployed) / env keyring (dev) / wrapped DEKs                                     | never in repo, archive, logs                       |
| Integration credentials (future)                               | Secret                            | Will use FieldCrypto + vault                                                                    | none exist in v0.5                                 |
| User e-mail, display name                                      | Confidential-PII                  | Access: admin.users; audit redaction of `email` keys                                            | Needed for login                                   |
| User phone                                                     | Confidential-PII                  | AES-256-GCM, `pii.read` + step-up + audit                                                       | demo of field protection                           |
| Recipient contact on outbound requests                         | Confidential-PII                  | AES-256-GCM, masked without `wms.dispatch`, excluded from exports                               | —                                                  |
| Future customer master data                                    | Confidential-PII                  | Same FieldCrypto + field masking pattern                                                        | CRM out of scope                                   |
| Contracts, commercial terms, discounts, prices, costs (future) | Confidential                      | FieldCrypto + per-field permission + export restriction; blind index only if exact match needed | Finance/Sales out of scope; no fake tables created |
| Inventory balances, ledger, documents, topology                | Internal                          | Tenant + warehouse isolation (service + RLS), append-only history                               | integrity-critical                                 |
| SKU master                                                     | Internal                          | Tenant isolation                                                                                | —                                                  |
| Security audit log                                             | Internal / integrity-critical     | Hash chain, append-only, admin.audit.read only, no secrets/PII values                           | ship off-site (prod)                               |
| Application logs                                               | Internal                          | Redaction, no bodies/query strings, request ids                                                 | retention 90 days (proposal)                       |
| Attachments / uploads                                          | Confidential                      | Only CSV import, processed in memory, not stored                                                | file storage not implemented                       |
| Backups                                                        | Confidential (contains all above) | Encrypted (local demo AES-GCM; prod pgBackRest cipher, object lock)                             | off-site NOT DEPLOYED                              |
| Exports (CSV)                                                  | Internal                          | wms.export + step-up + audit; no encrypted/PII columns; formula-safe                            | —                                                  |
| Seed / test data                                               | Public (synthetic)                | Synthetic only (`example.test`, fictitious names)                                               | no real personal data in archive                   |

Rules: no sensitive values in URLs (one-time tokens travel in the URL **fragment** and are removed
from the address bar immediately), logs, browser storage, exports, screenshots or error responses.
