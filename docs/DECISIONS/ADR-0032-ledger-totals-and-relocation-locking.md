# ADR-0032 — Trigger-maintained ledger totals; relocation lock ordering; order lookups

Status: Accepted (v0.6.13). Owning module: wms (inventory engine). Gate E-04 (T-11), E-02.
Follows ADR-0031.

## 1. Reconciliation that stays flat as the ledger grows

**Context.** Reconciliation (INVARIANT L1) compared every position's balance with the sum of its
ledger rows. It is linear in ledger size: 9.6 s at 10 M rows on the 2-vCPU workspace, more than
15 s on the owner's PC (v0.6.10 gave it a 60 s budget and one run per warehouse at a time).

**Decision.** Migration 0010 adds `position_ledger_totals` (one row per position) maintained by an
`AFTER INSERT` trigger on `inventory_ledger` (`SECURITY DEFINER`, owned by the schema owner):

- The ledger is append-only (UPDATE/DELETE refused by `inventory_ledger_append_only`), so the
  total is exact and changes in the same transaction as the ledger row — it never lags and needs
  no "safe horizon" logic.
- Every ledger insert happens while the transaction holds that position's row lock, so the
  totals row is written behind a lock the transaction already holds: no new lock-ordering risk.
- The runtime role can only `SELECT` the totals (RLS, warehouse isolation); it cannot insert,
  update, delete or call the trigger function.
- The migration locks the ledger against writers (`SHARE ROW EXCLUSIVE`), installs the trigger
  and back-fills the totals from the existing ledger, so no row can fall between the two.

Reconciliation now has two forms:

| Form                                   | Compares                                                    | Cost               | Limits                                        |
| -------------------------------------- | ----------------------------------------------------------- | ------------------ | --------------------------------------------- |
| routine (`GET …/stock/reconciliation`) | balance vs. trigger total, per position                     | O(positions), flat | normal pool limit                             |
| deep (`…?full=true`)                   | balance vs. ledger sum **and** trigger total vs. ledger sum | O(ledger)          | 60 s budget, one deep run per warehouse (409) |

The deep form is the independent check of the totals themselves (a trigger bug, or a privileged
edit of the totals table); the restore verifier also checks totals against the ledger. Reservation
reconciliation now aggregates the ACTIVE reservations first (partial index), so reservation
history does not slow it down.

**Alternatives.** Checkpointed sums with a commit horizon (needs a writer-blocking lock or `xmin`
reasoning to be correct); application-maintained totals (the same code that maintains balances
would maintain the check — not independent); materialised views (refresh is a full scan).

## 2. Relocations lock source and target together

**Context.** v0.6.9 fixed moves by locking source and existing target together, ascending. The
other relocations still locked the source first and the target later (inside `relocate` →
`ensurePosition`). New race tests showed three of them deadlock — under sustained contention all
three retries can deadlock and the request failed with **HTTP 500**:

- pick (bin → packing node, PICKED) vs. unpick (packing node → bin), other orders, same SKU;
- replenishment (bulk → pick bin) vs. a move in the opposite direction (when the pick-bin
  position's id sorts below the bulk position's);
- AVAILABLE → QUARANTINE vs. QUARANTINE → AVAILABLE at the same bin.

**Decision.** `lockRelocation(ctx, sourceIds, target)` (engine): reads the sources unlocked,
resolves each target (validation runs here, before any lock), finds the target positions that
already exist, then locks sources and existing targets in one ascending pass, and refuses with
409 `CONCURRENT_CHANGE` if a source's status or lot changed in between. A target that does not
exist yet is created by `ensurePosition` after these locks, so it cannot be part of a cycle.
Used by pick, unpick, replenishment, status change, return disposition and putaway;
`lockMoveSourceAndTarget` (moves) is now a thin wrapper. `lockPositions` lower-cases ids before
sorting so its order always matches PostgreSQL's uuid order.

Pack and unpack were reviewed and left as they are: both lock the order first and packages
belong to one order, so two packs/unpacks over the same pair of rows are already serialised.

A deadlock or serialization failure that survives the retries now returns **503 `BUSY_RETRY`**
(the request had no effect and can be repeated) instead of a generic 500.

`tests/integration/lock-ordering.test.ts` runs each race (both directions, 20 rounds, 4
concurrent) and asserts PostgreSQL's deadlock counter is unchanged and the deep reconciliation is
clean. All three races fail on the v0.6.12 code (two runs each) and pass with the fix (three runs).

## 3. "The reservations of this order" starts from the order

**Context.** The new picking load scenario showed the order view (`GET /outbound/{id}`) at p50
172 ms / p95 550 ms under load (0.5 ms alone). `auto_explain` captured the live plan: with no
index on `reservations.outbound_line_id`, stale statistics on growing tables and RLS predicates
the planner cannot estimate, PostgreSQL started from every active reservation and joined it with
every SKU of the company (53 × 500 = 26 500 rows) before filtering on the order.

**Decision.** Migration 0011 adds `reservations (outbound_line_id) WHERE status = 'ACTIVE'` and
`containers (outbound_id)`. The order and transfer pick lists start from the document's lines in
a `MATERIALIZED` CTE; releasing an order's reservations selects them by line id. Smoke: order
view p50 172 → 23 ms, p95 550 → 36 ms; the whole pick flow p95 783 → 340 ms; throughput
112 → 171 req/s.

## Consequences

- Every ledger insert also upserts one totals row (same transaction, row already locked by it).
- Migration 0010 blocks ledger writes while it back-fills; 0011 blocks writes to two tables while
  building indexes (OPERATIONS.md, "Migrations that take locks").
- New code that relocates stock must use `lockRelocation`; queries that join a large table under
  RLS must start from the selective side (DATABASE.md §5).

## Results at 10 M ledger rows

2 vCPU workspace, load generator in the same process, closed loop without think time, targets
PROVISIONAL (`docs/perf/LAST_RUN_*.md`):

| Profile        | Ledger rows | Throughput | Errors | Deadlocks | Routine reconciliation | Deep reconciliation | `order_pick` p95 | Result                            |
| -------------- | ----------- | ---------- | ------ | --------- | ---------------------- | ------------------- | ---------------- | --------------------------------- |
| representative | ≈100 000    | 125 req/s  | 0      | 0         | 306 ms                 | 561 ms              | 1 017 ms         | **FAILED** (`order_pick` > 1 000) |
| ledger-growth  | 10 100 000  | 130 req/s  | 0      | 0         | 467 ms                 | 11 072 ms           | 986 ms           | PASSED                            |

The ledger grew ×100 and the routine reconciliation ×1.5 (it reads one totals row per position);
the deep form grew ×20. Synthetic history took 346 s to insert (266 s without the trigger — the
cost of one totals upsert per ledger row); the migration-0010 back-fill aggregate over the 10.1 M
rows took 1.5 s (data freshly written, cached).

`order_pick` is 5–7 requests in a row. With 25 closed-loop users and no think time the 2 vCPUs are
saturated (even a single stock lookup is p50 ≈ 96 ms here, 16 ms in the smoke run), so the flow's
p95 lands around 1 s. The 1 000 ms target was proposed by the developer before the run and was
not changed afterwards: representative is recorded as **FAILED** on that target. Real targets and
a run on production-equivalent hardware are owner decisions (E-04).
