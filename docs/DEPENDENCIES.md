# Dependencies — verified 2026-11-09

Owning module: repository tooling. Versions were checked on **2026-11-09** against the npm
registry (`npm view <pkg> version|dist-tags|engines|peerDependencies|time|license`) and GitHub
tags (`git ls-remote`). Only stable `latest` releases were chosen (no prerelease tags). All
versions are pinned exactly (`save-exact`), the lockfile `pnpm-lock.yaml` is committed and
installs use `--frozen-lockfile`. Registry: https://registry.npmjs.org/<package>.

## Toolchain

| Component  | Requested baseline | Chosen                                                | Why / notes                                                                                                               |
| ---------- | ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Node.js    | 26.x LTS           | engines `>=22.12.0`; **verified on 22.23.4**          | nodejs.org was unreachable from the build environment; Node 26 could not be installed. CI should run 26.x (SEC-OPEN-010). |
| pnpm       | latest             | **12.18.0** (`packageManager`)                        | latest stable; supply-chain policy (minimum release age) active                                                           |
| TypeScript | 7.x                | **6.0.3**                                             | `typescript-eslint` 8.72.1 peer range is `>=4.8.4 <6.1.0`; TS 7.0.2 (native compiler) would break linting. ADR-0002.      |
| PostgreSQL | 18.x               | Compose: `postgres:18-alpine`; **tests ran on 16.15** | Docker Hub blocked in build env; no 17/18-only features used. Pin image digest after first pull.                          |

## Runtime (production) dependencies

| Package                                                | Version       | License                 | Published  | Notes                                                                                               |
| ------------------------------------------------------ | ------------- | ----------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| @nestjs/core, @nestjs/common, @nestjs/platform-fastify | 12.4.2        | MIT                     | 2026-11-09 | same-day patch across 11.x/12.x lines (likely fixes) → excluded from min-release-age (SEC-OPEN-011) |
| fastify                                                | 5.12.8        | MIT                     | 2026-11-02 | peer of platform-fastify                                                                            |
| @fastify/cookie                                        | 11.1.5        | MIT                     | 2026-10-27 |                                                                                                     |
| reflect-metadata / rxjs                                | 0.2.2 / 7.8.2 | Apache-2.0 / Apache-2.0 |            | Nest peers                                                                                          |
| drizzle-orm                                            | 0.45.4        | Apache-2.0              | 2026-10-08 | `latest` (1.0 is still RC)                                                                          |
| pg                                                     | 8.23.1        | MIT                     | 2026-09-30 | node-postgres driver                                                                                |
| zod                                                    | 4.6.7         | MIT                     | 2026-10-12 |                                                                                                     |
| @node-rs/argon2                                        | 2.2.2         | MIT                     | 2026-10-06 | prebuilt N-API binaries, no install scripts                                                         |
| react / react-dom                                      | 19.3.1        | MIT                     | 2026-10-14 |                                                                                                     |
| jsbarcode                                              | 3.12.3        | MIT                     | 2026-01-07 | used only as an encoder (no DOM)                                                                    |

## Development dependencies

| Package                                                                       | Version                                     | Notes                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| vite                                                                          | 8.3.7                                       | same-day multi-line patch → min-release-age exclusion                            |
| tailwindcss, @tailwindcss/vite                                                | 4.3.5                                       |                                                                                  |
| vitest                                                                        | 5.1.0                                       | engines `^22.12                                                                  |     | ^24 |     | >=26` |
| @playwright/test                                                              | 1.65.0                                      | browsers: `pnpm exec playwright install chromium` or `PLAYWRIGHT_CHROME_PATH`    |
| @axe-core/playwright                                                          | 4.14.0                                      | accessibility checks                                                             |
| eslint / @eslint/js / typescript-eslint / eslint-plugin-react-hooks / globals | 10.14.0 / 10.0.1 / 8.72.1 / 7.1.1 / 17.14.0 |                                                                                  |
| prettier                                                                      | 3.9.10                                      |                                                                                  |
| tsx                                                                           | 4.23.15                                     | dev runner (esbuild 0.28.2 — the only dependency allowed to run install scripts) |
| fast-check                                                                    | 4.10.2                                      | property-based tests                                                             |
| @types/node / @types/react / @types/react-dom / @types/pg                     | 22.20.5 / 19.3.0 / 19.3.0 / 8.23.1          | Node types match the verified runtime                                            |

## Not used (and why)

- **drizzle-kit** — migrations are hand-written SQL (composite FKs, triggers, RLS, grants) and
  checksummed by our runner (ADR-0004). Re-introduce only for introspection/diff tooling.
- **otplib** — TOTP implemented on `node:crypto` HMAC and verified against RFC 4226/6238 vectors.
- **@simplewebauthn/server** 14.1.0 — selected for T-01 (WebAuthn), not yet installed.
- **class-validator/class-transformer, @nestjs/swagger** — replaced by Zod contracts and our own
  OpenAPI generator (no decorator metadata reflection).
- **react-router** — tiny hash router suffices (ADR-0007).

## Security advisories (pnpm audit, 2026-11-09)

| Advisory                                      | Severity | Path                            | Runtime? | Decision                                 |
| --------------------------------------------- | -------- | ------------------------------- | -------- | ---------------------------------------- |
| GHSA-g3hv-75wg-m249 minimatch ReDoS (<11.0.1) | moderate | eslint, typescript-eslint (dev) | No       | Accepted until 2026-12-31 (SEC-OPEN-009) |

No high/critical advisories. `pnpm security:scan` re-checks on every run (blocks HIGH/CRITICAL).

## SBOM

CycloneDX 1.7 production SBOM generated by `pnpm sbom` inside `pnpm security:scan`:
`artifacts/sbom.cdx.json` (110 production components at time of writing), copied into the
release archive as `docs/sbom/sbom.cdx.json`. License gate: no GPL/AGPL/SSPL in production deps
(passed); internal package `@autolemon/contracts` is UNLICENSED/private.

## Patch policy

- Critical/high runtime advisory: patch within 72 h (hotfix release), else documented mitigation.
- Moderate: next scheduled release (≤ 30 days). Low: quarterly.
- Monthly dependency review; respect pnpm minimum-release-age except for documented security fixes.
- Never adopt unmaintained packages when a maintained alternative exists; cryptography and auth
  only via maintained, widely-reviewed libraries or `node:crypto`.

## GitHub Actions (pinned SHAs)

See `docs/security/CI-CD-SECURITY.md` §2.
