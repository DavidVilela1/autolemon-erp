# ADR-0020 — Data retention through a bounded SECURITY DEFINER function

Status: Accepted (v0.6.0). Owning module: platform.

**Context.** Idempotency records, ended sessions (with IP/user-agent metadata), used one-time
tokens, published outbox events and idle throttle rows grew without bound (R-15). Granting the
runtime role `DELETE` on those tables would let a compromised process erase evidence at will.

**Decision.** Migration 0006 adds `app_retention_purge(command_log_days, session_days,
token_days, outbox_days)`, `SECURITY DEFINER` with a fixed `search_path`, `EXECUTE` granted only
to `autolemon_app`. It deletes only expired operational rows (never unpublished events, live
sessions, inventory history, documents or the audit log) and refuses any window below 7 days.
`RetentionService` calls it every 6 hours with `RETENTION_*_DAYS` (defaults 30/30/30/90) and
records an audit entry when rows were removed.

**Consequences.** The idempotency replay window equals `RETENTION_COMMAND_LOG_DAYS`. Changing what
is purged requires a reviewed migration, not a configuration change.
