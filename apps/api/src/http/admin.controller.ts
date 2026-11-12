/**
 * @file Administration and system endpoints (/api/admin/*, /api/session/*, /api/system/*, /api/health).
 * @module platform/http
 */
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import {
  AcknowledgeAlertInput,
  CreateUserInput,
  SecurityAlertsQuery,
  SecurityOverviewQuery,
  CreateWarehouseInput,
  SwitchWarehouseInput,
  UpdatePermissionsInput,
  UpdateWarehouseAssignmentInput,
} from '@autolemon/contracts';
import { z } from 'zod';
import { SERVICES, type Services } from '../composition.js';
import { actorOf, type AppRequest, parse, Public, uuidParam } from './http-util.js';

/** Admin routes (each service method re-checks permissions). */
@Controller('api')
export class AdminController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  /** Liveness (no data). */
  @Public()
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  /** Enabled modules (WMS-only mode verification). */
  @Get('system/modules')
  modules() {
    return { modules: this.s.modules.map((m) => ({ id: m.id, version: m.version, description: m.description })) };
  }

  /** Warehouses visible to the caller. */
  @Get('admin/warehouses')
  warehouses(@Req() req: AppRequest) {
    return this.s.admin.warehouses(actorOf(req));
  }

  /** Create warehouse. */
  @Post('admin/warehouses')
  createWarehouse(@Req() req: AppRequest, @Body() body: unknown) {
    return this.s.admin.createWarehouse(actorOf(req), parse(CreateWarehouseInput, body));
  }

  /** Users of the company. */
  @Get('admin/users')
  users(@Req() req: AppRequest) {
    return this.s.admin.users(actorOf(req));
  }

  /** Invite user (returns one-time invitation token). */
  @Post('admin/users')
  createUser(@Req() req: AppRequest, @Body() body: unknown) {
    return this.s.admin.createUser(actorOf(req), parse(CreateUserInput, body));
  }

  /** Replace staff permissions. */
  @Put('admin/users/:id/permissions')
  permissions(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.s.admin.updatePermissions(actorOf(req), uuidParam(id), parse(UpdatePermissionsInput, body).permissions);
  }

  /** Re-assign staff warehouse (step-up). */
  @Put('admin/users/:id/warehouse')
  warehouse(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.s.admin.changeWarehouse(actorOf(req), uuidParam(id), parse(UpdateWarehouseAssignmentInput, body).warehouseId);
  }

  /** Disable user. */
  @Post('admin/users/:id/deactivate')
  @HttpCode(200)
  deactivate(@Req() req: AppRequest, @Param('id') id: string) {
    return this.s.admin.deactivate(actorOf(req), uuidParam(id));
  }

  /** MFA reset (step-up). */
  @Post('admin/users/:id/mfa-reset')
  @HttpCode(200)
  mfaReset(@Req() req: AppRequest, @Param('id') id: string) {
    return this.s.admin.resetMfa(actorOf(req), uuidParam(id));
  }

  /** Password reset token (step-up). */
  @Post('admin/users/:id/password-reset')
  @HttpCode(200)
  passwordReset(@Req() req: AppRequest, @Param('id') id: string) {
    return this.s.admin.issuePasswordReset(actorOf(req), uuidParam(id));
  }

  /** Decrypt PII (pii.read + step-up + audit). */
  @Get('admin/users/:id/pii')
  pii(@Req() req: AppRequest, @Param('id') id: string) {
    return this.s.admin.readPii(actorOf(req), uuidParam(id));
  }

  /** Rotate tenant data key (step-up). */
  @Post('admin/keys/rotate')
  @HttpCode(200)
  rotate(@Req() req: AppRequest) {
    return this.s.admin.rotateKeys(actorOf(req));
  }

  /** Security audit log. */
  @Get('admin/audit')
  audit(@Req() req: AppRequest, @Query() q: unknown) {
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }).strict(), q);
    return this.s.admin.auditLog(actorOf(req), limit);
  }

  /** Verify audit hash chain. */
  @Get('admin/audit/verify')
  verify(@Req() req: AppRequest) {
    return this.s.admin.verifyAudit(actorOf(req));
  }

  /** Security monitoring overview: counters, open alerts, chain checkpoint, outbox (ADR-0026). */
  @Get('admin/security/overview')
  securityOverview(@Req() req: AppRequest, @Query() q: unknown) {
    return this.s.monitor.overview(actorOf(req), parse(SecurityOverviewQuery, q).windowMinutes);
  }

  /** Security alerts of the company. */
  @Get('admin/security/alerts')
  securityAlerts(@Req() req: AppRequest, @Query() q: unknown) {
    return this.s.monitor.alerts(actorOf(req), parse(SecurityAlertsQuery, q));
  }

  /** Acknowledge (mark as seen) an open alert — step-up required, audited, one-way. */
  @Post('admin/security/alerts/:id/ack')
  @HttpCode(200)
  acknowledgeAlert(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.s.monitor.acknowledge(actorOf(req), uuidParam(id), parse(AcknowledgeAlertInput, body ?? {}));
  }

  /** Admin warehouse context switch. */
  @Post('session/warehouse')
  @HttpCode(200)
  switchWarehouse(@Req() req: AppRequest, @Body() body: unknown) {
    return this.s.admin.switchWarehouse(actorOf(req), parse(SwitchWarehouseInput, body).warehouseId);
  }
}
