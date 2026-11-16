# ADR-0030 — Reproducible load/performance harness with provisional targets

Status: Accepted (v0.6.8). Owning module: tooling (tests/load). Gate E-04 (T-11).

**Context.** Gate E-04 needs "representative load, stress, availability and performance targets
agreed and met". The targets were never agreed, so nothing was measured; any later agreement
would still have needed a harness, a dataset and a method.

**Decision.**

- `tests/load/load-harness.ts`, run with `pnpm test:load [-- --profile smoke|representative|stress]`
  on a disposable database (`scripts/with-test-db.mjs`). Profiles, operation mix and targets
  live in `docs/perf/targets.json`, marked **PROVISIONAL** until the product owner sets
  `status: AGREED`, `agreedBy` and `agreedAt`.
- Dataset: SKUs inserted in bulk (catalogue rows carry no stock invariant), storage tree through
  the topology service, **opening stock through the real stock command** (500 lines per request)
  so every position has a transaction, ledger rows, audit and outbox entries — the data looks
  like production data, not like a fixture.
- Load: one STAFF user per virtual user (password + TOTP login), weighted mix — stock by SKU 40,
  SKU search 20, global search 10, ledger page 5, stock move 25 — through the complete HTTP
  stack via Fastify inject (routing, guard, CSRF, validation, RLS, serialisation; no network).
  Each virtual user moves stock only between its own positions and bins (operators work on
  different bins); reads are random over the whole catalogue.
- After every run: total on-hand unchanged (moves conserve stock) and the ledger/reservation
  reconciliation must be clean — a load test that corrupts stock fails even if it is fast.
- Output: `artifacts/perf/<profile>-<time>.json` (CI artifact) and the generated
  `docs/perf/LAST_RUN_<profile>.md`. `smoke` and `representative` enforce the targets (exit 1);
  `stress` (60 users) is report-only to show how latency degrades.
- CI runs the smoke profile in the `verify` job.

**Provisional targets** (developer proposal): p95 ≤ 150 ms stock by SKU, ≤ 200 ms SKU search,
≤ 300 ms global search / ledger page / stock move, error rate ≤ 0.1 %, ≥ 50 req/s, for 20 000
SKUs, 1 000 bins, 100 000 positions and 25 concurrent users.

**Alternatives.** k6/JMeter against a deployed server (better for network and TLS effects, but
needs a target environment and a second tool chain; the same mix and targets can be ported when
staging exists); synthetic SQL-only benchmarks (miss validation, RLS and serialisation costs).

**Consequences / limits.** Load generator and server share the machine and there is no network
hop, so the numbers are a server-side baseline on the measured hardware, not a production
capacity statement. Availability (failover, restarts under load) and soak tests need the target
environment (O-01, O-05). E-04 stays BLOCKED until the targets are agreed and the representative
profile is repeated on production-equivalent hardware.
