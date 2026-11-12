# API — AutoLemon ERP v0.6.6

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

| Group         | Paths                                                                                                                                                                                                                                               | Permission (service-enforced)                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Auth          | `POST /api/auth/login`, `/mfa/verify`, `/mfa/passkey/options`, `/mfa/passkey/verify`, `/step-up`, `/step-up/passkey/options`, `/step-up/passkey`, `/logout`, `/enrollment/start`, `/enrollment/confirm`, `/password/reset`; `GET /api/auth/session` | public / session                                                                             |
| Account       | `GET /api/auth/passkeys`, `POST /passkeys/register/options`, `/passkeys/register`, `/passkeys/{id}/revoke`, `/password/change`, `GET /sessions`, `POST /sessions/{id}/revoke`, `/sessions/revoke-others`, `/recovery-codes/regenerate`              | own account only (+step-up for passkeys and recovery codes)                                  |
| Admin         | `/api/admin/warehouses`, `/api/admin/users[...]`, `/api/admin/keys/rotate`, `/api/admin/audit[/verify]`, `/api/session/warehouse`                                                                                                                   | admin.users, admin.security (+step-up), pii.read (+step-up), admin.audit.read                |
| System        | `GET /api/health` (public), `GET /api/system/modules`                                                                                                                                                                                               | session                                                                                      |
| SKUs          | `GET/POST /api/wms/skus`, `POST /api/wms/skus/import` (text/csv)                                                                                                                                                                                    | wms.view / wms.sku.manage                                                                    |
| Topology      | `/api/wms/w/{wh}/nodes`, `/nodes/{nodeId}` (rename/deactivate), `/containers`, `/containers/{id}/move`, `/containers/{id}/close`, `/containers/{id}/history`                                                                                        | wms.view / wms.topology.manage / wms.putaway                                                 |
| Search        | `/api/wms/w/{wh}/search?q=` (2–64 chars; documents, SKUs, locations, containers)                                                                                                                                                                    | wms.view                                                                                     |
| Stock         | `/stock`, `/stock/summary`, `/stock/reconciliation`, `/stock/opening`, `/stock/move`, `/stock/status`, `/stock/adjust`, `/transactions/{id}/reverse`                                                                                                | wms.view / wms.report / wms.adjust (+step-up for adjust, reversal and release) / wms.putaway |
| Inbound       | `/inbound`, `/inbound/{id}`, `/lines`, `/release`, `/cancel`, `/receive`, `/close`; `/putaway`, `/putaway/{id}/suggestions`, `/complete`                                                                                                            | wms.inbound.manage / wms.receive / wms.putaway                                               |
| Outbound      | `/outbound`, `/{id}`, `/lines`, `/allocate`, `/pick`, `/unpick`, `/packages`, `/pack`, `/unpack`, `/dispatch`, `/close`, `/cancel`, `/dispatch-note`                                                                                                | wms.outbound.manage / wms.pick / wms.pack / wms.dispatch                                     |
| Transfers     | `/api/wms/transfers`, `/{id}`, `/{id}/dispatch`, `/{id}/cancel` (source), `/{id}/receive` (optional `lot`), `/{id}/close` (destination)                                                                                                             | wms.transfer.dispatch (source) / wms.transfer.receive (destination)                          |
| Returns       | `/returns`, `/returns/{id}/disposition`                                                                                                                                                                                                             | wms.returns                                                                                  |
| Counts        | `/counts`, `/{id}`, `/lines/{lineId}/count`, `/found`, `/submit`, `/lines/{lineId}/recount`, `/approve`, `/cancel`                                                                                                                                  | wms.count / wms.count.approve (+step-up, different user)                                     |
| Replenishment | `/replenishment/rules`, `/suggestions`, `/execute`                                                                                                                                                                                                  | wms.replenish                                                                                |
| Reports       | `/reports/ledger`, `/reports/discrepancies`, `/reports/stock`, `/reports/stock.csv`, `/reports/ledger.csv?from=&to=&type=&skuId=` (≤ 366 days), `/api/wms/reports/in-transit`                                                                       | wms.report / wms.export (+step-up, audited)                                                  |

## Sample: receive by scan

