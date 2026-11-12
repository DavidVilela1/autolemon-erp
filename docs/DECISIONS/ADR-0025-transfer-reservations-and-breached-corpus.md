# ADR-0025 — Source-side transfer reservations and offline breached-password corpus

Status: Accepted (v0.6.3). Owning module: WMS (reservations), platform/auth (corpus). Tasks
T-26 and T-04; gate F-07/F-08 open action, S-06 open item SEC-OPEN-004.

## 1. Transfer reservations at the source (T-26)

**Context.** A transfer only took stock when it was dispatched. Between planning and dispatch an
outbound allocation could consume the same units, so the source discovered the shortage only at
the loading dock, and the destination had no way to know whether the stock was secured.

**Decision.**

- Migration 0008: `reservations.outbound_line_id` becomes nullable, new
  `reservations.transfer_line_id` (composite FK with `company_id` to `transfer_lines`), CHECK
  `reservations_one_demand` (exactly one demand line per reservation), partial index on active
  transfer reservations, and `transfer_lines.qty_reserved` (≥ 0).
- `POST /api/wms/w/:wh/transfers/:id/allocate` (source warehouse, `wms.transfer.dispatch`,
  idempotent command `transfer.allocate`) reserves `requested − shipped − reserved` per line
  using the same candidate query as outbound allocation, now shared as
  `allocationCandidates()` in the inventory engine (FEFO, expired lots excluded, rows locked in
  id order, sorted in memory). Shortages are returned per line (`missing`) and are not an error.
- **Dispatch** consumes the line's reservations on the chosen position first, then checks free
  stock; stock may still be dispatched from unreserved positions. When a line is fully shipped,
  leftover reservations are released. **Cancel** releases every reservation of the transfer.
- **Destination close** is refused with `409 TRANSFER_RESERVED` while the source still holds
  reservations for the transfer (the destination sees `qtyReserved` but not the pick list,
  which joins source positions and is hidden by RLS).

**Alternatives.** Reserving automatically at creation (rejected: the source loses control of
timing and partial plans); a separate `transfer_reservations` table (duplicates the engine's
reservation accounting and every free-stock query).

**Consequences.** Any new demand type must add its own column to `reservations` and widen the
CHECK. Reservations do not expire on their own; stale transfers are handled by cancel
(runbook "Transfer stuck").

## 2. Offline breached-password corpus (T-04)

**Context.** Password screening used only a small built-in list (SEC-OPEN-004). Calling an
online service from the API would add an egress dependency and leak timing/metadata.

**Decision.** Optional `BREACHED_PASSWORD_CORPUS` points at a local file of fixed-width lines
(`SHA1HEX\n`, 41 bytes, ascending). `scripts/prepare-breached-corpus.mjs` converts the
owner-downloaded HIBP "ordered by hash" SHA-1 file (`HASH:COUNT`) and verifies the order.
The API checks the file size and first/last ordering at start-up (refuses to start on a malformed file; full ordering is verified by the preparation script) and does a binary
search with positional reads — no network, no loading into memory. The check runs at
invitation enrolment, password change and completion of an administrator-issued reset via `screenPassword()`.

**Consequences.** The corpus (~40 GB uncompressed for the full HIBP set) is not shipped in the
archive and must be provisioned and refreshed by the owner; without it only the built-in list
applies. SHA-1 is used solely as the lookup key required by the public corpus format, not for
password storage (Argon2id unchanged).
