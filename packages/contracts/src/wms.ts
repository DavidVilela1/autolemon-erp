/**
 * @file WMS command and query contracts (strict Zod schemas).
 * @module contracts (owning module: WMS)
 *
 * All mutation DTOs use `.strict()` so unknown/extra writable fields are rejected (mass
 * assignment defence). Server-owned fields (ids, company, warehouse, status, counters,
 * actor) never appear in input schemas: they are derived from the authenticated session and
 * the database.
 */
import { z } from 'zod';
import { Barcode, Code, Qty, QtyOrZero, SafeLine, SafeText, Uuid } from './common.js';

/** Fixed storage-node kinds (warehouse topology). */
export const NODE_KINDS = ['ZONE', 'AISLE', 'RACK', 'SHELF', 'BIN', 'LOCATION', 'STAGING', 'INSPECTION', 'QUARANTINE', 'DISPATCH'] as const;
/** Storage node kind. */
export type NodeKind = (typeof NODE_KINDS)[number];

/** Movable container kinds. PACKAGE is created by packing and leaves with dispatch. */
export const CONTAINER_KINDS = ['BOX', 'TOTE', 'PALLET', 'PACKAGE'] as const;
/** Container kind. */
export type ContainerKind = (typeof CONTAINER_KINDS)[number];

/**
 * Stock status of a position. Only AVAILABLE counts towards available-to-allocate.
 * RECEIVED = received into staging, awaiting putaway. PICKED = picked/packed awaiting dispatch.
 */
export const STOCK_STATUSES = ['AVAILABLE', 'RECEIVED', 'INSPECTION', 'QUARANTINE', 'DAMAGED', 'PICKED'] as const;
/** Stock status type. */
export type StockStatus = (typeof STOCK_STATUSES)[number];

/** Lot/serial tracking mode of a SKU. */
export const TRACKING_MODES = ['NONE', 'LOT', 'SERIAL'] as const;

/** Exactly one holder: a fixed node or a movable container. */
export const HolderRef = z
  .object({
    nodeId: Uuid.optional(),
    containerId: Uuid.optional(),
  })
  .strict()
  .refine((h) => (h.nodeId ? 1 : 0) + (h.containerId ? 1 : 0) === 1, 'Indique exatamente um local OU uma caixa');
/** Holder reference type. */
export type HolderRefInput = z.infer<typeof HolderRef>;

const Lot = SafeLine(40).optional();

/**
 * Scan confirmation of the destination: the code read from the destination's label (location
 * code or container code). Optional in the API for compatibility; the pt-PT UI always sends it,
 * and when present the server refuses a mismatch (SCAN_MISMATCH).
 */
const ScanConfirm = Barcode.optional();

/** Validated optional simple attributes (JSONB). Only flat string/number/boolean values. */
export const SkuAttributes = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.union([SafeLine(200), z.number().finite(), z.boolean()]))
  .refine((r) => Object.keys(r).length <= 30, 'Máximo 30 atributos');

// ---------------------------------------------------------------- topology

/** Create a fixed storage node. Nesting rules are enforced server-side (see WMS_STATE_MACHINES.md). */
export const CreateNodeInput = z
  .object({
    parentId: Uuid.optional(),
    kind: z.enum(NODE_KINDS),
    code: Code,
    name: SafeLine(80),
    holdsStock: z.boolean().optional(),
  })
  .strict();

/**
 * Rename and/or (de)activate a node. Codes are immutable (printed on labels). Deactivation is
 * refused while the node or anything below it holds stock, containers or open tasks.
 */
