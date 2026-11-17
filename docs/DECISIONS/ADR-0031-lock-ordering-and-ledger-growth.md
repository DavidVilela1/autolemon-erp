# ADR-0031 — Ordered row locking for allocation and moves; ledger-growth load profile

Status: Accepted (v0.6.9). Owning module: wms (inventory engine). Gate E-04 (T-11), I-01.

**Context.** v0.6.9 extended the load harness (ADR-0030) with the write path that contends the
most in a real warehouse: creating and allocating outbound orders on the 20 hottest SKUs
(`order_allocate`, 10 % of the mix, half of the orders cancelled again). The first smoke run
passed every functional check (stock conserved, reconciliation clean, no 5xx) but the
PostgreSQL log showed **10 `deadlock detected` errors**, and the allocate step had a tail of
2–3 s. The retry on `40P01` (`database.ts`) hid the errors from users, so neither the API nor
the existing tests saw them; each one cost a `deadlock_timeout` (1 s) plus a re-run.

Two cycles were found in the log:

1. **Allocation.** `allocationCandidates` locked candidate positions `FOR UPDATE` **per order
   line**. Order 1 (SKU A, then B) and order 2 (B, then A) each held the first SKU's rows and
   waited for the other's. Transfer allocation had the same shape.
2. **Moves.** A move locked the source, then created or locked the target. Two moves in opposite
   directions between the same two positions each held one row and waited for the other.

**Decision.**

- One rule for `stock_positions`: rows are locked **in ascending id order, in one statement**.
- `lockAllocationCandidates(warehouse, skuIds)` (engine): one `SELECT … ORDER BY p.id FOR UPDATE
OF p` over every allocatable candidate of every SKU on the document, called by outbound and
  transfer `allocate` after the document lines are locked and before the per-line loop. The
  per-line `allocationCandidates` then re-locks rows the transaction already holds (no wait).
- `lockMoveSourceAndTarget(position, target)` (engine): read the source without a lock, resolve
  the target holder, find the existing target position, then `lockPositions([source, target])`;
  if the source's status or lot changed in between, refuse with `CONCURRENT_CHANGE` (409) so the
  client re-reads. A target that does not exist yet is created by `ensurePosition` after the
  ordered lock, so it cannot take part in a cycle. Used by `stock.service.ts move`.
- Regression test `tests/integration/lock-ordering.test.ts`: 30 rounds (6 concurrent) of
  outbound and transfer allocations with opposite line order plus opposite moves between the
  same positions; asserts PostgreSQL's own `pg_stat_database.deadlocks` counter is unchanged
  (read after `pg_stat_clear_snapshot()` and a 1.5 s settle), total stock conserved and the
  reconciliation clean. **Verified to fail** (two runs) with the lock calls removed and the old
  `move` restored, and to pass three times in a row with the fix.
- The load harness reports deadlocks seen during the run and **per-step timings** (`create`,
  `allocate`, `cancel`) so contention is visible as a number, not only in the server log.

**Ledger growth.** A new `ledger-growth` profile seeds the representative dataset plus
**10 000 000 synthetic ledger rows** (MOVE transactions of 50 net-zero pairs, so positions and
the reconciliation stay consistent; spread over the past year), then runs the same mix and
one-off timings whose cost grows with history: full reconciliation (target 60 s), CSV export of
the run's activity (10 s), a 7-day export that exceeds `EXPORT_MAX_ROWS` and must be **refused
with 409** (10 s), and ledger by SKU (1 s). Results: `docs/perf/LAST_RUN_ledger-growth.md`.

The first representative run with these one-offs "failed" the 7-day export with HTTP 409: the
window held the 100 000 opening-stock rows, above the 100 000-row cap. That is the export
refusing instead of truncating, as designed (v0.5), so the harness now asserts the refusal (and
its speed) instead of treating it as an error. That same run met every latency target
(representative, 25 users: 189 req/s, 0 errors, `order_allocate` p95 469 ms against 500).

The harness also reads `pg_stat_database.deadlocks` before and after every run; any deadlock
fails an enforced run.

