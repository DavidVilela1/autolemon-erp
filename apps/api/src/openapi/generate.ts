/**
 * @file Generates docs/api/openapi.json from the real NestJS route metadata and the shared Zod
 * contracts (`pnpm --filter @autolemon/api openapi`); `--check` fails when the committed spec
 * differs (API schema compatibility gate in CI).
 * @module platform/openapi
 *
 * Routes are read from controller decorator metadata (path + method) so the document cannot
 * drift from the code; request bodies come from the same Zod schemas the handlers use.
 */
import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import * as C from '@autolemon/contracts';
import { AdminController } from '../http/admin.controller.js';
import { AuthController } from '../http/auth.controller.js';
import { WmsCompanyController, WmsWarehouseController } from '../http/wms.controller.js';
import { PUBLIC_ROUTE } from '../http/http-util.js';

/** Request body schema per controller method (handlers parse the same schemas). */
const BODIES: Record<string, z.ZodType> = {
  'AuthController.login': C.LoginInput,
  'AuthController.verify': C.MfaVerifyInput,
  'AuthController.stepUp': C.StepUpInput,
  'AuthController.enrollmentStart': C.AcceptInvitationInput,
  'AuthController.enrollmentConfirm': C.ConfirmEnrollmentInput,
  'AuthController.passwordReset': C.ResetPasswordInput,
  'AuthController.passkeyLogin': C.PasskeyAssertInput,
  'AuthController.stepUpPasskey': C.PasskeyAssertInput,
  'AuthController.passkeyRegister': C.PasskeyRegisterInput,
  'AuthController.changePassword': C.ChangePasswordInput,
  'AdminController.createWarehouse': C.CreateWarehouseInput,
  'AdminController.createUser': C.CreateUserInput,
  'AdminController.permissions': C.UpdatePermissionsInput,
  'AdminController.warehouse': C.UpdateWarehouseAssignmentInput,
  'AdminController.switchWarehouse': C.SwitchWarehouseInput,
  'WmsCompanyController.createSku': C.CreateSkuInput,
  'WmsCompanyController.createTransfer': C.CreateTransferInput,
  'WmsCompanyController.dispatchTransfer': C.DispatchTransferInput,
  'WmsCompanyController.receiveTransfer': C.ReceiveTransferInput,
  'WmsWarehouseController.createNode': C.CreateNodeInput,
  'WmsWarehouseController.updateNode': C.UpdateNodeInput,
  'WmsWarehouseController.changeStatus': C.ChangeStockStatusInput,
  'WmsWarehouseController.unpick': C.UnpickInput,
  'WmsWarehouseController.unpack': C.UnpackInput,
  'WmsWarehouseController.createContainer': C.CreateContainerInput,
  'WmsWarehouseController.moveContainer': C.MoveContainerInput,
  'WmsWarehouseController.opening': C.OpeningStockInput,
  'WmsWarehouseController.move': C.MoveStockInput,
  'WmsWarehouseController.adjust': C.AdjustStockInput,
  'WmsWarehouseController.reverse': C.ReverseTransactionInput,
  'WmsWarehouseController.createInbound': C.CreateInboundInput,
  'WmsWarehouseController.inboundLines': C.ReplaceInboundLinesInput,
  'WmsWarehouseController.receive': C.ReceiveInput,
  'WmsWarehouseController.completePutaway': C.CompletePutawayInput,
  'WmsWarehouseController.createOutbound': C.CreateOutboundInput,
  'WmsWarehouseController.outboundLines': C.ReplaceOutboundLinesInput,
  'WmsWarehouseController.pick': C.PickInput,
  'WmsWarehouseController.createPackage': C.CreatePackageInput,
  'WmsWarehouseController.pack': C.PackInput,
  'WmsWarehouseController.dispatch': C.DispatchInput,
  'WmsWarehouseController.closeOutbound': C.CloseOutboundInput,
  'WmsWarehouseController.createReturn': C.CreateReturnInput,
  'WmsWarehouseController.disposition': C.ReturnDispositionInput,
  'WmsWarehouseController.createCount': C.CreateCountInput,
  'WmsWarehouseController.recordCount': C.RecordCountInput,
  'WmsWarehouseController.found': C.FoundStockInput,
  'WmsWarehouseController.rule': C.ReplenishmentRuleInput,
  'WmsWarehouseController.replenish': C.ExecuteReplenishmentInput,
};

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'all', 'options', 'head'];

