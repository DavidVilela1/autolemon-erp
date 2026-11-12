# Operations — AutoLemon ERP v0.6.4

Owning module: operations. **Production deployment is not configured and not approved.** This
document describes how the system is configured and operated, and what must exist first.

## 1. Configuration (environment variables)

Validated at startup by `apps/api/src/config/env.ts` (invalid ⇒ process exits).

| Variable                                                                        | Default                    | Production rule                                                                                                                               |
| ------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                      | development                | `production`                                                                                                                                  |
| `APP_DATABASE_URL`                                                              | —                          | `autolemon_app` role, from secrets manager                                                                                                    |
| `DATABASE_URL`                                                                  | —                          | owner role, **only** for the migration job                                                                                                    |
| `DB_SSL`, `DB_SSL_CA_FILE`                                                      | disable                    | must be `verify-full` (enforced)                                                                                                              |
| `DB_POOL_MAX`                                                                   | 10                         | size to DB connection budget                                                                                                                  |
| `API_HOST`, `API_PORT`                                                          | 127.0.0.1, 3000            | private interface                                                                                                                             |
| `WEB_ORIGIN`                                                                    | http://localhost:5173      | exact https origin (enforced https)                                                                                                           |
| `TRUST_PROXY`                                                                   | false                      | proxy IPs/CIDRs only; `true` refused                                                                                                          |
| `COOKIE_SECURE`                                                                 | true                       | must be true                                                                                                                                  |
| `SESSION_IDLE_MINUTES` / `SESSION_ABSOLUTE_HOURS` / `STEP_UP_MINUTES`           | 30 / 12 / 5                | policy                                                                                                                                        |
| `WEBAUTHN_RP_ID`                                                                | host of WEB_ORIGIN         | registrable domain of WEB_ORIGIN                                                                                                              |
| `ADMIN_PASSKEY_REQUIRED`                                                        | false                      | must be true (admins: passkey only)                                                                                                           |
| `KEY_PROVIDER`                                                                  | local-dev                  | `external-kms` (local-dev refused)                                                                                                            |
| `LOCAL_DEV_KEKS`, `CSRF_SECRET`                                                 | generated in dev           | CSRF secret from vault; no dev keyring                                                                                                        |
| `ARGON2_MEMORY_KIB` / `ARGON2_ITERATIONS`                                       | 65536 / 3                  | benchmark on target hardware                                                                                                                  |
| `ENABLED_MODULES`                                                               | wms                        | unknown modules refused                                                                                                                       |
| `LOG_LEVEL`                                                                     | info                       | info                                                                                                                                          |
| `AUTH_THROTTLE_ENABLED`                                                         | true                       | must be true                                                                                                                                  |
| `RETENTION_COMMAND_LOG_DAYS` / `_SESSION_DAYS` / `_TOKEN_DAYS` / `_OUTBOX_DAYS` | 30 / 30 / 30 / 90          | ≥ 7 each; align with the records of processing (GDPR)                                                                                         |
| `BREACHED_PASSWORD_CORPUS`                                                      | unset (built-in list only) | path to the offline SHA-1 corpus built with `scripts/prepare-breached-corpus.mjs` (ADR-0025); read-only to the API user; refresh periodically |
| `SECURITY_MONITOR_INTERVAL_SECONDS`                                             | 300                        | 60–300; security rules, audit-chain checkpoints and alert delivery (ADR-0026)                                                                 |
| `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_SECRET`                                     | unset (log sink only)      | https endpoint of the SIEM/pager bridge (no credentials in the URL); secret ≥ 32 chars from the secrets manager; allow this egress only       |

## 2. Deployment outline (when approved)

1. Provision network per `docs/security/NETWORK_AND_ZTNA.md`, DB per `infra/postgres/*`.
2. Create roles out of band: owner (migrations), `autolemon_app` (LOGIN, strong password, no
   superuser/bypassrls), backup role.
3. Run migrations as a one-off job with `DATABASE_URL` (owner); app never receives owner creds.
4. Provision the first tenant with an operator script based on `provisionTenant()`
   (company + warehouses + first admin invitation); deliver the invitation link out of band.
5. Deploy API image (non-root, read-only) and static web build behind the proxy.
6. Post-deploy smoke: `/api/health`, login + MFA with a test account, `/stock/reconciliation`.

## 2a. Data retention

The API runs `app_retention_purge` every 6 hours (ADR-0020). It deletes only: idempotency rows
older than `RETENTION_COMMAND_LOG_DAYS` (the replay window ends there), sessions that ended more
than `RETENTION_SESSION_DAYS` ago, used/expired one-time tokens older than `RETENTION_TOKEN_DAYS`,
outbox events **published** more than `RETENTION_OUTBOX_DAYS` ago, and idle throttle rows. It
never touches inventory history, documents or the security audit log. Each run that deleted rows
writes `system.retention.purge` to the audit log; failures are logged as `retention purge failed`
(alert on it once monitoring exists).

## 3. Monitoring

**In the application (v0.6.4, ADR-0026):** the security monitor raises alerts from the audit log
(login/MFA failure bursts, access-denied spikes, recovery-code use, MFA resets, PII-read and
export bursts, key rotation, broken audit chain, stuck outbox, failed retention/outbox jobs). Every
new alert is one `warn` log line with `securityAlert: true` — route that to paging — and,
optionally, a signed webhook. Administrators see and acknowledge alerts in **Segurança**.

**Still to deploy (owner-side, gate O-05):** the items below, log shipping, paging/on-call.

Metrics: request rate/latency/error by route, 401/403/429 rates, DB pool saturation, outbox
backlog (`SELECT count(*) FROM domain_outbox WHERE published_at IS NULL`), last backup age, WAL
archive lag, reconciliation mismatches (must be 0). Alerts per `AUDIT_LOGGING.md` §5.

## 4. Log policy

Structured JSON (pino via Fastify) with redaction of cookies, authorization, CSRF and
idempotency headers, and body secret fields; request logs contain method, path (no query string),
status, request id. No stack traces in responses. Ship to central store; retention 90 days.

## 5. Patching

Weekly base-image rebuild; monthly dependency review; emergency path for critical advisories
(72 h). Re-run `pnpm test:all` + `security:scan` + restore smoke before every release.

## 6. Incident handling (outline)

Detect (alerts, audit verify failure) → triage (severity, scope via audit/ledger) → contain
(revoke sessions: `UPDATE sessions SET revoked_at=now()`; disable users; block at ZTNA/WAF) →
eradicate → recover (restore per BACKUP_AND_DR) → post-incident review; GDPR breach assessment
with DPO within 72 h.

## 7. Upgrades and rollback

- Migrations are forward-only; every release must be compatible with the previous app version
  for one deploy (expand → migrate → contract pattern).
- Rollback = redeploy previous image; never edit applied migrations (checksum guard aborts).
- Before upgrade: backup + restore smoke; after: reconciliation endpoint must return empty lists.

## 8. Useful operator queries

```sql
-- Ledger reconciliation (must return 0 rows)
SELECT p.id FROM stock_positions p LEFT JOIN inventory_ledger l ON l.position_id = p.id
GROUP BY p.id HAVING p.qty_on_hand <> coalesce(sum(l.qty_delta), 0);
-- Active sessions per user
SELECT user_id, count(*) FROM sessions WHERE revoked_at IS NULL AND absolute_expires_at > now() GROUP BY 1;
```
