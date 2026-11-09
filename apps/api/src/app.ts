/**
 * @file Application factory (used by main.ts, integration tests and OpenAPI generation).
 * @module platform
 *
 * NestJS on the Fastify adapter. The module graph is intentionally flat: one Nest module with
 * the controllers and the explicit service container (composition.ts). Optional future modules
 * register their controllers here only if enabled in the module registry.
 */
import 'reflect-metadata';
import cookie from '@fastify/cookie';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { type AppConfig, trustProxySetting } from './config/env.js';
import { buildServices, SERVICES, type Services } from './composition.js';
import { AdminController } from './http/admin.controller.js';
import { AuthController } from './http/auth.controller.js';
import { AuthGuard } from './http/auth.guard.js';
import { AllExceptionsFilter } from './http/exception.filter.js';
import { genReqId, installHardening, loggerOptions } from './http/hardening.js';
import { WmsCompanyController, WmsWarehouseController } from './http/wms.controller.js';

@Module({})
class AppModule {
  /** Builds the root module around a prepared service container. */
  static with(services: Services): DynamicModule {
    return {
      module: AppModule,
      controllers: [AuthController, AdminController, WmsCompanyController, WmsWarehouseController],
      providers: [
        { provide: SERVICES, useValue: services },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }
}

/** A created (initialised, not listening) application plus its services. */
export interface CreatedApp {
  app: NestFastifyApplication;
  services: Services;
}

/** Creates and initialises the application. */
export async function createApp(cfg: AppConfig, services: Services = buildServices(cfg)): Promise<CreatedApp> {
  const adapter = new FastifyAdapter({
    logger: loggerOptions(cfg),
    trustProxy: trustProxySetting(cfg),
    bodyLimit: 256 * 1024,
    genReqId,
    // Reject prototype-pollution vectors in JSON bodies.
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    routerOptions: { maxParamLength: 100 },
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.with(services), adapter, {
    logger: cfg.LOG_LEVEL === 'silent' ? false : ['error', 'warn'],
    bodyParser: true,
  });
  const fastify = app.getHttpAdapter().getInstance();
  await fastify.register(cookie as never);
  installHardening(fastify, cfg);
  app.enableShutdownHooks();
  await app.init();
  return { app, services };
}
