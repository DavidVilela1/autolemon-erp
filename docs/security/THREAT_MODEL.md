# Threat model — AutoLemon ERP v0.6.2 (WMS)

Owning module: security. Method: STRIDE per trust boundary + abuse cases. Owner column names the
role accountable for the residual risk (to be assigned to people before any production rollout).
Status values: **Implemented+Tested**, **Implemented (untested)**, **Planned**, **Not deployed**.

## 1. System boundary and assets

```mermaid
flowchart LR
  U[Warehouse staff / Admin<br/>browser + scanner] -->|TB1: Internet → ZTNA/WAF| P[Reverse proxy]
  P -->|TB2: proxy → app (private, TLS)| A[API process]
  A -->|TB3: app → DB (private, TLS)| D[(PostgreSQL)]
  A -->|TB4: app → KMS| K[KMS / secrets vault]
  D -->|TB5: backups → off-site| B[(Object-locked backup store)]
  CI[CI/CD] -->|TB6: build → registry → deploy| A
```

| Asset                                                                                   | Classification                            | Where                   |
| --------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------- |
| Inventory balances, ledger, documents                                                   | Internal-confidential, integrity-critical | DB                      |
| Credentials (password hashes), TOTP seeds, recovery codes, session/CSRF/one-time tokens | Secret                                    | DB (hashed / encrypted) |
| PII (user phone, recipient contacts), future customer data                              | Confidential personal data (GDPR)         | DB (AES-GCM)            |
| Encryption keys (KEK, DEKs)                                                             | Secret                                    | KMS / wrapped in DB     |
| Security audit log                                                                      | Integrity-critical                        | DB (+ off-site in prod) |
| Backups                                                                                 | Confidential                              | Off-site store (prod)   |
| Source, CI secrets, signing keys                                                        | Secret / integrity                        | Git host, CI            |

## 2. STRIDE by boundary

