# Extending AutoLemon (code-first)

Owning module: platform. There is no runtime module upload, no customer scripts and no no-code
builder. Extensions are reviewed code compiled into the build.

## 1. Choose the right mechanism

| Need                                                               | Mechanism                                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| A simple descriptive attribute on SKUs (e.g. `colour`, `oem_note`) | `skus.attributes` JSONB — keys `^[a-z][a-z0-9_]{0,39}$`, string/number/boolean values, ≤ 30 keys (validated by `SkuAttributes`) |
| A new relationship (e.g. vehicle fitment, supplier links)          | Extension-owned relational tables with composite tenant FKs (`(sku_id, company_id) → skus(id, company_id)`)                     |
| A new business capability (Sales, Purchasing, Catalog, Finance)    | New module directory + migrations + permissions + services + controllers + tests, registered in `platform/modules/registry.ts`  |

Never build a generic EAV model.

## 2. Adding a module (checklist)

1. `apps/api/src/<module>/` with services (plain classes) and `http/<module>.controller.ts`.
2. Migration `NNNN_<module>.sql`: owner banner comment, tenant columns, composite FKs, CHECKs,
   RLS policies (company + warehouse where relevant), grants for `autolemon_app`
   (no DELETE on history tables), append-only triggers for ledgers.
3. Permissions: add to `PERMISSIONS` in `packages/contracts/src/permissions.ts` (decide if
   ADMIN-only); document in `docs/security/AUTH_AND_RBAC.md`.
4. Contracts: strict Zod DTOs in `packages/contracts`.
5. Wire services in `composition.ts`; register the descriptor (id, version, requires, publishes)
   in `INSTALLED_MODULES`; add controllers to `AppModule` only when enabled.
6. Integrate with WMS **only** through WMS services (e.g. create a WMS-native outbound request,
   read stock summary) and by subscribing to outbox events via `OutboxDispatcher.subscribe`.
   Never `UPDATE stock_positions`, `INSERT inventory_ledger`, or read decrypted secrets/auth state.
7. Tests: unit, integration (real Postgres), negative authz (cross-warehouse, cross-tenant),
   idempotency, concurrency where stock is involved.
8. Docs: ADR, DATABASE.md section, API (regenerate OpenAPI), threat model delta.

## 3. Adding a field

- Non-sensitive scalar on an existing entity: migration `ALTER TABLE … ADD COLUMN` with CHECK +
  update DTO + service + OpenAPI + tests.
- Sensitive field: `<name>_enc text`, register in `ENCRYPTED_FIELDS`, encrypt in the service with
  `FieldCrypto.encrypt({companyId, table, recordId, field})`, decrypt only after an explicit
  permission check, exclude from exports, add rotation test.

## 4. Security review for every extension / executable script

Threat analysis (update THREAT_MODEL), manual code review by a second engineer, permission review,
migration review (locks, backfill, rollback), dependency audit (`pnpm security:scan`), negative
security tests. CODEOWNERS require a security reviewer for platform/auth/crypto/authz,
migrations and inventory code.

## 5. Hooks available to extensions

| Hook                                                 | Guarantees                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| WMS services (`Services.inbound/outbound/stock/...`) | authorization, warehouse scope, idempotency, invariants               |
| Outbox events (versioned)                            | at-least-once, per-tenant RLS context; subscribers must be idempotent |
| `AuditService.record/recordInTx`                     | hash-chained security audit                                           |
| `FieldCrypto`                                        | tenant-bound AEAD                                                     |

Not exposed: direct balance mutation, decrypted secrets of other modules, session/MFA state.
