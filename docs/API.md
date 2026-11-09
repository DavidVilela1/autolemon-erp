# API — AutoLemon ERP v0.5.0

Owning module: platform/http. The machine-readable spec is **generated from the code**:
`docs/api/openapi.json` (OpenAPI 3.1, 89 operations). Regenerate with
`pnpm --filter @autolemon/api openapi`; `pnpm api:check` fails when the committed spec drifts.

## Conventions

| Concern     | Rule                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport   | Same-origin `/api/*` behind the web origin (Vite proxy in dev, reverse proxy in prod)                                                                                                       |
| Auth        | Opaque session cookie `__Host-al_sid` (HttpOnly, Secure, SameSite=Strict)                                                                                                                   |
| CSRF        | Every non-GET: `X-Requested-With: autolemon`, matching `Origin`, `X-CSRF-Token` (from login/verify/session responses)                                                                       |
| Idempotency | Every mutating `/api/wms/*` call: `Idempotency-Key` (8–80 `[A-Za-z0-9_-]`). Same key + same payload ⇒ stored result with `replayed: true`; different payload ⇒ 409 `IDEMPOTENCY_KEY_REUSED` |
| Validation  | Strict Zod schemas; unknown fields ⇒ 400 `VALIDATION_FAILED` with `details[{path,message}]` (values never echoed)                                                                           |
| Quantities  | JSON number or decimal string, ≤ 3 decimals, returned as decimal strings (`"12.000"`)                                                                                                       |
| IDs         | lower-case UUIDs; invalid ⇒ 400; out of scope ⇒ 404 (indistinguishable from missing)                                                                                                        |
| Errors      | `{ "error": { "code", "message", "details?" }, "requestId" }` — no stack traces                                                                                                             |
| Step-up     | 403 `STEP_UP_REQUIRED` with `error.action`; call `POST /api/auth/step-up` then retry                                                                                                        |

## Endpoint groups (see OpenAPI for schemas)

| Group         | Paths                                                                                                                                                | Permission (service-enforced)                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Auth          | `POST /api/auth/login`, `/mfa/verify`, `/step-up`, `/logout`, `/enrollment/start`, `/enrollment/confirm`, `/password/reset`; `GET /api/auth/session` | public / session                                                              |
| Admin         | `/api/admin/warehouses`, `/api/admin/users[...]`, `/api/admin/keys/rotate`, `/api/admin/audit[/verify]`, `/api/session/warehouse`                    | admin.users, admin.security (+step-up), pii.read (+step-up), admin.audit.read |
| System        | `GET /api/health` (public), `GET /api/system/modules`                                                                                                | session                                                                       |
| SKUs          | `GET/POST /api/wms/skus`, `POST /api/wms/skus/import` (text/csv)                                                                                     | wms.view / wms.sku.manage                                                     |
| Topology      | `/api/wms/w/{wh}/nodes`, `/containers`, `/containers/{id}/move`, `/containers/{id}/history`                                                          | wms.view / wms.topology.manage / wms.putaway                                  |
| Stock         | `/stock`, `/stock/summary`, `/stock/reconciliation`, `/stock/opening`, `/stock/move`, `/stock/adjust`, `/transactions/{id}/reverse`                  | wms.view / wms.report / wms.adjust (+step-up for adjust) / wms.putaway        |
| Inbound       | `/inbound`, `/inbound/{id}`, `/lines`, `/release`, `/cancel`, `/receive`, `/close`; `/putaway`, `/putaway/{id}/suggestions`, `/complete`             | wms.inbound.manage / wms.receive / wms.putaway                                |
| Outbound      | `/outbound`, `/{id}`, `/lines`, `/allocate`, `/pick`, `/packages`, `/pack`, `/dispatch`, `/close`, `/cancel`, `/dispatch-note`                       | wms.outbound.manage / wms.pick / wms.pack / wms.dispatch                      |
| Transfers     | `/api/wms/transfers[/{id}[/dispatch                                                                                                                  | /receive                                                                      | /close]]` | wms.transfer.dispatch (source) / wms.transfer.receive (destination) |
| Returns       | `/returns`, `/returns/{id}/disposition`                                                                                                              | wms.returns                                                                   |
| Counts        | `/counts`, `/{id}`, `/lines/{lineId}/count`, `/found`, `/submit`, `/lines/{lineId}/recount`, `/approve`, `/cancel`                                   | wms.count / wms.count.approve (+step-up, different user)                      |
| Replenishment | `/replenishment/rules`, `/suggestions`, `/execute`                                                                                                   | wms.replenish                                                                 |
| Reports       | `/reports/ledger`, `/reports/discrepancies`, `/reports/stock`, `/reports/stock.csv`, `/api/wms/reports/in-transit`                                   | wms.report / wms.export (+step-up, audited)                                   |

## Sample: receive by scan

```http
POST /api/wms/w/0b9c…/inbound/5f1e…/receive
Cookie: __Host-al_sid=…
Origin: https://erp.example.internal
X-Requested-With: autolemon
X-CSRF-Token: …
Idempotency-Key: 6b0d6f8a0f2b4a6aa0c5e1f2d3c4b5a6
Content-Type: application/json

{ "stagingNodeId": "9a1c…", "lines": [ { "barcode": "5601234567890", "qty": 20 } ] }
```

```json
{ "txnId": "c0f2…", "putawayTaskIds": ["e81a…"] }
```

## Sample: allocate (reservation)

`POST /api/wms/w/{wh}/outbound/{id}/allocate` → `{"id":"…","lines":[{"lineId":"…","allocated":"12","missing":"0"}]}`

## Integration contracts for future modules

Use the WMS application services (in-process) and subscribe to `domain_outbox` events
(`event_type`, `event_version`, `payload`). Event types are listed in
`platform/modules/registry.ts`. Never write WMS tables directly (`docs/EXTENDING_AUTOLEMON.md`).
