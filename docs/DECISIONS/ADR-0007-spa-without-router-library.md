# ADR-0007 — SPA hash router without a router library; barcode as SVG

Status: Accepted. Owning module: web.

**Decision.** ~40-line hash router; one-time tokens in the URL fragment are removed immediately
(`history.replaceState`). Barcodes: JsBarcode in object mode (encoder only), bars rendered by
React as SVG rects — strict CSP without `unsafe-inline` styles in production.
**Alternatives.** react-router 8 (fine, but unnecessary dependency/API churn for ~15 routes).
**Maintenance.** Switch to a router library if nested layouts/data loaders are needed.
