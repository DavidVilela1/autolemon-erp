# Audit logging and investigation — v0.5.0

Owning module: platform/audit.

## 1. Two histories

| History                 | Table(s)                                                                             | Content                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warehouse event history | `inventory_transactions`, `inventory_ledger`, `container_movements`, document tables | Every posted movement: who (`actor_user_id`), what (type, sku, holder, status, delta), when, reference document, idempotency key, reversal link. Searchable at `/reports/ledger`.                                                                                                                                                                                |
| Security audit log      | `security_audit_log`                                                                 | Login success/failure, MFA verify, step-up, recovery-code use (alert), logout, enrolment/MFA reset/password reset, user/permission/warehouse changes, deactivation, warehouse switch, PII reads, key rotation, CSV exports, SKU imports, inventory adjustments/reversals/count approvals/transfer loss, every authorization denial (`authz.denied` with reason). |

Fields: chain key, sequence, company, timestamp (UTC ISO), actor, action, resource type/id,
warehouse, outcome (SUCCESS/DENIED/FAILURE), request id, client IP (per `TRUST_PROXY`), redacted
details. Never logged: passwords, tokens, session ids, TOTP codes/seeds, keys, full PII
(`redactDetails()` denylist + code review).

## 2. Tamper evidence

`hash = SHA-256(prev_hash ‖ canonical-JSON(entry))`, per tenant chain plus a pre-auth chain;
appends serialised by an advisory transaction lock. `GET /api/admin/audit/verify` recomputes the
chain and reports the first broken sequence (tested by simulating a superuser edit).

**Limitation:** PostgreSQL append-only controls do not stop a superuser/owner from rewriting
history consistently. Production MUST add (NOT DEPLOYED):

- periodic signed digest checkpoints (latest `seq` + `hash` per chain) exported to write-once
  storage (S3 Object Lock compliance mode or equivalent) under a separate account — **tooling
  implemented in v0.6.5** (`pnpm audit:digest keygen|create|verify`, Ed25519, ADR-0027); the
  schedule and the write-once storage are NOT DEPLOYED;
- streaming of audit rows to an external SIEM/log store with independent administrators;
- DBA access only via break-glass with its own audit trail.

## 3. Correlation and time

Every response carries `X-Request-Id` (server-generated UUID), stored in audit rows and error
envelopes, shown to users on errors for support. Hosts must use NTP (chrony) — production checklist.

## 4. Access and retention (proposal, needs DPO/legal sign-off)

- Read: `admin.audit.read` (admins). Raw DB access: DBA break-glass only.
- Retention: security audit 2 years online + archive per legal advice; app logs 90 days;
  inventory history: life of the company records (legal/tax requirements to confirm).
- Logs must not be used to reconstruct personal data beyond the stated purpose (GDPR minimisation).

## 5. Alerting

**Implemented in the application (v0.6.4, ADR-0026):** rules, dedupe, log/webhook delivery,
incremental + daily full chain verification, Segurança page. **Not deployed:** log shipping,
paging/on-call, off-site digests. Original list of signals:

Alert on: `auth.login.recovery_code_used`, `auth.mfa_reset.completed`, bursts of
`auth.login` FAILURE / 429, `authz.denied` spikes, `admin.keys.rotate`, `admin.pii.read`, audit
chain verification failure, restore test failures.
