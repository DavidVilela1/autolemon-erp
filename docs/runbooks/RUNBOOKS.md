# Runbooks — incident response and maintenance (AutoLemon ERP v0.6.1, WMS)

Owning module: operations. Audience: the on-call administrator / IT support. Language: English
(operator-facing instructions are in pt-PT in `docs/MANUAL_OPERADOR_E_ADMIN.md`).

> **Status.** These procedures are written against the code and tested commands of this
> version. They have **not** been rehearsed in a production environment (none exists yet); the
> tabletop/rehearsal record is gate item O-04. Every step that changes data says how to verify
> it. Never run SQL that writes to WMS tables (`stock_positions`, `inventory_*`, documents) by
> hand — stock is corrected only through the application (adjustment, reversal, count).

Conventions: `$API` = API base URL; "admin" = a company Administrator with a passkey (production
policy). SQL is run as the **owner/migration role** from an approved admin workstation, read-only
unless stated.

## 0. Severity and first response

| Severity | Examples                                                               | Response                                                                        |
| -------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| SEV-1    | suspected account takeover, data exposure, audit-chain break, DB loss  | start §1 immediately; inform data-protection contact; 72 h GDPR clock may apply |
| SEV-2    | warehouse cannot ship/receive, reconciliation mismatch, failed backups | start the matching playbook within 1 h                                          |
| SEV-3    | single stuck document, one user locked out, purge failure              | next business day                                                               |

Always: note the time, the request id (`x-request-id` header / log field) and what you changed.
Write the incident record (§9) before closing.

## 1. Suspected account compromise (SEV-1)

1. **Contain** — Administração → user → _Desativar_ (revokes all sessions immediately). If the
   account is an administrator and you are the only one, use §3.
2. **MFA reset** — Administração → _Repor MFA_ (step-up). This removes TOTP, recovery codes and
   **all passkeys** (v0.6.1) and revokes sessions. Give the new enrolment link only through a
   verified channel (in person / known phone number).
3. **Scope** — Auditoria: filter by the user; look for `auth.login.success` from unusual IPs,
   `wms.export.*`, `admin.*`, `pii.read`, `wms.inventory.release`, adjustments/reversals.
   Ledger: Histórico → filter the period → _Exportar movimentos_ for evidence.
4. **Verify audit integrity** — Auditoria → _Verificar cadeia_ must report OK (§4 if not).
5. **Recover** — reverse wrong postings with _Reverter_ (once per transaction) or adjust with a
   reason; never delete. Re-enable the user only after the enrolment is redone.

## 2. Lost or stolen device (passkey / authenticator)

Staff: an administrator runs _Repor MFA_ (all factors incl. passkeys are revoked) and hands over
the new link. The user re-enrols TOTP and, optionally, a new passkey in _A minha conta_.

Administrator with other admins available: same, performed by another administrator.

## 3. Last administrator locked out (break-glass) — SEC-OPEN-018

Preferred: the admin signs in with a **recovery code** instead of the passkey, then _A minha
conta_ → remove the lost passkey → register a new one → _Gerar novos códigos_.

If no recovery code is available and there is no other administrator, the procedure requires
database access and two people (requester + approver), recorded in the incident log:

1. Confirm identity out of band; open a SEV-2 incident.
2. Temporarily set `ADMIN_PASSKEY_REQUIRED=false` **only if the admin must use TOTP**, restart.
3. Create a second administrator through the provisioning tooling of the target environment (or,
   in development only, `pnpm db:seed` on a fresh database). Do not edit `users`/`webauthn_*`
   rows by hand.
4. The new admin performs §2 for the locked-out admin; restore `ADMIN_PASSKEY_REQUIRED=true`.
5. Verify: Auditoria shows `admin.user.mfa_reset` with `passkeysRevoked`; the old passkey fails.

Open item: a scripted, audited break-glass command (T-30).

## 4. Audit-chain verification failure (SEV-1)

1. Do not restart or "fix" the table — the break is evidence. Snapshot: `pnpm backup:local`
   (development) / provider snapshot (production).
2. Identify the first failing entry (Auditoria → _Verificar cadeia_ shows the id).
3. Compare with the off-site digests: `pnpm audit:digest verify --pub <public.pem> <digest dir>`
   (ADR-0027). `HASH_MISMATCH` = entries rewritten consistently before that digest;
   `ENTRIES_MISSING` = entries deleted. Compare with the backup taken before the break.
4. Treat as tampering until proven otherwise (§1 for all admins + DB credential rotation).

## 5. Stock reconciliation mismatch (SEV-2)

Relatórios → _Reconciliação_ must show "Saldos e reservas coincidem". If not:

