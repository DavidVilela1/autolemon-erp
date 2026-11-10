# ADR-0023 — Activity export and cross-document search

Status: Accepted (v0.6.1). Owning module: WMS (reports). Gate item F-12.

**Context.** Operators need to find any document by number or by the external reference printed
on paper (supplier guide, customer order) and supervisors need the movement history outside the
application. Both are data-exfiltration paths if done carelessly.

**Decision.**

- `GET /api/wms/w/{wh}/search?q=` (wms.view): one UNION query over inbound/outbound/returns/counts
  (warehouse-scoped), transfers where the warehouse is source **or** destination, SKUs (code,
  description, barcode), locations and containers. 2–64 characters, no control characters; LIKE
  metacharacters (`% _ \`) are escaped so text matches literally; the value is always a bound
  parameter. At most 10 hits per kind. Encrypted fields (recipient contacts) are never searched.
- `GET /api/wms/w/{wh}/reports/ledger.csv?from=&to=&type=&skuId=` (wms.export + step-up +
  security audit with the filter and row count): a **period** is mandatory (≤ 366 days) and the
  export is refused (`EXPORT_TOO_LARGE`) above 100 000 rows instead of being silently truncated,
  so an exported file is always complete for the period it names. Each line carries the
  document number resolved from the transaction reference.
- CSV encoding: formula-leading cells are prefixed with `'`, except plain signed decimals
  (`-2.000`), which cannot be formulas and must stay numeric for spreadsheets (`-2+3`, `-1e5`
  are still prefixed).

**Alternatives.** Full-text search (`tsvector`) — unnecessary for codes/numbers and adds
indexes to maintain; streaming unbounded exports — conflicts with "complete and bounded".

**Maintenance.** New document types must be added to the UNION (and to the search test). Index
`ILIKE` columns with `pg_trgm` if a warehouse exceeds ~10⁵ documents (measure first; E-04).
