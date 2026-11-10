# ADR-0022 — Scan confirmation of destinations (optional in the API, mandatory in the UI)

Status: Accepted (v0.6.0). Owning module: WMS.

**Context.** Gate item F-05 requires putaway and location/container moves "with scan
verification". Location and container labels encode the node code / container code.

**Decision.** Putaway, stock move, container move and replenishment accept an optional `scan`
field. When present, the server compares it (trimmed, upper-cased) with the destination's code and
refuses a mismatch with `409 SCAN_MISMATCH` before anything is posted. The pt-PT UI makes the field
required for putaway, stock moves and container moves ("Ler etiqueta do destino"), so operators
must scan the label they are standing at; keyboard-wedge scanners submit with Enter.

**Why optional in the API.** Existing API clients and integrations (and automated flows without a
physical label) keep working; making it mandatory server-side would be a breaking API change. A
company policy flag "scan required" can be added later without a migration.

**Consequences.** Wrong-location putaway by scan is prevented in the UI; API callers that skip the
field accept the risk. Replenishment UI still lacks the scan prompt (open action in F-05).
