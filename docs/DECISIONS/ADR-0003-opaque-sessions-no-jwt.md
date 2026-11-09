# ADR-0003 — Opaque server-side sessions, no JWT

Status: Accepted. Owning module: platform/auth.

**Decision.** 256-bit random cookie tokens (`__Host-`, HttpOnly, Secure, SameSite=Strict),
SHA-256 stored, idle/absolute expiry, immediate revocation; no bearer tokens in browser storage.
**Alternatives.** JWT access/refresh (rejected: revocation complexity, algorithm/issuer
validation pitfalls, token theft via XSS if stored in JS).
**Consequences.** One DB lookup per request (indexed by unique hash); revocation is instant.
CSRF protection required (ADR-0017).
