/**
 * @file WMS HTTP endpoints. Controllers only parse/validate input and delegate; services apply
 * permission checks, warehouse scoping (object-level authorization), RLS and idempotency.
 * @module wms/http
 *
 * Company-level:   /api/wms/skus, /api/wms/transfers, /api/wms/reports/in-transit
 * Warehouse-level: /api/wms/w/:wh/... (warehouse id is authorised per request; staff may only
 *                  use their assigned warehouse, admins any warehouse of their company).
 * Every mutating WMS command requires an `Idempotency-Key` header.
 */
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  AdjustStockInput,
  CloseOutboundInput,
  CompletePutawayInput,
  CreateContainerInput,
  CreateCountInput,
  CreateInboundInput,
  CreateNodeInput,
  CreateOutboundInput,
  CreatePackageInput,
  CreateReturnInput,
  CreateSkuInput,
  CreateTransferInput,
  DispatchInput,
  DispatchTransferInput,
  ExecuteReplenishmentInput,
  FoundStockInput,
  LedgerQuery,
  MoveContainerInput,
  MoveStockInput,
  OpeningStockInput,
  PackInput,
  PickInput,
  ReceiveInput,
  ReceiveTransferInput,
  RecordCountInput,
  ReplaceInboundLinesInput,
  ReplaceOutboundLinesInput,
  ReplenishmentRuleInput,
  ReturnDispositionInput,
  ReverseTransactionInput,
  SafeLine,
  Uuid,
} from '@autolemon/contracts';
import { ValidationFailed } from '../common/errors.js';
import { SERVICES, type Services } from '../composition.js';
import { actorOf, type AppRequest, idemKey, parse, uuidParam } from './http-util.js';

/** Company-level WMS routes. */
@Controller('api/wms')
export class WmsCompanyController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  /** SKU list with optional search. */
  @Get('skus')
  skus(@Req() req: AppRequest, @Query() q: unknown) {
    const p = parse(z.object({ q: SafeLine(60).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).strict(), q);
    return this.s.skus.list(actorOf(req), p.q, p.limit);
  }

  /** Create SKU. */
  @Post('skus')
  createSku(@Req() req: AppRequest, @Body() body: unknown) {
    return this.s.skus.create(actorOf(req), parse(CreateSkuInput, body));
  }

  /** CSV import (Content-Type: text/csv, ≤ 1 MB, ≤ 2000 rows, all-or-nothing). */
  @Post('skus/import')
  @HttpCode(200)
  importSkus(@Req() req: AppRequest, @Body() body: unknown) {
    if (typeof body !== 'string')
      throw new ValidationFailed([{ path: 'body', message: 'Envie text/csv' }], 'Content-Type text/csv obrigatório');
    return this.s.skus.importCsv(actorOf(req), body);
  }

  /** Transfers visible to the caller. */
  @Get('transfers')
  transfers(@Req() req: AppRequest) {
    return this.s.transfers.list(actorOf(req));
  }

  /** Transfer detail. */
  @Get('transfers/:id')
  transfer(@Req() req: AppRequest, @Param('id') id: string) {
    return this.s.transfers.get(actorOf(req), uuidParam(id));
  }

  /** Create transfer (source side). */
  @Post('transfers')
  createTransfer(@Req() req: AppRequest, @Body() body: unknown) {
    return this.s.transfers.create(actorOf(req), idemKey(req), parse(CreateTransferInput, body));
  }

  /** Source dispatch. */
  @Post('transfers/:id/dispatch')
  @HttpCode(200)
  dispatchTransfer(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.s.transfers.dispatch(actorOf(req), uuidParam(id), idemKey(req), parse(DispatchTransferInput, body));
  }

  /** Destination receipt. */
  @Post('transfers/:id/receive')
  @HttpCode(200)
  receiveTransfer(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.s.transfers.receive(actorOf(req), uuidParam(id), idemKey(req), parse(ReceiveTransferInput, body));
  }

  /** Destination close (records in-transit loss). */
  @Post('transfers/:id/close')
  @HttpCode(200)
  closeTransfer(@Req() req: AppRequest, @Param('id') id: string) {
    return this.s.transfers.close(actorOf(req), uuidParam(id), idemKey(req));
  }

  /** In-transit report. */
  @Get('reports/in-transit')
  inTransit(@Req() req: AppRequest) {
    return this.s.reports.inTransit(actorOf(req));
  }
}

