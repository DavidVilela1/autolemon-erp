# ADR-0029 — Control-bypass signals in the audit trail; recorded identity check for recovery

Status: Accepted (v0.6.7). Owning module: platform (audit, admin). Closes ASVS 5.0 V16.3.3 and
V6.4.4 (both "P" in the v0.6.6 assessment, ADR-0028).

## 1. Control-bypass signals (V16.3.3)

**Context.** Authorization denials were audited, but rejected input (400), oversized or
unsupported bodies (413/415) and throttling (429) only reached the application log. Those are the
footprints of fuzzing, probing and brute force. One audit row per rejected request would let an
attacker flood the hash-chained log and the monitor.

**Decision.**

- One place records them: the Fastify `onSend` hook (`hardening.ts`) sees every 400/413/415/429
  whatever produced it (Zod validation, the JSON/content-type parsers, the auth throttle, the
  per-IP limiter). The Nest exception filter only tags the request with its domain error code.
- `SecuritySignals` (`platform/audit/security-signals.ts`) writes `security.input_rejected` /
  `security.rate_limited` for the **first** event per (signal, company, user, client IP) in a
  5-minute window, then **one summary** (`suppressedEvents`) when the window ends (periodic flush,
  and on shutdown). At most 10 000 open windows; beyond that new sources are counted into one
  `security.signals_overflow` entry. Details hold the route template and error code only — never
  the URL, query or body.
- Requests rejected before the session is resolved (body parsers, per-IP limiter) are keyed by
  client IP on the pre-authentication chain (no actor).
- Monitor rules: `security.probing` (≥ 10 rows in 15 min for a company, MEDIUM) and
  `security.unauthenticated_probing` (≥ 20 rows in 15 min on the pre-authentication chain,
  MEDIUM). Because rows are already rate-limited, 10 rows mean many sources or a sustained run.
  Overview counter `controlBypass`.
- Detail keys avoid `code`/`session*`, which the audit writer redacts (`errorCode`,
  `revokedCount`).

**Consequences.** Error responses that open a new window wait for one audit insert; suppressed
events cost a map update. Counts are per API process. The audit trail shows _that_ and _where_
probing happened, not the payloads (privacy, log-injection safety).

## 2. Identity check for account recovery (V6.4.4)

**Decision.** `POST /api/admin/users/{id}/mfa-reset` and `…/password-reset` now require
`{ method: IN_PERSON | VIDEO_CALL | KNOWN_PHONE_CALLBACK | MANAGER_CONFIRMATION, reference }`
(reference 5–120 characters, no personal data by instruction). Both are written into the audit
entry (`identityVerification`, `verificationReference`). An administrator can no longer recover
their **own** account (`409 SELF_RECOVERY_FORBIDDEN`): enrolment is always done by an
administrator for someone else, so recovery needs the same — a second administrator, or the
last-administrator procedure (RUNBOOKS §3). The UI shows a short form before the step-up.

**Alternatives.** Free-text only (not reviewable); a two-administrator approval workflow (better
assurance, but blocks single-admin sites; possible later on top of the recorded method).

**Consequences / compatibility.** Breaking API change for the two endpoints (body now required);
the only client is the bundled SPA, updated in the same version. The full administrator-issued
password-reset flow is now covered end to end by a test (it was previously claimed as tested
without a dedicated test — corrected in the ASVS assessment).