```http
POST /api/wms/w/0b9c…/inbound/5f1e…/receive
Cookie: __Host-al_sid=…
Origin: https://erp.example.internal
X-Requested-With: autolemon
X-CSRF-Token: …
Idempotency-Key: example-receive-0001
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

## Lots and serials (v0.6.2)

- Receipt-like bodies (`/inbound/{id}/receive` lines, `/stock/opening` lines, `/returns` lines,
  `/counts/{id}/found`) accept `lot` (≤ 40 chars) and `expiresOn` (`YYYY-MM-DD`, requires a lot).
  LOT/SERIAL SKUs without a lot → `400`; conflicting expiry → `409 LOT_EXPIRY_MISMATCH`.
- `/outbound` and `/outbound/{id}/lines` lines accept `lot` (must exist for the SKU, else `404`).
- Serial SKUs: `409 SERIAL_QTY` (more than 1 unit per serial), `409 SERIAL_DUPLICATE` (already on
  hand or in transit).
- `GET /stock` rows include `expiresOn` and `expired`; outbound `pickList` rows include `lot`.

## Transfer reservations and expiry report (v0.6.3)

- `POST /api/wms/w/{wh}/transfers/{id}/allocate` (source warehouse, `wms.transfer.dispatch`,
  `Idempotency-Key`) reserves open quantity per line (FEFO; expired lots excluded). Response
  `{ id, lines: [{ lineId, reserved, missing }] }`; shortages are reported, not refused.
- `GET /transfers/{id}` lines include `qtyReserved`; the source also gets `pickList` (reserved
  positions with path, container, lot and quantity). Dispatch consumes reservations first;
  cancel releases them. Destination close while the source holds reservations →
  `409 TRANSFER_RESERVED`.
- `GET /api/wms/w/{wh}/reports/expiry?days=30` (`wms.report`, `days` 0–365) lists positions
  whose lot expires within the window, including expired ones (`expired: true`), ordered by
  expiry; at most 2000 rows.

## Security monitoring (v0.6.4, ADR-0026) — administrators only

- `GET /api/admin/security/overview?windowMinutes=60` (`admin.audit.read`; 5–10 080) →
  `{ windowMinutes, counters: { loginFailure, mfaFailure, accessDenied, recoveryCodeUsed, mfaReset,
passwordChange, passkeyChange, piiRead, export, keyRotation, privilegeChange, loginSuccess },
openAlerts: { CRITICAL, HIGH, MEDIUM, LOW }, auditChain: { verifiedSeq, verifiedAt, result,
brokenAtSeq } | null, outbox: { pending, oldestPendingAt }, monitor: { intervalSeconds,
channels, rules } }`. Never returns the webhook URL or secret.
- `GET /api/admin/security/alerts?status=OPEN|ACKNOWLEDGED|ALL&limit=100` (`admin.audit.read`).
  Only the caller's company; system alerts are not listed.
- `POST /api/admin/security/alerts/{id}/ack` body `{ "note"?: string ≤ 300 }` (`admin.security`
  - step-up `security.alert.ack`). Errors: `403 STEP_UP_REQUIRED`, `404` (unknown or other
    company), `409 ALERT_ALREADY_ACKNOWLEDGED`.
- Webhook payload (optional): `POST` JSON `{ type: "autolemon.security_alert", version: 1, alert:
{ id, rule, severity, companyId, occurrences, windowMinutes, firstSeenAt, details } }` with
  headers `X-AutoLemon-Timestamp` and `X-AutoLemon-Signature: v1=<hex HMAC-SHA256(secret,
timestamp + "." + body)>`. Receivers verify the signature, reject timestamps older than 5 min
  and de-duplicate on `alert.id`.

## Session controls (v0.6.6, ADR-0028)

- `POST /api/admin/users/{id}/sessions/revoke` → `{ userId, revoked }`; `POST
/api/admin/sessions/revoke-all` → `{ revoked }`. Both `admin.security` + step-up
  `users.sessions.revoke`; the caller's current session is kept; audited
  (`admin.user.sessions_revoked`, `admin.sessions.revoke_all`). Errors: `403 STEP_UP_REQUIRED`,
  `404` (user of another company).
- `POST /api/auth/sessions/{id}/revoke` (another own session) and `POST
/api/auth/sessions/revoke-others` now require step-up `account.sessions.revoke` (`403
STEP_UP_REQUIRED`); revoking the current session needs none.
- Every API request with `Sec-Fetch-Site: cross-site` → `403` (reads included).
- `POST /api/auth/logout` adds `Clear-Site-Data: "cache", "storage"`.
- Recovery codes are now `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX` (120 bits); the 4-group format is still
  accepted for codes issued before v0.6.6.
