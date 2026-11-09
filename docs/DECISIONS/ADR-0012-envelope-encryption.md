# ADR-0012 — AES-256-GCM field encryption with per-tenant envelope keys

Status: Accepted. Owning module: platform/crypto.

**Decision.** Per-tenant versioned DEKs wrapped by a KEK provider; AAD binds tenant/table/
record/field/version; fail closed; registry of encrypted fields drives rotation. Local dev
keyring provider refused in production; external KMS provider is a fail-closed stub.
**Alternatives.** pgcrypto in DB (keys reach DB server/logs); TDE only (no protection from DB
readers). **Trade-off.** Encrypted fields are not searchable (blind index if needed).
