# ADR-0011 — Mandatory MFA; TOTP first, WebAuthn next

Status: Accepted; WebAuthn part superseded by ADR-0019 (v0.6.0). Owning module: platform/auth.

**Decision.** TOTP implemented on node:crypto (RFC vectors tested) with replay protection,
recovery codes, enrolment only via one-time admin tokens. WebAuthn deferred to T-01 because a
correct implementation plus a virtual-authenticator test could not be completed in this
iteration without compromising the tested core.
**Risk.** TOTP is phishing-susceptible → production blocked until WebAuthn (SEC-OPEN-001).
