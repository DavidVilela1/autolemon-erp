# ADR-0024 — Lot master with expiry (FEFO) and serial-number uniqueness

Status: Accepted (v0.6.2). Owning module: WMS. Task T-20; gate F-07 open action.

**Context.** Positions already carried a lot code, but allocation ignored lots, expiry was not
recorded, and nothing prevented the same serial number from being on hand twice.

**Decision.**

- `sku_lots` (migration 0007): company-wide master row per (SKU, lot/serial) with an optional
  `expires_on`. Created by every receipt-like command through `registerLot()` (inbound receipt,
  opening stock, return receipt, found stock in counts); transfers reuse the existing row so a
  lot keeps its expiry across warehouses. A missing expiry can be filled once; a conflicting
  expiry is refused (`LOT_EXPIRY_MISMATCH`). LOT/SERIAL SKUs require a lot (`400`).
- **Allocation order:** (1) FEFO — earliest expiry first; **expired lots are never allocated**
  (they remain on hand for quarantine/disposal and are flagged in the stock list); undated lots
  after dated ones; (2) lot code ascending (FIFO when codes are date-based; neutral for
  untracked stock); (3) fullest free quantity first; (4) id. Candidate rows are still **locked
  in ascending id order** (deadlock avoidance) and sorted in memory afterwards.
- An outbound line may request one lot/serial (`lot`); allocation then uses only it; unknown
  lots are refused (`404`).
- **Serial invariant in the database:** trigger `wms_serial_guard` on `stock_positions`
  (SECURITY DEFINER so it sees every warehouse of the company regardless of the caller's RLS
  scope; reads only the row's company) refuses more than 1 unit per serial position
  (`SERIAL_QTY`) and a second on-hand position for the same serial (`SERIAL_DUPLICATE`). A
  transaction-scoped advisory lock per (company, SKU, serial) serialises concurrent receipts.
  Moves are allowed because the engine decrements the source before incrementing the target.
  The application additionally refuses receiving a serial that is in transit.

**Alternatives.** Expiry on `stock_positions` (would diverge between positions of one lot);
partial unique index (cannot express "on hand > 0" across holders with moves in one
transaction); FEFO in SQL `ORDER BY ... FOR UPDATE` (lock order would vary → deadlocks).

**Consequences / maintenance.** New receipt paths must call `registerLot()`. Changing a
recorded expiry needs a reviewed admin procedure (not provided). A "near expiry" report and
blocking dispatch of soon-to-expire lots per customer rules are future work.
