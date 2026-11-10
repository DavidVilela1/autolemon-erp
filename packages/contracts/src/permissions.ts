/**
 * @file Permission catalogue and role defaults (default deny).
 * @module contracts (owning module: platform authorization)
 *
 * The catalogue is the single source of truth used by the API (service-layer checks), the
 * database seed and the UI (to hide unusable actions — hiding is cosmetic only).
 */

/** Every permission recognised by the system. Unknown strings are rejected at validation. */
export const PERMISSIONS = [
  'wms.view',
  'wms.receive',
  'wms.putaway',
  'wms.pick',
  'wms.pack',
  'wms.dispatch',
  'wms.transfer.dispatch',
  'wms.transfer.receive',
  'wms.returns',
  'wms.count',
  'wms.count.approve',
  'wms.adjust',
  'wms.replenish',
  'wms.topology.manage',
  'wms.sku.manage',
  'wms.outbound.manage',
  'wms.inbound.manage',
  'wms.report',
  'wms.export',
  'pii.read',
  'admin.users',
  'admin.security',
  'admin.audit.read',
] as const;

/** A single permission name. */
export type Permission = (typeof PERMISSIONS)[number];

/** Account role. ADMIN = company administrator (all permissions, may switch warehouses). */
export const ROLES = ['ADMIN', 'STAFF'] as const;
/** Account role type. */
export type Role = (typeof ROLES)[number];

/**
 * Permissions that may never be granted to STAFF accounts, regardless of what an
 * administrator requests. They are reserved to ADMIN.
 */
export const ADMIN_ONLY_PERMISSIONS: readonly Permission[] = ['admin.users', 'admin.security', 'admin.audit.read', 'pii.read'];

/**
 * Actions that require a recent step-up MFA verification (default: 5 minutes) in addition to a
 * fully authenticated session. Used by the API guard; listed here for UI hints.
 */
export const STEP_UP_ACTIONS = [
  'users.role.change',
  'users.warehouse.change',
  'users.mfa.reset',
  'users.password.reset',
  'keys.rotate',
  'report.export',
  'inventory.adjust.approve',
  'pii.read',
  'account.mfa.change',
] as const;
/** Step-up action identifier. */
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

/** Default permission set suggested for new warehouse operators (administrator can edit). */
export const DEFAULT_STAFF_PERMISSIONS: readonly Permission[] = [
  'wms.view',
  'wms.receive',
  'wms.putaway',
  'wms.pick',
  'wms.pack',
  'wms.dispatch',
  'wms.transfer.dispatch',
  'wms.transfer.receive',
  'wms.returns',
  'wms.count',
  'wms.replenish',
  'wms.report',
];
