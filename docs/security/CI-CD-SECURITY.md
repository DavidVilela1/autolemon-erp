# CI/CD security and release controls — v0.5.0

Owning module: operations/security. Workflow: `.github/workflows/ci.yml`. **Status: written and
YAML-validated; never executed** (no GitHub repository/runner was connected — SEC-OPEN-006).

## 1. Default-deny pipeline

| Job / step                                | Command                                                                                      | Blocks merge on        | Evidence output            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------- | -------------------------- |
| Clean install                             | `pnpm install --frozen-lockfile`                                                             | lockfile drift         | log                        |
| Format                                    | `pnpm format:check`                                                                          | any diff               | log                        |
| Lint + documentation gate                 | `pnpm lint` (ESLint security rules + `scripts/check-file-headers.mjs`)                       | any error/warning      | log                        |
| Types                                     | `pnpm typecheck` (strict, all workspaces + scripts)                                          | any error              | log                        |
| API compatibility                         | `pnpm api:check` (generated OpenAPI must equal committed)                                    | drift                  | log                        |
| Unit + property                           | `pnpm test:unit`                                                                             | failure                | log                        |
| Migrations                                | `pnpm db:migrate` twice on empty DB (idempotent, checksum verified)                          | failure                | log                        |
| Integration (real Postgres, ephemeral DB) | `pnpm test:integration`                                                                      | failure                | log                        |
| Security negative tests                   | `pnpm test:security`                                                                         | failure                | log                        |
| Browser E2E + axe                         | `pnpm test:e2e`                                                                              | failure                | Playwright report artifact |
| Local scanners                            | `pnpm security:scan` (secrets, SAST-lite, raw SQL gate, audit HIGH/CRITICAL, SBOM, licenses) | any FAIL               | `artifacts/sbom.cdx.json`  |
| Build                                     | `pnpm build`                                                                                 | failure                | —                          |
| CodeQL                                    | `security-extended`                                                                          | alerts per repo policy | Security tab               |
| gitleaks                                  | full history                                                                                 | any finding            | log                        |
| Trivy fs/IaC/secret                       | HIGH/CRITICAL                                                                                | finding                | log                        |
| Container build + Trivy image             | HIGH/CRITICAL                                                                                | finding                | log                        |
| Scheduled (weekly)                        | same as above incl. property tests and advisories                                            | failure                | log                        |

Not yet automated (manual/staging gates, mandatory before release): DAST (OWASP ZAP), full
warehouse lifecycle acceptance on staging, failover/restore smoke on staging, rollback smoke,
manual security sign-off for auth/crypto/permissions/migrations/inventory changes, independent
penetration test before the first real customer.

## 2. Supply chain

- All third-party actions pinned to full commit SHAs (resolved 2026-11-09 via `git ls-remote`):
  checkout v7.0.1 `3d3c42e5…`, setup-node v7.1.0 `949feb24…`, pnpm/action-setup v6.1.1 `73e46992…`,
  upload-artifact v7.0.2 `cf430e03…`, codeql-action v4.39.3 `33d7b85d…`, trivy-action v0.36.0
  `ed142fd0…`, gitleaks-action v3.0.0 `e0c47f4f…`.
- `permissions: contents: read` by default; `persist-credentials: false`.
- Exact dependency pins, committed lockfile, pnpm supply-chain policy (minimum release age with
  documented exclusions), `allowBuilds` only for esbuild.
- Untrusted fork PRs must run on GitHub-hosted isolated runners without secrets (default for
  `pull_request`); never use `pull_request_target` with checkout of PR code.

## 3. Branch protection and review (to configure on the repository)

- Require all CI jobs; require ≥ 1 human approval; **≥ 2 (incl. a security reviewer)** for
  changes under `platform/auth`, `platform/crypto`, `platform/authz`, `db/migrations`,
  `wms/inventory`, `.github/`. Use CODEOWNERS. AI review is supplementary only.
- No force-push, signed commits recommended, linear history.

## 4. Release and deployment

- **Production deployment: DISABLED** (no deploy job exists). When added: protected
  `production` environment with manual approval; OIDC federation to the cloud (no long-lived
  secrets); immutable, signed images (cosign) + SLSA provenance attestation; explicit migration
  review; post-deploy smoke checks; tested rollback (previous image + forward-only migration
  compatibility).
- Exceptions: time-boxed, written, human-signed; never for known exploitable critical/high
  findings in a production release; no disabling tests to get green builds.
