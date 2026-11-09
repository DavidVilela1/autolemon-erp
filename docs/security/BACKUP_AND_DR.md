# Backup and disaster recovery — v0.5.0

Owning module: operations. **Off-site backups are NOT occurring**: no off-site destination was
connected in this build. What exists and was tested is a local, encrypted demonstration plus a
disposable restore verification.

## 1. Targets (proposals, to be agreed by the business)

| Metric    | Proposal                                                                     | Status                                                  |
| --------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| RPO       | ≤ 24 h with daily full backups; ≤ 5 min with continuous WAL archiving (PITR) | unproven target                                         |
| RTO       | ≤ 8 h for full restore of the ERP                                            | **unproven target** — measure in the quarterly exercise |
| Retention | daily 35 days, monthly 12 months, immutable (object lock)                    | proposal                                                |

Measured so far (local, synthetic dataset, build VM): `pnpm restore:smoke` end to end ≈ 1.3 s.
This is NOT an RTO measurement for production volumes.

## 2. Production strategy (provider-neutral, NOT DEPLOYED)

- pgBackRest (`infra/backup/pgbackrest.conf`): daily full + continuous WAL to an off-site
  S3-compatible bucket in a separate account with **Object Lock (compliance)**; repository
  cipher AES-256 with passphrase in the vault; `verify` after each backup.
- Backup identity: dedicated role with write-only access to the bucket; cannot delete within the
  lock period; separate from application admins and DB admins.
- Keys: the repository cipher passphrase and the KMS KEKs have **separate** recovery paths
  (vault/KMS replication + sealed break-glass procedure). Never store keys next to backups.
- Schedule: `infra/backup/autolemon-backup.timer` (02:30 Europe/Lisbon) with failure alert.
- Monitoring: alert when last successful backup > 26 h, WAL archive lag > 15 min, verify fails.

## 3. Local demonstration (implemented and tested)

| Command              | What it does                                                                                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm backup:local`  | `pg_dump -Fc` → AES-256-GCM with `.local/backup.key` (generated, 0600) → `backups/*.dump.enc` + manifest (SHA-256 of plaintext and ciphertext). No network.                                                                                                                  |
| `pnpm restore:smoke` | Verifies checksum + GCM tag, restores into a NEW `autolemon_restore_smoke_<rand>` database, checks schema version/checksums, ledger and reservation reconciliation, audit chains, decryption of every encrypted field, then drops the database. Never touches the source DB. |

Docker users without a local `pg_dump` ≥ server version: scripts automatically use
`docker compose exec postgres …` (`PG_TOOL_MODE=docker|local` to force).

## 4. Exercises

| Exercise                   | Frequency                         | Steps                                                                                                                                                  | Evidence                             |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Restore smoke              | each release + weekly CI schedule | `pnpm restore:smoke`                                                                                                                                   | console output in PROJECT_STATE      |
| Full isolated restoration  | quarterly                         | restore latest off-site backup + PITR to timestamp into an isolated network; run reconciliation, audit verify, decrypt sample, app smoke test; time it | signed exercise log (template below) |
| DR / ransomware simulation | annually                          | assume primary + credentials compromised: rotate all credentials/KEKs, restore from object-locked copy into clean account, validate, cut over          | signed report, lessons learned       |

Exercise log template: date · participants · backup id · PITR target · start/end time
(measured RTO) · data loss window (measured RPO) · checks passed · issues · sign-off (name, role).

## 5. Ransomware isolation steps (runbook outline)

1. Isolate: revoke ZTNA access, stop API containers, snapshot volumes for forensics.
2. Preserve: export audit log and chain digests; do not wipe compromised hosts before forensics.
3. Credentials: rotate DB roles, CSRF secret, KEKs (rewrap), revoke all sessions.
4. Restore into a clean environment from object-locked copies; verify (reconciliation, audit chain).
5. Communicate: management, DPO (GDPR Art. 33/34 assessment within 72 h), customers if needed.

## 6. GDPR Art. 32 considerations

Backups contain personal data: encryption, access control, restoration ability and regular
testing are the Art. 32(1)(b)–(d) controls addressed here. Legal compliance requires DPO/legal
review — **not claimed**.