| #   | Threat                                           | Boundary      | Mitigation                                                                                                                                                                                       | Status                                                        |
| --- | ------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| S1  | Stolen password                                  | TB1           | Mandatory TOTP MFA for every account; password-only session has no access; throttling + backoff; Argon2id                                                                                        | Implemented+Tested                                            |
| S2  | Phishing of TOTP                                 | TB1           | Passkeys (origin-bound WebAuthn) for login and step-up; admins passkey-only in production (`ADMIN_PASSKEY_REQUIRED`); TOTP remains for staff; wrong-origin/RP-id assertions rejected (tested)    | **Implemented+Tested**                                        |
| S3  | Session theft / fixation                         | TB1           | Opaque 256-bit tokens, SHA-256 at rest, HttpOnly+Secure+SameSite=Strict `__Host-` cookie, rotation after MFA, idle 30 min / absolute 12 h, revoke on logout/reset/deactivation/permission change | Implemented+Tested                                            |
| S4  | MFA enrolment hijack with stolen password        | TB1           | Enrolment only via admin-issued one-time token; MFA reset needs token **and** current password                                                                                                   | Implemented+Tested                                            |
| T1  | Forged warehouse movements (direct API)          | TB1/TB2       | Default-deny permissions, object-level warehouse scope, barcode verification, state machines, strict DTOs                                                                                        | Implemented+Tested                                            |
| T2  | Ledger/audit tampering by insider with DB access | TB3           | Append-only triggers + no grants; hash-chained audit; off-site WORM shipping                                                                                                                     | Triggers/chain Implemented+Tested; off-site **Not deployed**  |
| T3  | Mass assignment                                  | TB2           | `.strict()` DTOs, server-owned fields never accepted                                                                                                                                             | Implemented+Tested                                            |
| T4  | Duplicate/replayed commands                      | TB2           | Idempotency keys, conditional updates, row locks                                                                                                                                                 | Implemented+Tested                                            |
| R1  | Repudiation of adjustments/approvals             | TB2           | Audit log with actor, request id, IP; four-eyes count approval                                                                                                                                   | Implemented+Tested                                            |
| I1  | IDOR/BOLA across warehouses                      | TB2           | `warehouseScope()` on every WMS call; 404 for out-of-scope; RLS defence in depth                                                                                                                 | Implemented+Tested                                            |
| I2  | Multi-tenant leak                                | TB2/TB3       | company from session only; composite FKs; RLS; tests with two tenants                                                                                                                            | Implemented+Tested                                            |
| I3  | SQL injection                                    | TB3           | Parameterised Drizzle `sql`; raw SQL allowlist gate in `security:scan`                                                                                                                           | Implemented+Tested                                            |
| I4  | XSS (stored hostile text)                        | TB1           | React escaping, no `dangerouslySetInnerHTML` (lint + scan), strict CSP, JSON API with `default-src 'none'`                                                                                       | Implemented+Tested (e2e)                                      |
| I5  | Sensitive data in logs/exports/errors            | all           | Log redaction paths, minimal req serialiser, audit key redaction, no stack traces, exports exclude encrypted fields                                                                              | Implemented+Tested (partially: log content reviewed manually) |
| I6  | Decryption by unauthorised users                 | TB2           | `pii.read` + step-up + audit; recipient masked without `wms.dispatch`; AAD binds tenant/record/field                                                                                             | Implemented+Tested                                            |
| I7  | Backup theft                                     | TB5           | Encrypted backups (local demo AES-GCM; prod pgBackRest repo cipher + object lock), keys in separate path                                                                                         | Local Implemented+Tested; prod **Not deployed**               |
| D1  | Login brute force / credential stuffing          | TB1           | Per-email and per-IP DB throttles with exponential backoff, anti-enumeration timing                                                                                                              | Implemented+Tested                                            |
| D2  | Resource exhaustion                              | TB2           | Body 256 KB (CSV 1 MB), row/col limits, pagination caps, statement timeout 15 s, per-IP limiter                                                                                                  | Implemented (load not tested)                                 |
| E1  | Staff escalating to admin                        | TB2           | Admin-only permissions stripped for STAFF (service + auth), role change requires step-up                                                                                                         | Implemented+Tested                                            |
| E2  | CSRF                                             | TB1           | Synchronizer token + Origin/Fetch-Metadata + custom header + SameSite=Strict                                                                                                                     | Implemented+Tested                                            |
| E3  | SSRF                                             | TB2           | No outbound HTTP from the API; no URL-fetching features                                                                                                                                          | N/A by design (re-review when integrations arrive)            |
| E4  | Path traversal / malicious uploads               | TB2           | Only CSV text import, parsed in memory, no files written; NUL/size/row/col/formula checks                                                                                                        | Implemented+Tested                                            |
| E5  | Vulnerable dependency / compromised package      | TB6           | Exact pins, lockfile, pnpm supply-chain policy, `pnpm audit`, SBOM, license gate                                                                                                                 | Implemented (local); Trivy/CodeQL in CI **untested**          |
| E6  | Compromised CI                                   | TB6           | SHA-pinned actions, read-only default token, no deploy job, no long-lived cloud secrets                                                                                                          | Config written; **not executed**                              |
| E7  | Ransomware                                       | TB3/TB5       | Immutable off-site backups, isolated backup identity, restore drills                                                                                                                             | **Not deployed**; procedures documented                       |
| E8  | Insecure deserialisation / prototype pollution   | TB2           | JSON only, Fastify `onProtoPoisoning: 'error'`                                                                                                                                                   | Implemented+Tested                                            |
| E9  | Open redirect                                    | TB1           | No redirect endpoints; `redirect: 'error'` in client                                                                                                                                             | N/A                                                           |
| E10 | CSV formula injection                            | export/import | Export quoting + apostrophe prefix; import rejects formula cells                                                                                                                                 | Implemented+Tested                                            |

## 3. Abuse cases (tested unless stated)

1. Porto operator edits the URL to Lisboa's warehouse id → 404 + `authz.denied` audit.
2. Company B admin replays Company A's ids in reads and writes → 404.
3. Operator scans a different product during picking → 409 `BARCODE_MISMATCH`.
4. Double-click / network retry on dispatch → same Idempotency-Key ⇒ applied once.
5. Two clerks allocate the last units simultaneously → total reserved never exceeds free stock.
6. Counter approves own count → 409 `SEGREGATION_OF_DUTIES`.
7. Insider with superuser edits an audit row → chain verification reports the broken sequence
   (but a superuser could rewrite the whole chain ⇒ off-site digests required).
