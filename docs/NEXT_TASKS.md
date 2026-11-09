# Next tasks — ordered roadmap (WMS hardening first)

Owning module: architecture. Each task lists dependencies and the acceptance test that closes it.
Business domains (catalog, commercial, procurement, finance) come only after the hardening block.

## A. Security and production-readiness (release blockers)

| Id   | Task                                                                                                                                                                         | Depends on | Acceptance                                                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| T-01 | WebAuthn/passkeys (`@simplewebauthn/server` 14.x + browser 14.x): registration with step-up, login as second factor, admin policy "passkey required", credential list/revoke | —          | Playwright virtual-authenticator e2e (register, login, revoke); TOTP fallback still works; admins without passkey blocked from admin routes |
| T-02 | Run CI on a protected GitHub repo (Node 26 + PG 18 matrix), branch protection, CODEOWNERS                                                                                    | —          | All jobs green incl. CodeQL/Trivy/gitleaks; evidence linked in PROJECT_STATE                                                                |
| T-03 | External KMS provider (AWS KMS / Azure Key Vault / Vault Transit) behind `KeyProvider`                                                                                       | T-02       | Integration test against a KMS emulator; rewrap job; app refuses start without KMS in production                                            |
| T-04 | Breached-password corpus (offline k-anonymity range files or HIBP via egress proxy)                                                                                          | —          | Unit tests with known-breached samples                                                                                                      |
| T-05 | Staging deployment per NETWORK_AND_ZTNA (WAF, ZTNA, TLS 1.3, private DB, egress deny)                                                                                        | T-02, T-03 | Verification checklist all ✔ with evidence                                                                                                  |
| T-06 | Off-site immutable backups (pgBackRest + object lock), WAL PITR, alerting; first quarterly restore exercise with measured RPO/RTO                                            | T-05       | Signed exercise log                                                                                                                         |
| T-07 | DAST (ZAP baseline + authenticated full scan) in staging; fix findings                                                                                                       | T-05       | Report with no high/critical                                                                                                                |
| T-08 | Lint-enforced module boundaries (no imports from wms → other modules' internals; only engine writes stock tables)                                                            | —          | ESLint rule + failing fixture test                                                                                                          |
| T-09 | Negative test: counter self-approval; reversal of already-consumed stock; replenishment over-target                                                                          | —          | New tests pass                                                                                                                              |
| T-10 | axe checks on every screen; manual screen-reader pass (NVDA/VoiceOver); keyboard-only walkthrough                                                                            | —          | No violations; findings documented in DESIGN_SYSTEM                                                                                         |
| T-11 | Load/concurrency benchmarks (k6): 50 concurrent pickers, allocation contention, ledger growth to 10 M rows                                                                   | T-02       | p95 targets documented; indexes tuned                                                                                                       |
| T-12 | Retention jobs: command_log (90 d), expired sessions/tokens, outbox (published > 30 d)                                                                                       | —          | Scheduled job + tests                                                                                                                       |
| T-13 | Independent pentest + human security review sign-off                                                                                                                         | T-01…T-07  | Report, all high/critical closed                                                                                                            |

## B. WMS functional hardening

| Id   | Task                                                                                           | Acceptance                               |
| ---- | ---------------------------------------------------------------------------------------------- | ---------------------------------------- |
| T-20 | Lot/serial end-to-end (FEFO allocation, serial uniqueness, lot on pick/pack/transfer)          | Acceptance flow with LOT and SERIAL SKUs |
| T-21 | Unit-of-measure conversions on receipt/pick (box of 10 ⇒ base units via barcode `qty_per_uom`) | Scan box barcode receives 10             |
| T-22 | "Unpick" (return PICKED stock to shelf) and package re-open                                    | Close order after unpick                 |
| T-23 | Nested containers (pallet → boxes) with explicit rules, or keep unsupported                    | ADR + tests                              |
| T-24 | Topology editing: deactivate nodes, rename, move empty subtrees safely                         | Tests: cannot deactivate with stock      |
| T-25 | Printing: ZPL/PDF label templates, scanner-mode full-screen picking UI for tablets             | Field test on a real scanner             |
| T-26 | Transfer pick lists with reservations at source (allocation before dispatch)                   | Concurrency test with outbound           |
| T-27 | Activity search across documents; saved reports; CSV export of ledger                          | Tests                                    |
| T-28 | Event consumers SDK (typed event schemas, versioning policy, replay tool)                      | Contract tests                           |

## C. Later business domains (only after A)

1. Automotive catalogue / fitment (TecDoc integration) as an extension module (relational tables).
2. Commercial: customers (encrypted PII), quotes, sales orders → creates WMS outbound requests via service API.
3. Procurement: suppliers, purchase orders → WMS expected inbound documents.
4. Certified invoicing + SAF-T (PT) + AT transport document communication (legal review mandatory).
5. Finance/accounting integration.
