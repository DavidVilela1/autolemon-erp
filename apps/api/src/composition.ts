/**
 * @file Composition root: builds every service once from validated configuration.
 * @module platform
 *
 * Services are plain classes wired explicitly here (ADR-0005) instead of relying on decorator
 * metadata reflection. NestJS controllers receive this container through one injection token.
 * This keeps the dependency graph visible in one file and makes services trivially testable.
 */
import type { AppConfig } from './config/env.js';
import { Database } from './db/database.js';
import { AdminService } from './platform/admin/admin.service.js';
import { AuditService } from './platform/audit/audit.service.js';
import { AuthService } from './platform/auth/auth.service.js';
import { ThrottleService } from './platform/auth/throttle.service.js';
import { FieldCrypto } from './platform/crypto/field-crypto.js';
import { ExternalKmsProvider, type KeyProvider, LocalDevKeyProvider } from './platform/crypto/key-provider.js';
import { type ModuleDescriptor, resolveModules } from './platform/modules/registry.js';
import { OutboxDispatcher } from './platform/outbox/outbox.dispatcher.js';
import { CountService } from './wms/count.service.js';
import { InboundService } from './wms/inbound.service.js';
import { OutboundService } from './wms/outbound.service.js';
import { ReplenishmentService } from './wms/replenishment.service.js';
import { ReportService } from './wms/report.service.js';
import { ReturnsService } from './wms/returns.service.js';
import { WmsRunner } from './wms/runner.js';
import { SkuService } from './wms/sku.service.js';
import { StockService } from './wms/stock.service.js';
import { TopologyService } from './wms/topology.service.js';
import { TransferService } from './wms/transfer.service.js';

/** Injection token for the service container. */
export const SERVICES = Symbol('AUTOLEMON_SERVICES');

/** All application services. */
export interface Services {
  cfg: AppConfig;
  modules: ModuleDescriptor[];
  database: Database;
  audit: AuditService;
  crypto: FieldCrypto;
  auth: AuthService;
  admin: AdminService;
  outbox: OutboxDispatcher;
  topology: TopologyService;
  skus: SkuService;
  stock: StockService;
  inbound: InboundService;
  outbound: OutboundService;
  transfers: TransferService;
  returns: ReturnsService;
  counts: CountService;
  replenishment: ReplenishmentService;
  reports: ReportService;
}

/** Selects the key provider; local-dev is refused in production by loadConfig. */
export function keyProviderFor(cfg: AppConfig): KeyProvider {
  if (cfg.KEY_PROVIDER === 'local-dev') return new LocalDevKeyProvider(cfg.LOCAL_DEV_KEKS!);
  return new ExternalKmsProvider();
}

/** Builds the service graph. */
export function buildServices(cfg: AppConfig): Services {
  const modules = resolveModules(cfg.ENABLED_MODULES);
  const database = new Database(cfg);
  const audit = new AuditService(database);
  const crypto = new FieldCrypto(database, keyProviderFor(cfg));
  const throttle = new ThrottleService(database, cfg.AUTH_THROTTLE_ENABLED);
  const auth = new AuthService(database, cfg, audit, crypto, throttle);
  const runner = new WmsRunner(database);
  const step = cfg.STEP_UP_MINUTES;
  return {
    cfg,
    modules,
    database,
    audit,
    crypto,
    auth,
    admin: new AdminService(database, audit, auth, crypto, step),
    outbox: new OutboxDispatcher(database),
    topology: new TopologyService(runner),
    skus: new SkuService(database, audit),
    stock: new StockService(runner, audit, step),
    inbound: new InboundService(runner),
    outbound: new OutboundService(runner, crypto),
    transfers: new TransferService(runner, database, audit),
    returns: new ReturnsService(runner),
    counts: new CountService(runner, audit, step),
    replenishment: new ReplenishmentService(runner),
    reports: new ReportService(runner, database, audit, step),
  };
}