1. Stop corrections in that warehouse (inform the team); export movements of the last days.
2. Run (read-only):
   ```sql
   SELECT p.id, p.qty_on_hand, coalesce(sum(l.qty_delta), 0) AS ledger
   FROM stock_positions p LEFT JOIN inventory_ledger l ON l.position_id = p.id
   GROUP BY p.id HAVING p.qty_on_hand <> coalesce(sum(l.qty_delta), 0);
   ```
3. A mismatch means a code defect or manual DB write: capture the rows, open a defect with the
   request ids, and restore from backup into a disposable database to compare. Do not adjust
   balances to hide it.

## 6. Stuck documents

| Symptom                                                 | Action (all in the UI, audited)                                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Order picked but customer cancelled                     | Saídas → _Retirar_ / _Retirar do volume_ (un-pack) → _Anular separação_ (un-pick to a shelf) → _Cancelar_ |
| Order cannot close: "picked not dispatched"             | dispatch the packages or un-pack/un-pick the remainder, then _Fechar_                                     |
| Transfer sent by mistake (not yet shipped)              | origin: Transferências → _Anular transferência_                                                           |
| Transfer partly lost in transit                         | destination: _Fechar_ — the remainder is recorded as lost per lot                                         |
| Destination close refused `TRANSFER_RESERVED`           | the source still holds reservations: source dispatches the rest or _Anular transferência_ (releases them) |
| Outbound short because stock is reserved for a transfer | Transferências → the transfer's "Reservado" column shows it; source dispatches or cancels the transfer    |
| Stock in quarantine that passed inspection              | Stock → _Estado_ → Disponível + destination shelf (step-up)                                               |
| Location must be removed                                | move stock and boxes out, then Estrutura → _Desativar_                                                    |
| Wrong movement posted                                   | Histórico → _Reverter_ (step-up, once)                                                                    |

## 6a. Security alerts (Segurança page, log `securityAlert: true`, optional webhook)

| Alert                                                    | First response                                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `audit.chain_broken` (CRITICAL)                          | SEV-1 — §4; do not acknowledge until the incident record exists                                    |
| `auth.login_failures`, `auth.mfa_failures` (HIGH)        | check Auditoria for the accounts/IPs; if one account: §1; if spraying: block at the WAF/ZTNA       |
| `auth.unknown_account_failures` (HIGH, log/webhook only) | credential stuffing against non-existent accounts: block sources at the WAF                        |
| `auth.recovery_code_used`, `auth.mfa_reset` (MEDIUM)     | confirm with the user by a known channel that it was them; otherwise §1                            |
| `admin.pii_read_burst`, `wms.export_burst` (MEDIUM)      | confirm the business reason with the administrator/operator; otherwise §1 and restrict permissions |
| `authz.denied_spike` (MEDIUM)                            | look for probing (Auditoria → `authz.denied` resources); a misconfigured scanner/tablet is common  |
| `system.outbox_stuck`, `system.*_failed` (MEDIUM/HIGH)   | §7                                                                                                 |

Acknowledge (_Marcar como visto_) only after the response is recorded; it is one-way and audited.

## 7. Background jobs

- **Outbox backlog**: `SELECT count(*) FROM domain_outbox WHERE published_at IS NULL;` should
  stay near 0. Growth → check API logs for `outbox dispatch failed`.
- **Retention purge**: logs `retention purge failed` on error; audit `system.retention.purge`
  after each run with deletions. A failure is SEV-3 unless the database is filling up. Check the
  `RETENTION_*_DAYS` values (≥ 7) and that migration 0006 is applied.

## 8. Maintenance

| Task                   | When                       | Procedure / verification                                                                                                            |
| ---------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Upgrade                | each release               | backup → `pnpm restore:smoke` → `pnpm db:migrate` on staging → production; reconciliation empty afterwards (`docs/DATABASE.md` §1a) |
| Rollback               | failed release             | redeploy previous image (schema is backward compatible); or restore the pre-upgrade backup                                          |
| Dependency patching    | monthly / critical in 72 h | `pnpm audit`, update exact pins, `pnpm test:all`, `pnpm security:scan`, SBOM in the release                                         |
| Key rotation (DEK/KEK) | yearly / on suspicion      | Administração → _Rodar chaves_ (step-up); verify a PII read still decrypts; record in the incident/change log                       |
| Restore exercise       | quarterly                  | restore last backup into an isolated database, `verify-restore`, record the time (RPO/RTO evidence)                                 |
| Access review          | quarterly                  | Administração: deactivate leavers, review admins and `wms.export`/`wms.adjust` holders                                              |

## 9. Incident record (template)

Date/time detected · detected by · severity · systems/warehouses affected · timeline (UTC and
Lisbon) · request ids · actions taken (who, when) · data affected (personal data? GDPR
notification decision and owner) · root cause · follow-up tasks · closed by/when.