/** Builds the OpenAPI 3.1 document. */
export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const ctrl of [AuthController, AdminController, WmsCompanyController, WmsWarehouseController]) {
    const base = String(Reflect.getMetadata('path', ctrl) ?? '');
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      const fn = (ctrl.prototype as unknown as Record<string, unknown>)[name];
      if (name === 'constructor' || typeof fn !== 'function') continue;
      const sub = Reflect.getMetadata('path', fn) as string | undefined;
      const m = Reflect.getMetadata('method', fn) as number | undefined;
      if (sub === undefined || m === undefined) continue;
      const method = METHODS[m]!;
      const full = `/${[base, sub].filter((s) => s && s !== '/').join('/')}`.replace(/\/+/g, '/').replace(/:(\w+)/g, '{$1}');
      const isPublic = Reflect.getMetadata(PUBLIC_ROUTE, fn) === true;
      const params = [...full.matchAll(/\{(\w+)\}/g)].map((x) => ({
        name: x[1],
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      }));
      const isWmsCommand = full.startsWith('/api/wms/') && method !== 'get';
      if (isWmsCommand)
        params.push({
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,80}$' } as never,
        });
      const key = `${ctrl.name}.${name}`;
      const body = BODIES[key];
      paths[full] ??= {};
      paths[full][method] = {
        operationId: key,
        tags: [ctrl.name.replace('Controller', '')],
        ...(params.length ? { parameters: params } : {}),
        ...(body
          ? {
              requestBody: {
                required: true,
                content: { 'application/json': { schema: z.toJSONSchema(body, { io: 'input', unrepresentable: 'any' }) } },
              },
            }
          : {}),
        ...(key === 'WmsCompanyController.importSkus'
          ? { requestBody: { required: true, content: { 'text/csv': { schema: { type: 'string', maxLength: 1000000 } } } } }
          : {}),
        security: isPublic ? [] : [{ sessionCookie: [], ...(method !== 'get' ? { csrfToken: [] } : {}) }],
        responses: {
          '2XX': { description: 'Success (JSON; CSV for reports/stock.csv)' },
          '400': { $ref: '#/components/responses/Error' },
          '401': { $ref: '#/components/responses/Error' },
          '403': { $ref: '#/components/responses/Error' },
          '404': { $ref: '#/components/responses/Error' },
          '409': { $ref: '#/components/responses/Error' },
          '429': { $ref: '#/components/responses/Error' },
        },
      };
    }
  }
  const sorted = Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)));
  return {
    openapi: '3.1.0',
    info: {
      title: 'AutoLemon ERP API (platform + autonomous WMS)',
      version: '0.6.4',
      description:
        'Cookie-session API. All writes require X-Requested-With: autolemon and X-CSRF-Token; WMS commands require Idempotency-Key. Generated from code — see docs/API.md.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: '__Host-al_sid' },
        csrfToken: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' },
      },
      responses: {
        Error: {
          description: 'Error envelope',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: {
                    type: 'object',
                    properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} },
                    required: ['code', 'message'],
                  },
                  requestId: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    paths: sorted,
  };
}

const out = resolve(import.meta.dirname, '../../../../docs/api/openapi.json');
const text = `${JSON.stringify(buildOpenApi(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(out, 'utf8');
  } catch {
    /* missing */
  }
  if (current !== text) {
    console.error('docs/api/openapi.json is out of date with the code. Run: pnpm --filter @autolemon/api openapi');
    process.exit(1);
  }
  console.log('OpenAPI spec matches code.');
} else {
  writeFileSync(out, text);
  console.log(`Wrote ${out} (${Object.keys(JSON.parse(text).paths).length} paths)`);
}