export const UpdateNodeInput = z
  .object({ name: SafeLine(80).optional(), active: z.boolean().optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.active !== undefined, 'Nada para alterar');

/** Create a movable container placed at a fixed node. */
export const CreateContainerInput = z
  .object({
    code: Code,
    kind: z.enum(['BOX', 'TOTE', 'PALLET']),
    nodeId: Uuid,
  })
  .strict();

/** Move a whole container (contents move with it, no redistribution). */
export const MoveContainerInput = z.object({ toNodeId: Uuid, reason: SafeLine(200).optional(), scan: ScanConfirm }).strict();

// ---------------------------------------------------------------- SKU master

/** Create a company-owned stock item. */
export const CreateSkuInput = z
  .object({
    code: Code,
    description: SafeLine(200),
    baseUom: z
      .string()
      .regex(/^[A-Z]{1,8}$/)
      .default('UN'),
    brand: SafeLine(80).optional(),
    manufacturerRef: SafeLine(80).optional(),
    tracking: z.enum(TRACKING_MODES).default('NONE'),
    barcodes: z
      .array(
        z
          .object({
            barcode: Barcode,
            uom: z.string().regex(/^[A-Z]{1,8}$/),
            qtyPerUom: Qty,
          })
          .strict(),
      )
      .max(20)
      .default([]),
    attributes: SkuAttributes.optional(),
  })
  .strict();

// ---------------------------------------------------------------- stock

/** Opening stock / initial load (requires wms.adjust). */
export const OpeningStockInput = z
  .object({
    lines: z
      .array(z.object({ skuId: Uuid, to: HolderRef, qty: Qty, lot: Lot }).strict())
      .min(1)
      .max(500),
    note: SafeText(500).optional(),
  })
  .strict();

/** Generic internal move of stock from a position to a holder (status preserved). */
export const MoveStockInput = z
  .object({
    positionId: Uuid,
    qty: Qty,
    to: HolderRef,
    reason: SafeLine(200).optional(),
    scan: ScanConfirm,
  })
  .strict();

/**
 * Quality status change of unreserved stock (wms.adjust): block AVAILABLE stock
 * (→ QUARANTINE/DAMAGED/INSPECTION) or release it (→ AVAILABLE, also requires step-up).
 * Optionally moves it at the same time (e.g. quarantine area → shelf).
 */
export const ChangeStockStatusInput = z
  .object({
    positionId: Uuid,
    qty: Qty,
    toStatus: z.enum(['AVAILABLE', 'QUARANTINE', 'DAMAGED', 'INSPECTION']),
    to: HolderRef.optional(),
    reason: SafeText(500),
  })
  .strict();

/** Direct audited adjustment (requires wms.adjust + step-up). */
export const AdjustStockInput = z
  .object({
    positionId: Uuid,
    qtyDelta: z
      .union([z.number(), z.string()])
      .transform((v) => String(v).trim())
      .refine((s) => /^-?\d{1,10}(\.\d{1,3})?$/.test(s) && Number(s) !== 0, 'Delta inválido'),
    reasonCode: z.enum(['DAMAGE', 'LOSS', 'FOUND', 'DATA_ERROR', 'OTHER']),
    note: SafeText(500),
  })
  .strict();

// ---------------------------------------------------------------- inbound

/** WMS-native inbound document (no purchase order required). */
export const CreateInboundInput = z
  .object({
    kind: z.enum(['EXPECTED', 'UNPLANNED']),
    externalRef: SafeLine(80).optional(),
    note: SafeText(500).optional(),
    lines: z
      .array(z.object({ skuId: Uuid, qtyExpected: Qty }).strict())
      .max(500)
      .default([]),
  })
  .strict();

/** Replace lines of a DRAFT inbound document (self-service draft correction). */
export const ReplaceInboundLinesInput = z
  .object({ lines: z.array(z.object({ skuId: Uuid, qtyExpected: Qty }).strict()).max(500) })
  .strict();

/** Receive (possibly partial) quantities into a staging/inspection node. */
export const ReceiveInput = z
  .object({
    stagingNodeId: Uuid,
    damagedNodeId: Uuid.optional(),
    lines: z
      .array(
        z
          .object({
            lineId: Uuid.optional(),
            skuId: Uuid.optional(),
            barcode: Barcode.optional(),
            qty: Qty,
            condition: z.enum(['GOOD', 'DAMAGED']).default('GOOD'),
            lot: Lot,
          })
          .strict()
          .refine((l) => l.lineId || l.skuId || l.barcode, 'Indique linha, artigo ou código de barras'),
      )
      .min(1)
      .max(200),
  })
  .strict();

/** Complete (possibly partially) a putaway task. */
export const CompletePutawayInput = z.object({ qty: Qty, to: HolderRef, scan: ScanConfirm }).strict();

// ---------------------------------------------------------------- outbound

/** WMS-native outbound request (no sales order required). */
export const CreateOutboundInput = z
  .object({
    externalRef: SafeLine(80).optional(),
    recipientContact: SafeText(500).optional(),
    lines: z
      .array(z.object({ skuId: Uuid, qty: Qty }).strict())
      .min(1)
      .max(500),
  })
  .strict();

/** Replace lines of a DRAFT outbound request. */
export const ReplaceOutboundLinesInput = z
  .object({
    lines: z
      .array(z.object({ skuId: Uuid, qty: Qty }).strict())
      .min(1)
      .max(500),
  })
  .strict();

/** Pick against a reservation with mandatory barcode verification. */
export const PickInput = z
  .object({
    reservationId: Uuid,
    qty: QtyOrZero,
    barcode: Barcode,
    packingNodeId: Uuid,
    closeShort: z.boolean().default(false),
  })
  .strict();

/** Create a traceable package for an outbound order at the packing (DISPATCH) node. */
export const CreatePackageInput = z.object({ code: Code, nodeId: Uuid }).strict();

/** Pack picked units into a package. */
export const PackInput = z.object({ packageId: Uuid, lineId: Uuid, qty: Qty, barcode: Barcode }).strict();

/**
 * Return picked-but-unpacked units of a line from a packing (DISPATCH) node back to storage
 * (customer cancelled, wrong pick, overpick). Stock becomes AVAILABLE again at `to`.
 */
export const UnpickInput = z.object({ lineId: Uuid, qty: Qty, fromNodeId: Uuid, to: HolderRef, reason: SafeLine(200).optional() }).strict();

/** Take packed (not yet dispatched) units of a line back out of a package. */
export const UnpackInput = z.object({ packageId: Uuid, lineId: Uuid, qty: Qty }).strict();

/** Dispatch selected packages (partial dispatch allowed). */
export const DispatchInput = z.object({ packageIds: z.array(Uuid).min(1).max(100), carrierRef: SafeLine(80).optional() }).strict();

/** Close an outbound order; optionally create a backorder for unfulfilled quantities. */
export const CloseOutboundInput = z.object({ createBackorder: z.boolean().default(false) }).strict();

// ---------------------------------------------------------------- transfers

/** Inter-warehouse transfer request. */
export const CreateTransferInput = z
  .object({
    sourceWarehouseId: Uuid,
    destWarehouseId: Uuid,
    lines: z
      .array(z.object({ skuId: Uuid, qty: Qty }).strict())
      .min(1)
      .max(200),
  })
  .strict();

/** Source-side dispatch of a transfer from specific source positions. */
export const DispatchTransferInput = z
  .object({
    lines: z
      .array(z.object({ lineId: Uuid, positionId: Uuid, qty: Qty }).strict())
      .min(1)
      .max(200),
  })
  .strict();

/** Destination-side receipt of a transfer into staging. */
export const ReceiveTransferInput = z
  .object({
    stagingNodeId: Uuid,
    lines: z
      // `lot` picks the lot bucket to receive; omitted → lots in transit are received in lot-code order.
      .array(z.object({ lineId: Uuid, qty: Qty, lot: Lot }).strict())
      .min(1)
      .max(200),
  })
  .strict();

// ---------------------------------------------------------------- returns

/** Warehouse return receipt into an inspection node (no CRM needed). */
export const CreateReturnInput = z
  .object({
    externalRef: SafeLine(80).optional(),
    inspectionNodeId: Uuid,
    lines: z
      .array(z.object({ skuId: Uuid, qty: Qty }).strict())
      .min(1)
      .max(200),
  })
  .strict();

/** Disposition after inspection. */
export const ReturnDispositionInput = z
  .object({
    lines: z
      .array(
        z
          .object({
            lineId: Uuid,
            disposition: z.enum(['SALEABLE', 'QUARANTINE', 'DAMAGED', 'SCRAP']),
            qty: Qty,
            to: HolderRef.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

// ---------------------------------------------------------------- counts

/** Open a stock count session. */
export const CreateCountInput = z
  .object({
    kind: z.enum(['FULL', 'PARTIAL', 'CYCLE']),
    nodeIds: z.array(Uuid).max(500).default([]),
    skuIds: z.array(Uuid).max(500).default([]),
  })
  .strict();

/** Record a counted quantity for a count line. */
export const RecordCountInput = z.object({ qtyCounted: QtyOrZero }).strict();

/** Record stock found during counting that the system did not expect. */
export const FoundStockInput = z.object({ skuId: Uuid, holder: HolderRef, qtyCounted: Qty, lot: Lot }).strict();

// ---------------------------------------------------------------- replenishment & corrections

/** Upsert a replenishment rule for a pick location. */
export const ReplenishmentRuleInput = z.object({ skuId: Uuid, pickNodeId: Uuid, minQty: QtyOrZero, targetQty: Qty }).strict();

/** Execute a replenishment move. */
export const ExecuteReplenishmentInput = z.object({ ruleId: Uuid, fromPositionId: Uuid, qty: Qty, scan: ScanConfirm }).strict();

/** Reverse a posted inventory transaction with a compensating transaction. */
export const ReverseTransactionInput = z.object({ reason: SafeLine(200) }).strict();

/** Ledger / activity search filters. */
export const LedgerQuery = z
  .object({
    skuId: Uuid.optional(),
    type: z
      .string()
      .regex(/^[A-Z_]{1,40}$/)
      .optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