8. Attacker with password only → cannot reach any WMS data; 5 wrong codes revoke the pending session.
9. Malicious CSV with `=HYPERLINK(…)` → import rejected, nothing written.

## 4. Residual risks and owners

| Risk                                           | Residual                                        | Owner (role)      | Treatment                                                                        |
| ---------------------------------------------- | ----------------------------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| Staff may still use TOTP (phishable)           | Medium (staff permissions are warehouse-scoped) | Security lead     | Encourage passkeys for staff; consider extending the policy after field feedback |
| No independent pentest / DAST executed         | High                                            | Security lead     | Mandatory release gate                                                           |
| WAF/ZTNA/KMS/TLS/off-site backups not deployed | High                                            | Platform/ops lead | Deploy + verify per NETWORK_AND_ZTNA / BACKUP_AND_DR                             |
| Superuser can rewrite DB history               | Medium                                          | DBA + security    | Off-site WORM audit digests, separation of duties                                |
| Local dev key provider                         | Low (refused in production config)              | Platform lead     | External KMS provider implementation (T-03)                                      |
| Performance/DoS under load untested            | Medium                                          | Engineering       | Load tests (T-11)                                                                |
| Breached-password corpus is a small local list | Medium                                          | Security lead     | HIBP k-anonymity via egress proxy or offline corpus (SEC-OPEN-004)               |

## v0.6.1 changes to the attack surface

- **Search** (`…/search`): new read path over documents/SKUs/locations. Threats: cross-warehouse
  enumeration (mitigated: route guard + warehouse predicates in every branch, tested), wildcard
  abuse/expensive scans (literal matching, 2–64 chars, 10 rows per kind), injection (bound
  parameters). PII is not searchable.
- **Activity export**: bulk exfiltration (wms.export + step-up + audit with filters and row
  count, ≤ 366 days, 100 000-row cap), CSV formula injection (cell neutralisation; plain numbers
  only are left numeric).
- **MFA reset** now revokes passkeys — closes the "stolen passkey survives reset" path.

## v0.6.2 changes

- New SECURITY DEFINER trigger `wms_serial_guard`: it bypasses RLS to see all warehouses of the
  company, so it is restricted to reads of rows with the same `company_id`, has a fixed
  `search_path`, `EXECUTE` revoked from PUBLIC, and only raises errors (no writes).
- `sku_lots`: company-scoped RLS; runtime role can only insert and fill a missing expiry.
- CI release job gets `id-token: write` + `attestations: write` only in that job, only on `main`,
  only after every other job passed; no deployment credentials exist.

## v0.6.3 changes

- Transfer reservations (`POST …/transfers/{id}/allocate`): source-warehouse only; the
  destination sees reserved quantities but not source positions (RLS); concurrent allocations are
  serialised by row locks in id order (no over-reservation; tested).
- Offline breached-password corpus: local file, no network; malformed files refuse start-up.

## v0.6.4 changes (security monitoring, ADR-0026)

- New egress (optional): alert webhook. Threats: SSRF (URL from configuration only, never from a
  request), credential leakage (credentials in the URL refused; stored errors are URL-free),
  spoofed alerts at the receiver (HMAC signature + timestamp), data leakage (payload has no
  PII), slow receiver (5 s timeout, no redirects, bounded retries).
- Alert tampering by a compromised admin session: acknowledging needs `admin.security` + step-up,
  is audited, one-way (trigger) and cannot delete alerts; the raise itself is in the audit chain.
- Alert flooding / audit flooding: one open alert per (company, rule); job failures at most one
  new alert and one audit entry per job per hour.
- Detection gap for old tampered entries: closed by the daily full pass from the genesis.
- Residual: a database superuser can still rewrite the chain consistently and the checkpoints
  (SEC-OPEN-008 — off-site digests).
