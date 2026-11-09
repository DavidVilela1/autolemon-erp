/**
 * @file API process entry point.
 * @module platform
 *
 * Binds to API_HOST (default 127.0.0.1 — never 0.0.0.0 in development) and starts the outbox
 * dispatcher. In production the API must sit behind the reverse proxy/WAF/ZTNA described in
 * docs/security/NETWORK_AND_ZTNA.md.
 */
import { describeConfig, loadConfig } from './config/env.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const { app, services } = await createApp(cfg);
services.outbox.start(5000, (e) => app.getHttpAdapter().getInstance().log.error({ err: e }, 'outbox dispatch failed'));
await app.listen({ host: cfg.API_HOST, port: cfg.API_PORT });
app
  .getHttpAdapter()
  .getInstance()
  .log.info({ config: describeConfig(cfg), modules: services.modules.map((m) => m.id) }, 'AutoLemon API started');

const shutdown = async () => {
  services.outbox.stop();
  await app.close();
  await services.database.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