**Second finding: the activity (ledger) page grew linearly with history.** A small trial of the
profile (2 000 positions + 300 000 history rows) put the ledger page (`GET …/reports/ledger`,
newest 50 rows) at **p95 4.9 s** against a 300 ms target. `EXPLAIN ANALYZE` under the runtime
role showed the cause: the RLS predicates (`company_id = app_company()`,
`app_wh_visible(warehouse_id)`) are built from `current_setting()`, so the planner cannot
estimate them and assumed 15 transactions and 1 ledger row per transaction (actual: 3 004 and
302 000). On those estimates a nested-loop plan looked cheap, so it joined **the whole ledger**
to transactions, SKUs, users and nodes and only then sorted for the top 50. Fix: both ledger
queries (page and CSV export) now select the page of ledger rows first in a sub-select
(`ORDER BY id DESC LIMIT n`, filters on the ledger's own columns, the type filter as `EXISTS`)
and join only those rows. Same trial data: page 4 146 ms → **2.5 ms** (backward scan of the
primary key, 50 rows read), by SKU 0.8 ms (`inventory_ledger_sku_time`), a 7-day export window
~30 ms. A new test (`reports-search.test.ts`, page filters) pins the result set; it passes
against both the old and the new query. No index or migration was needed.

**Result at 10 M rows** (`ledger-growth`, 10 100 000 ledger rows, 25 users, 2 vCPU): PASSED all
provisional targets — 191 req/s, 0 errors, 0 deadlocks; ledger page p95 132 ms (the same as
with 100 000 rows); full reconciliation 11.2 s (target 60 s; it aggregates the whole ledger, so
it grows linearly and is the first candidate for an incremental check); CSV export of the run
window 0.7 s; over-cap 7-day export refused with 409 in 1.9 s; ledger by SKU 7 ms. Seeding the
history took 168 s.

General lesson recorded for reviewers: under RLS, a query that joins a large table and then
applies `ORDER BY … LIMIT` must limit the large table first; the planner's row estimates for
RLS-filtered tables are not reliable.

**Alternatives.** `SKIP LOCKED` allocation (fast but allocates around rows another order holds,
which may short-allocate an order while stock exists); advisory locks per SKU (works, but a
second lock namespace to keep consistent with row locks); SERIALIZABLE isolation (turns
deadlocks into serialization failures that still need retries and cost throughput); relying on
the retry (correct but slow, and hides the cause).

**Consequences.** Allocation locks more rows up front (all candidates of the document's SKUs,
not only those it ends up reserving), so two orders for the same SKU now serialise for the
whole allocation instead of part of it. Measured: `order_allocate` p95 145–161 ms in smoke and
no new deadlocks. New code that locks positions must use `lockPositions` /
`lockAllocationCandidates` / `lockMoveSourceAndTarget` rather than ad-hoc `FOR UPDATE`. Other
lock targets (documents, lines, containers) are not yet covered by the regression test.

## Addendum (v0.6.10): reconciliation exceeded the API's statement limit

The owner ran `ledger-growth` on a Windows workstation (PostgreSQL 18). The reconciliation
one-off returned **HTTP 500**. Cause: every API statement has a 15 s limit (`statement_timeout`);
reconciliation reads the whole ledger, took 11.2 s at 10 M rows on the 2-vCPU workspace and
more than 15 s on that machine, so PostgreSQL cancelled it (`57014`). The filter did not know that
code and answered "Erro interno". A customer with that much history could not reconcile.

Changes:

- **Aggregate-first query** (`engine.ts reconcile`, and the restore verifier): sum the ledger per
  position in one pass, then join positions. 2.1 M rows: 2 947–3 041 ms → 1 738–1 917 ms (same
  RLS misestimate as the ledger page: the old plan was a nested loop over positions).
- **Own time budget, one run per warehouse.** Reconciliation sets
  `statement_timeout = RECONCILIATION_TIMEOUT_MS` (60 s) for its own transaction and first takes
  `pg_try_advisory_xact_lock('wms.reconcile:<warehouse>')`; a concurrent request gets **409
  `RECONCILIATION_RUNNING`**. A longer budget therefore cannot be used to tie up more than one
  connection per warehouse.
- **Timeouts are explicit:** `57014` maps to **503 `QUERY_TIMEOUT`** (pt-PT message, no internals,
  logged as a warning) for every endpoint.
- **`DB_STATEMENT_TIMEOUT_MS`** (default 15 000; 0 disables) replaces the hard-coded limit; the
  offline restore verifier runs without a limit.
- Test `tests/integration/query-limits.test.ts` (API with a 1 s limit): a blocked read returns 503
  `QUERY_TIMEOUT` and the API recovers; reconciliation outlives the pool limit and a second
  concurrent run gets 409. Both tests fail on the v0.6.9 code (500 instead of 503/409).

Measured at 10 M rows (workspace, `ledger-growth` re-run): reconciliation 11.2 s → **9.6 s**
(the gain shrinks with size because the full ledger scan dominates); the run passed all
provisional targets (198 req/s, 0 errors, 0 deadlocks, ledger page p95 123 ms). The budget, not
the query change, is what removes the failure on slower machines.

Still linear: the 60 s budget covers several times today's 10 M rows on slow hardware, but not
unbounded growth. An incremental, checkpointed reconciliation remains on the roadmap (T-11).
