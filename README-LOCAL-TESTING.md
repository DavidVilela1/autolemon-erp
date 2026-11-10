# Local setup and testing — AutoLemon ERP v0.6.1

Owning module: repository. Archive: **`AutoLemon-ERP-v0.6.1-WMS.zip`**, root folder
**`autolemon-erp/`**. Checksum file: `AutoLemon-ERP-v0.6.1-WMS.zip.sha256`.

## Prerequisites

| Tool                           | Version                        | Notes                                                                                             |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| Node.js                        | ≥ 22.12.0 (26 LTS recommended) | verified on 22.23.4                                                                               |
| pnpm                           | **12.18.0**                    | `npm install --global pnpm@12.18.0` (or `corepack enable`)                                        |
| Docker Engine / Docker Desktop | current                        | runs PostgreSQL 18 (`docker-compose.yml`), bound to 127.0.0.1:5432                                |
| Chromium for E2E               | —                              | `pnpm exec playwright install chromium` (once) or set `PLAYWRIGHT_CHROME_PATH` to a Chrome binary |
| Git                            | optional                       | not required                                                                                      |

If port 5432 is busy, change `POSTGRES_PORT` **and** the port in `DATABASE_URL` /
`APP_DATABASE_URL` in `.env`.

## Verify the archive

```bash
sha256sum -c AutoLemon-ERP-v0.6.1-WMS.zip.sha256          # Linux
shasum -a 256 -c AutoLemon-ERP-v0.6.1-WMS.zip.sha256      # macOS
```

```powershell
(Get-FileHash .\AutoLemon-ERP-v0.6.1-WMS.zip -Algorithm SHA256).Hash   # compare with the .sha256 file
```

## macOS / Linux

```bash
unzip AutoLemon-ERP-v0.6.1-WMS.zip -d AutoLemon-ERP-extracted
cd AutoLemon-ERP-extracted/autolemon-erp
node --version
npm install --global pnpm@12.18.0
pnpm --version
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d
docker compose ps            # wait until postgres is "healthy"
pnpm db:migrate              # also generates dev-only secrets into .env on first run
pnpm db:seed                 # prints DEVELOPMENT-ONLY invitation links
pnpm exec playwright install chromium
pnpm typecheck
pnpm lint
pnpm test:all
pnpm security:scan
pnpm restore:smoke
pnpm build
pnpm dev
```

## Windows PowerShell

```powershell
Expand-Archive -Path .\AutoLemon-ERP-v0.6.1-WMS.zip -DestinationPath .\AutoLemon-ERP-extracted
Set-Location .\AutoLemon-ERP-extracted\autolemon-erp
node --version
npm install --global pnpm@12.18.0
pnpm --version
pnpm install --frozen-lockfile
Copy-Item .env.example .env
docker compose up -d
docker compose ps
pnpm db:migrate
pnpm db:seed
pnpm exec playwright install chromium
pnpm typecheck
pnpm lint
pnpm test:all
pnpm security:scan
pnpm restore:smoke
pnpm build
pnpm dev
```

## Without Docker (native PostgreSQL)

Docker only provides PostgreSQL. Any local PostgreSQL 16–18 works instead; its client tools
(`psql`, `pg_dump`, `pg_restore`) must be the same major version as the server or newer for
`pnpm backup:local` / `pnpm restore:smoke`.

**Windows** (PowerShell as Administrator): `winget install --id PostgreSQL.PostgreSQL.18 -e --interactive`
(components: _PostgreSQL Server_ + _Command Line Tools_; note the `postgres` password and the
port — **5433** if another PostgreSQL already uses 5432). Then, in the project folder:

```powershell
$env:Path = "C:\Program Files\PostgreSQL\18\bin;" + $env:Path   # 18 tools first (every new window)
$env:PG_TOOL_MODE = "local"                                        # backup/restore without Docker
psql --version                                                     # must print 18.x
psql -U postgres -h 127.0.0.1 -p 5433 -c "CREATE ROLE autolemon_owner LOGIN SUPERUSER PASSWORD 'dev_only_owner_password_change_me';"
psql -U postgres -h 127.0.0.1 -p 5433 -c "CREATE DATABASE autolemon OWNER autolemon_owner;"
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
(Get-Content .env) -replace '@127\.0\.0\.1:5432/', '@127.0.0.1:5433/' | Set-Content .env
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed | Tee-Object -FilePath .\invitations-dev.txt
pnpm exec playwright install chromium
pnpm test:all
pnpm security:scan
pnpm backup:local
pnpm restore:smoke
pnpm build
pnpm dev
```

