# ADR-0014 — In-transit stock lives on the transfer document

Status: Accepted. Owning module: WMS.

**Decision.** TRANSFER_OUT removes stock from the source ledger; in transit = shipped − received
− lost on transfer lines; TRANSFER_IN adds to destination staging. No virtual 'transit
warehouse' positions. Each side acts in its own scope; documents expose no internal locations.
**Consequence.** No double counting; company stock = Σ warehouses + in transit.
