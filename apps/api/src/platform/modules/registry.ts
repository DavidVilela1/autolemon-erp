/**
 * @file Code-first extension/module registry (no runtime module upload, no customer scripts).
 * @module platform/modules
 *
 * Modules are compiled into the application and reviewed like any other code. ENABLED_MODULES
 * selects which optional modules start; unknown names fail startup (fail closed). In v0.5 only
 * the WMS exists, so the system always runs in WMS-only mode: Sales, Purchasing, Accounting and
 * CRM are NOT installed. Future modules integrate through WMS application-service APIs and
 * outbox events only — never by writing WMS tables (see docs/EXTENDING_AUTOLEMON.md).
 */

/** Static description of an installable module. */
export interface ModuleDescriptor {
  id: string;
  version: string;
  description: string;
  /** Other modules this one requires. */
  requires: string[];
  /** Always on (cannot be disabled). */
  core: boolean;
  /** Event types this module publishes (versioned contracts). */
  publishes: string[];
}

/** Modules compiled into this build. */
export const INSTALLED_MODULES: readonly ModuleDescriptor[] = [
  {
    id: 'wms',
    version: '0.6.7',
    description: 'Autonomous Warehouse Management System',
    requires: [],
    core: true,
    publishes: [
      'wms.stock.opening_posted',
      'wms.stock.adjusted',
      'wms.container.moved',
      'wms.inbound.received',
      'wms.inbound.closed',
      'wms.putaway.completed',
      'wms.outbound.allocated',
      'wms.outbound.dispatched',
      'wms.outbound.closed',
      'wms.transfer.dispatched',
      'wms.transfer.received',
      'wms.return.received',
      'wms.return.disposed',
      'wms.count.approved',
    ],
  },
];

/** Known optional business modules that are intentionally NOT part of this build. */
export const NOT_INSTALLED = ['sales', 'purchasing', 'accounting', 'crm', 'catalog'] as const;

/**
 * Resolves ENABLED_MODULES into descriptors. Core modules are always included.
 * @throws when a requested module is not installed or a dependency is missing.
 */
export function resolveModules(enabled: string): ModuleDescriptor[] {
  const requested = new Set(
    enabled
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const id of requested) {
    if (!INSTALLED_MODULES.some((m) => m.id === id)) {
      throw new Error(`Module "${id}" is not installed in this build (installed: ${INSTALLED_MODULES.map((m) => m.id).join(', ')})`);
    }
  }
  const active = INSTALLED_MODULES.filter((m) => m.core || requested.has(m.id));
  for (const m of active) {
    for (const dep of m.requires) {
      if (!active.some((a) => a.id === dep)) throw new Error(`Module "${m.id}" requires "${dep}"`);
    }
  }
  return active;
}
