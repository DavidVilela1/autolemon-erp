# Next tasks — ordered roadmap (WMS hardening first) — updated v0.6.3

Owning module: architecture. Each task lists dependencies and the acceptance test that closes it.
**Product-owner rule (2026-11-10):** the entire autonomous WMS must be production-ready, verified
and approved before any other ERP module starts. Status per criterion:
`docs/WMS_RELEASE_GATE.md`.

Done in v0.6.0: T-01 (passkeys), T-08 (module boundaries), T-09 (self-approval and consumed-stock
reversal tests; replenishment over-target is reported, not refused), T-10 (axe on every screen —
manual screen-reader pass still open), T-12 (retention), T-21 (units of measure), T-22 (un-pick,
un-pack), T-24 (rename/deactivate; moving subtrees still unsupported), lots through transfers
(part of T-20).

## Next three WMS tasks (gate order) — after v0.6.3

1. **S-05 code part** — security-event metrics endpoint (bounded, authenticated) and alert hooks
   for audit-chain failure / purge failure / authentication anomalies; ASVS self-assessment
   refresh.
2. **O-02** — owner confirms the `node-next` and `release-candidate` jobs; container image
   signing (cosign keyless) and a deployment workflow gated on manual approval (no deployment).
3. **E-04** — once the owner agrees targets: reproducible load harness and results.

Owner-side, in parallel: push v0.6.3; apply branch protection; KMS choice (S-03); staging
(S-04/O-01/O-03…O-05); provision the breached-password corpus; penetration test (S-07);
warehouse pilot (O-06).

Done in v0.6.3: T-26 (transfer reservations, near-expiry report), T-04 code part (offline corpus).
Done in v0.6.2: T-20 (FEFO, requested lots, serial uniqueness); O-02 workflow parts.
Done in v0.6.1: F-12 (T-27), E-05 (T-31), F-05 replenishment scan prompt, local gitleaks.

## A. Security and production-readiness (release blockers)

| Id       | Task                                                                                                                                                                                     | Depends on | Acceptance                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~T-01~~ | ✅ v0.6.0 — WebAuthn/passkeys (`@simplewebauthn/server` 14.x + browser 14.x): registration with step-up, login as second factor, admin policy "passkey required", credential list/revoke | —          | Playwright virtual-authenticator e2e (register, login, revoke); TOTP fallback still works; admins without passkey blocked from admin routes |
| T-02     | Run CI on a protected GitHub repo (Node 26 + PG 18 matrix), branch protection, CODEOWNERS                                                                                                | —          | All jobs green incl. CodeQL/Trivy/gitleaks; evidence linked in PROJECT_STATE                                                                |
| T-03     | External KMS provider (AWS KMS / Azure Key Vault / Vault Transit) behind `KeyProvider`                                                                                                   | T-02       | Integration test against a KMS emulator; rewrap job; app refuses start without KMS in production                                            |
| T-04     | ✅ code v0.6.3 (provisioning open) — Breached-password corpus (offline k-anonymity range files or HIBP via egress proxy)                                                                 | —          | Unit tests with known-breached samples                                                                                                      |
| T-05     | Staging deployment per NETWORK_AND_ZTNA (WAF, ZTNA, TLS 1.3, private DB, egress deny)                                                                                                    | T-02, T-03 | Verification checklist all ✔ with evidence                                                                                                  |
| T-06     | Off-site immutable backups (pgBackRest + object lock), WAL PITR, alerting; first quarterly restore exercise with measured RPO/RTO                                                        | T-05       | Signed exercise log                                                                                                                         |
| T-07     | DAST (ZAP baseline + authenticated full scan) in staging; fix findings                                                                                                                   | T-05       | Report with no high/critical                                                                                                                |
| ~~T-08~~ | ✅ v0.6.0 — Lint-enforced module boundaries (no imports from wms → other modules' internals; only engine writes stock tables)                                                            | —          | ESLint rule + failing fixture test                                                                                                          |
| ~~T-09~~ | ✅ v0.6.0 — Negative test: counter self-approval; reversal of already-consumed stock; replenishment over-target                                                                          | —          | New tests pass                                                                                                                              |
| T-10     | 🟡 axe done in v0.6.0 — axe checks on every screen; manual screen-reader pass (NVDA/VoiceOver); keyboard-only walkthrough                                                                | —          | No violations; findings documented in DESIGN_SYSTEM                                                                                         |
| T-11     | Load/concurrency benchmarks (k6): 50 concurrent pickers, allocation contention, ledger growth to 10 M rows                                                                               | T-02       | p95 targets documented; indexes tuned                                                                                                       |
| ~~T-12~~ | ✅ v0.6.0 — Retention jobs: command_log (90 d), expired sessions/tokens, outbox (published > 30 d)                                                                                       | —          | Scheduled job + tests                                                                                                                       |
| T-13     | Independent pentest + human security review sign-off                                                                                                                                     | T-01…T-07  | Report, all high/critical closed                                                                                                            |

## B. WMS functional hardening

| Id       | Task                                                                                                         | Acceptance                               |
| -------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| ~~T-20~~ | ✅ v0.6.2 — Lot/serial end-to-end (FEFO allocation, serial uniqueness, lot on pick/pack)                     | Acceptance flow with LOT and SERIAL SKUs |
| ~~T-21~~ | ✅ v0.6.0 — Unit-of-measure conversions on receipt/pick (box of 10 ⇒ base units via barcode `qty_per_uom`)   | Scan box barcode receives 10             |
| ~~T-22~~ | ✅ v0.6.0 — "Unpick" (return PICKED stock to shelf) and package re-open                                      | Close order after unpick                 |
| T-23     | Nested containers (pallet → boxes) with explicit rules, or keep unsupported                                  | ADR + tests                              |
| T-24     | 🟡 rename/deactivate done in v0.6.0 — Topology editing: deactivate nodes, rename, move empty subtrees safely | Tests: cannot deactivate with stock      |
| T-25     | Printing: ZPL/PDF label templates, scanner-mode full-screen picking UI for tablets                           | Field test on a real scanner             |
| ~~T-26~~ | ✅ v0.6.3 — Transfer pick lists with reservations at source (allocation before dispatch)                     | Concurrency test with outbound           |
| ~~T-27~~ | ✅ v0.6.1 (saved reports still open) — Activity search across documents; saved reports; CSV export of ledger | Tests                                    |
| T-28     | Event consumers SDK (typed event schemas, versioning policy, replay tool)                                    | Contract tests                           |

## B2. Added by the v0.6.0 session

| Id   | Task                                                                                            | Acceptance                                       |
| ---- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| T-29 | Re-map `docs/WMS_RELEASE_GATE.md` to the product owner's v0.6 checklist when provided           | Every checklist line has a status and evidence   |
| T-30 | Admin break-glass procedure for single-admin tenants (SEC-OPEN-018)                             | Runbook + staging exercise                       |
| T-31 | Operator manual (pt-PT) for warehouse staff, including scanner workflows and exception handling | Reviewed by warehouse staff                      |
| T-32 | CI: add Node 26 to the matrix; branch protection and CODEOWNERS on the GitHub repository        | Green run on Node 22 + 26 / PostgreSQL 18 linked |

## C. Later business domains (only after A, B and product-owner approval)

1. Automotive catalogue / fitment (TecDoc integration) as an extension module (relational tables).
2. Commercial: customers (encrypted PII), quotes, sales orders → creates WMS outbound requests via service API.
3. Procurement: suppliers, purchase orders → WMS expected inbound documents.
4. Certified invoicing + SAF-T (PT) + AT transport document communication (legal review mandatory).
5. Finance/accounting integration.
