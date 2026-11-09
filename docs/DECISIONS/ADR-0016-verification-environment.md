# ADR-0016 — Verification environment deviations

Status: Accepted (recorded fact). Owning module: tooling.

The build sandbox could not reach nodejs.org or Docker Hub. Evidence was therefore produced on
Node 22.23.4 and the system PostgreSQL 16.15 (disposable cluster), with Google Chrome for
Testing 153 for Playwright. Docker Compose (postgres:18-alpine) and Node 26 are the documented
targets but were not executed here. CI is configured to close this gap (SEC-OPEN-010).