/** Warehouse-scoped WMS routes. */
@Controller('api/wms/w/:wh')
export class WmsWarehouseController {
  constructor(@Inject(SERVICES) private readonly s: Services) {}

  // ---------------------------------------------------------------- topology
  @Get('nodes')
  nodes(@Req() req: AppRequest, @Param('wh') wh: string) {
    return this.s.topology.listNodes(actorOf(req), uuidParam(wh));
  }
  @Post('nodes')
  createNode(@Req() req: AppRequest, @Param('wh') wh: string, @Body() body: unknown) {
    return this.s.topology.createNode(actorOf(req), uuidParam(wh), idemKey(req), parse(CreateNodeInput, body));
  }
  @Get('containers')
  containers(@Req() req: AppRequest, @Param('wh') wh: string) {
    return this.s.topology.listContainers(actorOf(req), uuidParam(wh));
  }
  @Post('containers')
  createContainer(@Req() req: AppRequest, @Param('wh') wh: string, @Body() body: unknown) {
    return this.s.topology.createContainer(actorOf(req), uuidParam(wh), idemKey(req), parse(CreateContainerInput, body));
  }
  @Post('containers/:id/move')
  @HttpCode(200)
  moveContainer(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string, @Body() body: unknown) {
    return this.s.topology.moveContainer(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req), parse(MoveContainerInput, body));
  }
  @Get('containers/:id/history')
  containerHistory(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string) {
    return this.s.topology.containerHistory(actorOf(req), uuidParam(wh), uuidParam(id));
  }

  // ---------------------------------------------------------------- stock
  @Get('stock')
  stock(@Req() req: AppRequest, @Param('wh') wh: string, @Query() q: unknown) {
    const p = parse(z.object({ skuId: Uuid.optional() }).strict(), q);
    return this.s.stock.positions(actorOf(req), uuidParam(wh), p.skuId);
  }
  @Get('stock/summary')
  summary(@Req() req: AppRequest, @Param('wh') wh: string) {
    return this.s.stock.summary(actorOf(req), uuidParam(wh));
  }
  @Get('stock/reconciliation')
  reconciliation(@Req() req: AppRequest, @Param('wh') wh: string) {
    return this.s.stock.reconciliation(actorOf(req), uuidParam(wh));
  }
  @Post('stock/opening')
  opening(@Req() req: AppRequest, @Param('wh') wh: string, @Body() body: unknown) {
    return this.s.stock.opening(actorOf(req), uuidParam(wh), idemKey(req), parse(OpeningStockInput, body));
  }
  @Post('stock/move')
  @HttpCode(200)
  move(@Req() req: AppRequest, @Param('wh') wh: string, @Body() body: unknown) {
    return this.s.stock.move(actorOf(req), uuidParam(wh), idemKey(req), parse(MoveStockInput, body));
  }
  @Post('stock/adjust')
  @HttpCode(200)
  adjust(@Req() req: AppRequest, @Param('wh') wh: string, @Body() body: unknown) {
    return this.s.stock.adjust(actorOf(req), uuidParam(wh), idemKey(req), parse(AdjustStockInput, body));
  }
  @Post('transactions/:id/reverse')
  @HttpCode(200)
  reverse(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string, @Body() body: unknown) {
    return this.s.stock.reverse(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req), parse(ReverseTransactionInput, body));
  }

  // ---------------------------------------------------------------- inbound & putaway
  @Get('inbound')
  inboundList(@Req() req: AppRequest, @Param('wh') wh: string) {
    return this.s.inbound.list(actorOf(req), uuidParam(wh));
  }
  @Get('inbound/:id')
  inbound(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string) {
    return this.s.inbound.get(actorOf(req), uuidParam(wh), uuidParam(id));
  }
  @Post('inbound')
  createInbound(@Req() req: AppRequest, @Param('wh') wh: string, @Body() body: unknown) {
    return this.s.inbound.create(actorOf(req), uuidParam(wh), idemKey(req), parse(CreateInboundInput, body));
  }
  @Put('inbound/:id/lines')
  inboundLines(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string, @Body() body: unknown) {
    return this.s.inbound.replaceLines(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req), parse(ReplaceInboundLinesInput, body));
  }
  @Post('inbound/:id/release')
  @HttpCode(200)
  releaseInbound(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string) {
    return this.s.inbound.release(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req));
  }
  @Post('inbound/:id/cancel')
  @HttpCode(200)
  cancelInbound(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string) {
    return this.s.inbound.cancel(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req));
  }
  @Post('inbound/:id/receive')
  @HttpCode(200)
  receive(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string, @Body() body: unknown) {
    return this.s.inbound.receive(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req), parse(ReceiveInput, body));
  }
  @Post('inbound/:id/close')
  @HttpCode(200)
  closeInbound(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string) {
    return this.s.inbound.close(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req));
  }
  @Get('putaway')
  putaway(@Req() req: AppRequest, @Param('wh') wh: string) {
    return this.s.inbound.putawayTasks(actorOf(req), uuidParam(wh));
  }
  @Get('putaway/:id/suggestions')
  suggestions(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string) {
    return this.s.inbound.suggestions(actorOf(req), uuidParam(wh), uuidParam(id));
  }
  @Post('putaway/:id/complete')
  @HttpCode(200)
  completePutaway(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string, @Body() body: unknown) {
    return this.s.inbound.completePutaway(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req), parse(CompletePutawayInput, body));
  }

  // ---------------------------------------------------------------- outbound
  @Get('outbound')
  outboundList(@Req() req: AppRequest, @Param('wh') wh: string) {
    return this.s.outbound.list(actorOf(req), uuidParam(wh));
  }
  @Get('outbound/:id')
  outbound(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string) {
    return this.s.outbound.get(actorOf(req), uuidParam(wh), uuidParam(id));
  }
  @Get('outbound/:id/dispatch-note')
  dispatchNote(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string) {
    return this.s.outbound.dispatchNote(actorOf(req), uuidParam(wh), uuidParam(id));
  }
  @Post('outbound')
  createOutbound(@Req() req: AppRequest, @Param('wh') wh: string, @Body() body: unknown) {
    return this.s.outbound.create(actorOf(req), uuidParam(wh), idemKey(req), parse(CreateOutboundInput, body));
  }
  @Put('outbound/:id/lines')
  outboundLines(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string, @Body() body: unknown) {
    return this.s.outbound.replaceLines(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req), parse(ReplaceOutboundLinesInput, body));
  }
  @Post('outbound/:id/allocate')
  @HttpCode(200)
  allocate(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string) {
    return this.s.outbound.allocate(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req));
  }
  @Post('outbound/:id/pick')
  @HttpCode(200)
  pick(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string, @Body() body: unknown) {
    return this.s.outbound.pick(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req), parse(PickInput, body));
  }
  @Post('outbound/:id/packages')
  createPackage(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string, @Body() body: unknown) {
    return this.s.outbound.createPackage(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req), parse(CreatePackageInput, body));
  }
  @Post('outbound/:id/pack')
  @HttpCode(200)
  pack(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string, @Body() body: unknown) {
    return this.s.outbound.pack(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req), parse(PackInput, body));
  }
  @Post('outbound/:id/dispatch')
  @HttpCode(200)
  dispatch(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string, @Body() body: unknown) {
    return this.s.outbound.dispatch(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req), parse(DispatchInput, body));
  }
  @Post('outbound/:id/close')
  @HttpCode(200)
  closeOutbound(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string, @Body() body: unknown) {
    return this.s.outbound.close(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req), parse(CloseOutboundInput, body));
  }
  @Post('outbound/:id/cancel')
  @HttpCode(200)
  cancelOutbound(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string) {
    return this.s.outbound.cancel(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req));
  }

  // ---------------------------------------------------------------- returns
  @Get('returns')
  returns(@Req() req: AppRequest, @Param('wh') wh: string) {
    return this.s.returns.list(actorOf(req), uuidParam(wh));
  }
  @Post('returns')
  createReturn(@Req() req: AppRequest, @Param('wh') wh: string, @Body() body: unknown) {
    return this.s.returns.create(actorOf(req), uuidParam(wh), idemKey(req), parse(CreateReturnInput, body));
  }
  @Post('returns/:id/disposition')
  @HttpCode(200)
  disposition(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string, @Body() body: unknown) {
    return this.s.returns.disposition(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req), parse(ReturnDispositionInput, body));
  }

  // ---------------------------------------------------------------- counts
  @Get('counts')
  counts(@Req() req: AppRequest, @Param('wh') wh: string) {
    return this.s.counts.list(actorOf(req), uuidParam(wh));
  }
  @Get('counts/:id')
  count(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string) {
    return this.s.counts.get(actorOf(req), uuidParam(wh), uuidParam(id));
  }
  @Post('counts')
  createCount(@Req() req: AppRequest, @Param('wh') wh: string, @Body() body: unknown) {
    return this.s.counts.create(actorOf(req), uuidParam(wh), idemKey(req), parse(CreateCountInput, body));
  }
  @Post('counts/:id/lines/:lineId/count')
  @HttpCode(200)
  recordCount(
    @Req() req: AppRequest,
    @Param('wh') wh: string,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: unknown,
  ) {
    return this.s.counts.record(actorOf(req), uuidParam(wh), uuidParam(id), uuidParam(lineId), idemKey(req), parse(RecordCountInput, body));
  }
  @Post('counts/:id/found')
  found(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string, @Body() body: unknown) {
    return this.s.counts.found(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req), parse(FoundStockInput, body));
  }
  @Post('counts/:id/submit')
  @HttpCode(200)
  submitCount(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string) {
    return this.s.counts.submit(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req));
  }
  @Post('counts/:id/lines/:lineId/recount')
  @HttpCode(200)
  recount(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string, @Param('lineId') lineId: string) {
    return this.s.counts.recount(actorOf(req), uuidParam(wh), uuidParam(id), uuidParam(lineId), idemKey(req));
  }
  @Post('counts/:id/approve')
  @HttpCode(200)
  approveCount(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string) {
    return this.s.counts.approve(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req));
  }
  @Post('counts/:id/cancel')
  @HttpCode(200)
  cancelCount(@Req() req: AppRequest, @Param('wh') wh: string, @Param('id') id: string) {
    return this.s.counts.cancel(actorOf(req), uuidParam(wh), uuidParam(id), idemKey(req));
  }

  // ---------------------------------------------------------------- replenishment
  @Post('replenishment/rules')
  rule(@Req() req: AppRequest, @Param('wh') wh: string, @Body() body: unknown) {
    return this.s.replenishment.upsertRule(actorOf(req), uuidParam(wh), idemKey(req), parse(ReplenishmentRuleInput, body));
  }
  @Get('replenishment/suggestions')
  replenishSuggestions(@Req() req: AppRequest, @Param('wh') wh: string) {
    return this.s.replenishment.suggestions(actorOf(req), uuidParam(wh));
  }
  @Post('replenishment/execute')
  @HttpCode(200)
  replenish(@Req() req: AppRequest, @Param('wh') wh: string, @Body() body: unknown) {
    return this.s.replenishment.execute(actorOf(req), uuidParam(wh), idemKey(req), parse(ExecuteReplenishmentInput, body));
  }

  // ---------------------------------------------------------------- reports
  @Get('reports/ledger')
  ledger(@Req() req: AppRequest, @Param('wh') wh: string, @Query() q: unknown) {
    return this.s.reports.ledger(actorOf(req), uuidParam(wh), parse(LedgerQuery, q));
  }
  @Get('reports/discrepancies')
  discrepancies(@Req() req: AppRequest, @Param('wh') wh: string) {
    return this.s.reports.discrepancies(actorOf(req), uuidParam(wh));
  }
  @Get('reports/stock')
  stockReport(@Req() req: AppRequest, @Param('wh') wh: string) {
    return this.s.reports.stock(actorOf(req), uuidParam(wh));
  }
  @Get('reports/stock.csv')
  async stockCsv(@Req() req: AppRequest, @Param('wh') wh: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const csv = await this.s.reports.exportStockCsv(actorOf(req), uuidParam(wh));
    // Headers set only after authorization succeeded (errors stay JSON).
    void reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="stock.csv"');
    return csv;
  }
}
