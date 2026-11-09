# ADR-0017 — CSRF: HMAC-derived synchronizer token + origin checks

Status: Accepted. Owning module: platform/http.

**Decision.** Token = HMAC-SHA256(CSRF_SECRET, session id), returned in JSON (never cookie/URL),
kept in SPA memory, re-issued by GET /auth/session after reload; stored as SHA-256 for
constant-time compare. Plus Origin = WEB_ORIGIN, Sec-Fetch-Site ≠ cross-site, mandatory
`X-Requested-With`, SameSite=Strict cookie, and no CORS.
**Alternative.** Double-submit cookie (weaker if subdomains are compromised).
