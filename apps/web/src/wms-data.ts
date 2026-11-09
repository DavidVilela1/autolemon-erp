/**
 * @file Typed data loaders shared by WMS screens.
 * @module web
 */
import { api } from './api';

/** Generic API row (all values arrive as strings/numbers/nulls). */
export type Row = Record<string, string | null>;

/** Storage node. */
export interface NodeRow {
  id: string;
  parentId: string | null;
  kind: string;
  code: string;
  name: string;
  holdsStock: boolean;
  depth: number;
  path: string;
}

/** Container. */
export interface ContainerRow {
  id: string;
  code: string;
  kind: string;
  status: string;
  nodeId: string;
  nodePath: string;
  qtyTotal: string;
}

/** SKU. */
export interface SkuRow {
  id: string;
  code: string;
  description: string;
  brand: string | null;
  baseUom: string;
  status: string;
  barcodes: Array<{ barcode: string; uom: string; qtyPerUom: string }>;
}

/** Warehouse-scoped base path. */
export const wp = (wh: string) => `/api/wms/w/${wh}`;

/** Loads nodes of a warehouse. */
export const loadNodes = (wh: string) => api<NodeRow[]>('GET', `${wp(wh)}/nodes`);
/** Loads containers of a warehouse. */
export const loadContainers = (wh: string) => api<ContainerRow[]>('GET', `${wp(wh)}/containers`);
/** Loads SKUs (optional search). */
export const loadSkus = (q = '') => api<SkuRow[]>('GET', `/api/wms/skus${q ? `?q=${encodeURIComponent(q)}` : ''}`);
/** Loads positions (optionally for one SKU). */
export const loadPositions = (wh: string, skuId?: string) => api<Row[]>('GET', `${wp(wh)}/stock${skuId ? `?skuId=${skuId}` : ''}`);

/** Select options for nodes of given kinds. */
export function nodeOptions(nodes: NodeRow[] | undefined, kinds?: string[]) {
  return (nodes ?? [])
    .filter((n) => n.holdsStock && (!kinds || kinds.includes(n.kind)))
    .map((n) => ({ value: n.id, label: `${n.path} (${n.kind})` }));
}

/** Holder options: stock-holding nodes plus active non-package containers. */
export function holderOptions(nodes: NodeRow[] | undefined, containers: ContainerRow[] | undefined, kinds = ['SHELF', 'BIN', 'LOCATION']) {
  return [
    ...nodeOptions(nodes, kinds).map((o) => ({ ...o, value: `n:${o.value}` })),
    ...(containers ?? [])
      .filter((c) => c.status === 'ACTIVE' && c.kind !== 'PACKAGE')
      .map((c) => ({ value: `c:${c.id}`, label: `Caixa ${c.code} @ ${c.nodePath}` })),
  ];
}

/** Converts a holder option value into the API HolderRef. */
export function holderRef(v: string): { nodeId?: string; containerId?: string } {
  return v.startsWith('c:') ? { containerId: v.slice(2) } : { nodeId: v.slice(2) };
}

/** Human labels for stock statuses (pt-PT). */
export const STATUS_PT: Record<string, string> = {
  AVAILABLE: 'Disponível',
  RECEIVED: 'Recebido (por arrumar)',
  INSPECTION: 'Em inspeção',
  QUARANTINE: 'Quarentena',
  DAMAGED: 'Danificado',
  PICKED: 'Separado',
};
