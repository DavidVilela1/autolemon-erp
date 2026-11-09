# infra/ — production reference templates (NOT DEPLOYED / UNVERIFIED)

Owning module: operations. These files are **examples** for the reference architecture in
`docs/security/NETWORK_AND_ZTNA.md` and `docs/security/BACKUP_AND_DR.md`. None of them has been
deployed or verified against a real environment in v0.5. Each must be reviewed, adapted to the
chosen provider and tested in staging before any production use.

| File                                                         | Purpose                                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `nginx/autolemon.conf`                                       | TLS 1.3 reverse proxy, HSTS, CSP, static SPA, `/api` proxy, request limits       |
| `postgres/postgresql.prod.conf`, `postgres/pg_hba.prod.conf` | TLS-only private Postgres, scram-sha-256, WAL archiving                          |
| `backup/pgbackrest.conf`                                     | Encrypted daily full + continuous WAL (PITR) to an object-locked off-site bucket |
| `backup/autolemon-backup.service` / `.timer`                 | systemd scheduling + failure alerting hook                                       |
| `compose/docker-compose.prod.example.yml`                    | Segmented networks, non-root, read-only containers, no public DB port            |