**macOS/Linux** (e.g. `brew install postgresql@18` / distribution packages): create the same
role and database with `psql -U postgres -c ...`, keep port 5432 (or edit both URLs in `.env`),
then `export PG_TOOL_MODE=local` and run the usual commands without `docker compose up -d`.

The owner role is a superuser only because this is a disposable local development database
bound to 127.0.0.1 (the Docker setup is identical). Never reuse these passwords elsewhere.
`invitations-dev.txt` holds one-time development links: delete it after enrolling.

**Optional — gitleaks locally:** install gitleaks 8.24.3 from its GitHub releases page (verify
the published SHA-256), put it on `PATH` or set `GITLEAKS_BIN`; `pnpm security:scan` then runs
the same secret rules as CI over the project files. Without it the scan reports `WARN … NOT RUN`.

## Using the app locally

1. `pnpm dev` → open **http://localhost:5173** (API on http://127.0.0.1:3000, proxied as `/api`).
2. Open the **Admin** invitation link printed by `pnpm db:seed`
   (`http://localhost:5173/#/convite/<token>`, valid 72 h, single use). Choose a password
   (≥ 12 chars), add the shown TOTP secret to an authenticator app (manual key entry), confirm
   with a code, and store the recovery codes.
3. Log in with `admin@demo.autolemon.test` + password + TOTP code. Operator links for Porto and
   Lisboa are printed too. All seed data is synthetic.
4. Lost the links? `pnpm db:reset:dev && pnpm db:seed` (development databases only). There is
   **no default admin password**: you choose it when you open the Admin invitation link.
5. Upgrading an existing v0.5 development database: `pnpm db:migrate` applies migrations
   0004–0006 (passkeys/account security, WMS completion, retention). No data is rewritten.
6. Passkeys: open **A minha conta** → _Registar chave de acesso_ (asks for a TOTP step-up first).
   Browsers allow WebAuthn on `http://localhost`; the relying-party id defaults to the host of
   `WEB_ORIGIN` (`localhost`). After that, the login screen offers _Usar chave de acesso_. To try
   the production policy locally set `ADMIN_PASSKEY_REQUIRED=true` in `.env` and restart: an
   administrator without a passkey can then only reach _A minha conta_ until one is registered.

## What each test command needs

| Command                                       | Needs                                                                         | Notes                                                                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:unit`                              | nothing                                                                       | pure unit + property tests                                                                                                                                             |
| `pnpm test:integration`, `pnpm test:security` | running Postgres + `.env`                                                     | creates and drops `autolemon_test_<random>`; never touches your dev DB                                                                                                 |
| `pnpm test:e2e`                               | Postgres + Chromium                                                           | API :3901 + web :5199 on a disposable DB; ≈ 2 min (waits for fresh TOTP steps; passkey flow uses a Chrome DevTools virtual authenticator, so it needs Chromium/Chrome) |
| `pnpm test:all`                               | all of the above                                                              | non-interactive, non-zero exit on any failure                                                                                                                          |
| `pnpm restore:smoke`                          | Postgres; local `pg_dump`/`pg_restore` ≥ server version **or** Docker Compose | creates a backup if none exists; restores into a disposable DB and drops it                                                                                            |
| `pnpm security:scan`                          | network access to the npm registry for `pnpm audit`                           | lists CI-only scanners separately                                                                                                                                      |

Long-running/infrastructure checks not in `test:all`: `pnpm restore:smoke`, `pnpm security:scan`,
`pnpm verify:handover`, `pnpm release:zip` (needs the `zip` CLI).

## Troubleshooting

- `.env not found` → `cp .env.example .env` / `Copy-Item .env.example .env`.
- `ERR_PNPM_IGNORED_BUILDS` → the repo allows only esbuild builds; re-run `pnpm install`.
- Playwright cannot launch → `pnpm exec playwright install chromium` or set `PLAYWRIGHT_CHROME_PATH`.
- `pg_dump: server version mismatch` → set `PG_TOOL_MODE=docker` to use the container's tools.
