# ADR-0026 — In-application security monitoring, alerts and incremental audit-chain checks

Status: Accepted (v0.6.4). Owning module: platform (monitoring). Gate S-05 code part;
SEC-OPEN-003 (monitoring part, application side).

**Context.** The audit log recorded every authentication, denial and high-risk administrative
action, but nothing looked at it: a password-spraying burst, a used recovery code or a broken
audit chain stayed silent until someone opened the Auditoria page. Retention and outbox job
failures went only to the process log. The production monitoring stack (metrics, paging, on-call)
is owner-side and not deployed (gate O-05), so the application must at least raise and deliver
its own security signals in a form any stack can consume.

**Decision.**

- **Signal source = the hash-chained audit log** (no second collection path). `SecurityMonitor`
  (`platform/monitoring/security-monitor.ts`) runs every `SECURITY_MONITOR_INTERVAL_SECONDS`
  (default 300 s) in the API process.
- **Count rules** in code (`COUNT_RULES`, reviewed and tested, not configurable per deployment):
  login failures ≥ 10/15 min (HIGH), MFA/step-up failures ≥ 10/15 min (HIGH), unknown-account
  login failures on the pre-authentication chain ≥ 50/15 min (HIGH, system), access denials
  ≥ 20/15 min (MEDIUM), any recovery-code login (MEDIUM), any MFA reset (MEDIUM), PII reads ≥ 5/h
  (MEDIUM), exports ≥ 10/h (MEDIUM), key rotation (LOW).
- **Event alerts:** `audit.chain_broken` (CRITICAL), `system.outbox_stuck` (unpublished events
  older than 15 min, MEDIUM, per company), `system.retention_failed` / `system.outbox_failed`
  (HIGH, system; at most one new alert per job per hour; only the error class is stored).
- **Deduplication:** a partial unique index allows one OPEN alert per (company, rule); a
  sustained condition refreshes it. After acknowledgement, events older than the acknowledgement
  are not counted again, so only new activity re-raises. Event alerts carry `details.key`
  (e.g. the broken sequence number) and never raise twice for the same key.
- **Delivery:** only new alerts are delivered. The log sink is always on (one `warn` line with
  `securityAlert: true`). An optional webhook (`ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_SECRET`) posts
  HMAC-SHA256-signed JSON (`X-AutoLemon-Timestamp`, `X-AutoLemon-Signature: v1=…`), 5 s timeout,
  no redirects; https only (http to loopback outside production); credentials in the URL are
  refused. Failures are stored (URL-free) and retried up to 5 times. Payloads carry no e-mail
  addresses, IPs, names or audit details.
- **Audit chain:** `verifyRange()` verifies from a checkpoint (`audit_chain_checkpoints`), at most
  20 000 entries per chain per run; every 24 h the checkpoint restarts from the genesis so a
  rewrite of old entries is still detected.
- **Admin API/UI:** `GET /api/admin/security/overview` (counters per category in a 5 min–7 day
  window, open alerts by severity, chain checkpoint, outbox backlog, channels — never the webhook
  URL), `GET /api/admin/security/alerts`, `POST /api/admin/security/alerts/{id}/ack`
  (`admin.security` + step-up `security.alert.ack`, audited, one-way). Page **Segurança**.
- **Database guards (migration 0009):** runtime role has no DELETE; UPDATE only on bookkeeping
  columns; trigger `security_alerts_guard` forbids reopening and changing an acknowledgement or
  alert identity. System alerts (`company_id` NULL) are never listed to a company.

**Alternatives.** Prometheus `/metrics` endpoint (needs a non-session credential and a deployed
scraper — deferred until the owner picks the stack); database triggers that raise alerts on
insert (puts threshold logic in SQL and adds latency to every audited request); per-deployment
configurable thresholds (harder to review; changes need a test instead).

**Consequences / maintenance.** New security-relevant audit actions should be added to a rule or
to `OVERVIEW_GROUPS` with a test. The monitor runs in each API process; with several replicas the
unique index keeps one open alert, but delivery of the same new alert by two replicas in the same
second is possible (receivers must be idempotent on `alert.id`). A burst inside one company
counts against the whole company, not per user/IP (no PII in alert state). This does not replace
infrastructure monitoring, paging/on-call or off-site audit digests (SEC-OPEN-003/008, O-05).
