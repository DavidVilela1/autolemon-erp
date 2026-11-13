/**
 * @file API process entry point.
 * @module platform
 *
 * Binds to API_HOST (default 127.0.0.1 — never 0.0.0.0 in development) and starts the outbox
 * dispatcher, the data-retention purge (every 6 hours) and the security monitor (ADR-0026;
 * SECURITY_MONITOR_INTERVAL_SECONDS). Job failures raise system alerts. In production the API must sit behind the reverse proxy/WAF/ZTNA described in
 * docs/security/NETWORK_AND_ZTNA.md.
 */
import { describeConfig, loadConfig } from './config/env.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const { app, services } = await createApp(cfg);
const log = app.getHttpAdapter().getInstance().log;
const alertOnFailure = (job: 'retention' | 'outbox', msg: string) => (e: unknown) => {
  log.error({ err: e }, msg);
  void services.monitor.reportJobFailure(job, e).catch((err: unknown) => log.error({ err }, 'job failure alert failed'));
};
services.outbox.start(5000, alertOnFailure('outbox', 'outbox dispatch failed'));
services.retention.start(undefined, alertOnFailure('retention', 'retention purge failed'));
services.monitor.start(log);
services.signals.start((e) => log.error({ err: e }, 'security signal flush failed'));
await app.listen({ host: cfg.API_HOST, port: cfg.API_PORT });
app
  .getHttpAdapter()
  .getInstance()
  .log.info({ config: describeConfig(cfg), modules: services.modules.map((m) => m.id) }, 'AutoLemon API started');

const shutdown = async () => {
  services.outbox.stop();
  services.retention.stop();
  services.monitor.stop();
  await services.signals.stop();
  await app.close();
  await services.database.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
