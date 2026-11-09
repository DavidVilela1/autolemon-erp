# ADR-0015 — CSV import/export policy

Status: Accepted. Owning module: WMS.

**Decision.** Export: quote every cell, apostrophe-prefix formula triggers, BOM + ';' for pt-PT
Excel, no PII/encrypted columns, wms.export + step-up + audit. Import: SKUs only, text/csv ≤ 1 MB,
≤ 2000 rows, ≤ 12 columns, formula-leading cells rejected, all-or-nothing transaction.
