# Implementation plan, acceptance criteria and checklist — v0.5.0

Owning module: architecture. Written before coding; kept as the record of intent. Results live
in `docs/PROJECT_STATE.md`.

## 1. Architecture plan (short)

Modular monolith (ADR-0001): NestJS 12/Fastify API + React 19 SPA + PostgreSQL. Platform module
(identity, sessions, MFA, RBAC, crypto, audit, modules, outbox) and an autonomous WMS module
(engine + workflows). Tenant/warehouse isolation by service checks + composite FKs + RLS
(ADR-0006). Inventory = positions + append-only ledger (ADR-0008). Every command idempotent
(ADR-0010). Security baseline: ASVS 5.0 L2 self-assessment, NIST 800-63B-4 for authentication.
Threat model: `docs/security/THREAT_MODEL.md`. Module dependency diagram: `docs/ARCHITECTURE.md`.

## 2. Acceptance criteria (from the master specification §8)

| #   | Criterion                                                                                       | Automated test                           |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | Company A, Porto, Lisboa, warehouse-only staff, admin                                           | ACC 1                                    |
| 2   | BRK-001, receive 28 of 30, shortage 2 recorded                                                  | ACC 2                                    |
| 3   | 10 shelf / 10 bin / 8 box ⇒ 3 positions, 28 units                                               | ACC 3                                    |
| 4   | Reserve 12 ⇒ available-to-allocate 16                                                           | ACC 4                                    |
| 5   | Pick/pack 12 in 2 packages, dispatch ⇒ Porto 16                                                 | ACC 5                                    |
| 6   | Transfer 5 ⇒ Porto 11, Lisboa 5 via in-transit + putaway                                        | ACC 6                                    |
| 7   | Return 2 ⇒ 1 saleable, 1 quarantine, separate totals                                            | ACC 7                                    |
| 8   | Count, discrepancy, approved compensating adjustment, ledger verified                           | ACC 8                                    |
| 9   | Move whole box; contents and history correct                                                    | ACC 9                                    |
| 10  | Cross-warehouse/tenant, export and decryption denials                                           | ISO                                      |
| 11  | SQLi/XSS/CSRF/MFA bypass/session replay/cookie tampering/invalid ids/CSV/duplicates/concurrency | ATK, PROP, E2E                           |
| 12  | WMS-only startup                                                                                | ACC 12                                   |
| 13  | Encryption round trip, tamper, denial, rotation                                                 | CRY                                      |
| 14  | Safe disposable local backup restore + integrity                                                | `pnpm restore:smoke`                     |
| 15  | Clean install from final ZIP                                                                    | clean-room run recorded in PROJECT_STATE |

## 3. Prioritised checklist (milestones)

1. ✅ Dependencies verified, threat model, monorepo, lockfile.
2. ✅ Identity, sessions, TOTP MFA, recovery, RBAC, encryption abstraction, audit chain.
3. ✅ WMS schema with composite FKs, triggers, RLS.
4. ✅ Atomic inventory engine (locks, ledger, reservations, idempotency).
5. ✅ Inbound / receiving / putaway.
6. ✅ Outbound / picking / packing / dispatch / backorders.
7. ✅ Transfers, replenishment, counts, returns, corrections.
8. ✅ Reports, CSV export, labels, pt-PT UI.
9. ✅ Security hardening, CI definition, backup/restore scripts, documentation.
10. ✅ Clean-room handover verification from the ZIP.
11. ⏭ WebAuthn, KMS provider, deployment hardening — `docs/NEXT_TASKS.md`.
