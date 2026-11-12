/**
 * @file Transfers, returns, counts and replenishment screens.
 * @module web/pages
 */
import { useState } from 'react';
import { api, fmtDate, fmtQty } from '../api';
import { Button, ErrorNotice, Field, Form, Loading, Notice, Page, Panel, Pill, Select, Table, useAction, useLoad } from '../components/ui';
import { useSession } from '../session';
import { holderOptions, holderRef, loadContainers, loadNodes, loadPositions, loadSkus, nodeOptions, type Row, wp } from '../wms-data';

interface TransferDoc {
  id: string;
  number: string;
  status: string;
  sourceWarehouseId: string;
  destWarehouseId: string;
  sourceCode: string;
  destCode: string;
  lines: Array<Row & { lots?: Array<{ lot: string; qtyInTransit: string; qtyReceived: string }> }>;
  /** Reserved positions to ship from — only returned to the source warehouse. */
  pickList: Row[];
}

/** Inter-warehouse transfers. Each side only acts in its own warehouse. */
export function TransfersPage() {
  const { activeWh, session, can } = useSession();
  const wh = activeWh!.id;
  const list = useLoad(() => api<Row[]>('GET', '/api/wms/transfers'), []);
  const skus = useLoad(() => loadSkus(), []);
  const nodes = useLoad(() => loadNodes(wh), [wh]);
  const [openId, setOpenId] = useState<string>();
  const doc = useLoad(() => (openId ? api<TransferDoc>('GET', `/api/wms/transfers/${openId}`) : Promise.resolve(undefined)), [openId]);
  const positions = useLoad(() => loadPositions(wh), [wh]);
  const [nf, setNf] = useState({ dest: '', skuId: '', qty: '' });
  const [disp, setDisp] = useState<Record<string, { positionId: string; qty: string }>>({});
  const [staging, setStaging] = useState('');
  const a = useAction();
  const d = doc.data;
  const refresh = () => (doc.reload(), list.reload(), positions.reload());
  const destOptions = (session?.warehouses ?? []).filter((w) => w.id !== wh).map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }));
  return (
    <Page
      title="Transferências"
      purpose="Envio entre armazéns: expedição na origem, em trânsito, receção e arrumação no destino. Cada lado só vê o seu armazém."
      steps={['Origem cria e expede', 'Destino recebe no cais', 'Destino arruma']}
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Transferências">
          <Table
            rows={list.data ?? []}
            rowKey={(r) => r.id!}
            cols={[
              {
                h: 'Número',
                c: (r) => (
                  <Button small variant="ghost" onClick={() => setOpenId(r.id!)}>
                    {r.number}
                  </Button>
                ),
              },
              { h: 'Rota', c: (r) => `${r.sourceCode} → ${r.destCode}` },
              { h: 'Estado', c: (r) => <Pill>{r.status}</Pill> },
              { h: 'Em trânsito', c: (r) => fmtQty(r.qtyInTransit), num: true },
            ]}
          />
          {can('wms.transfer.dispatch') && destOptions.length > 0 && (
            <Form
              className="mt-3 space-y-2"
              onSubmit={() =>
                void a.run(async () => {
                  const r = await api<{ id: string }>('POST', '/api/wms/transfers', {
                    sourceWarehouseId: wh,
                    destWarehouseId: nf.dest,
                    lines: [{ skuId: nf.skuId, qty: nf.qty }],
                  });
                  setOpenId(r.id);
                  list.reload();
                }, 'Transferência criada.')
              }
            >
              <h3 className="font-semibold">Nova transferência a partir de {activeWh!.code}</h3>
              <Select label="Destino" value={nf.dest} onChange={(v) => setNf({ ...nf, dest: v })} options={destOptions} required />
              <Select
                label="Artigo"
                value={nf.skuId}
                onChange={(v) => setNf({ ...nf, skuId: v })}
                options={(skus.data ?? []).map((s) => ({ value: s.id, label: s.code }))}
                required
              />
              <Field label="Quantidade" value={nf.qty} onChange={(v) => setNf({ ...nf, qty: v })} required inputMode="decimal" />
              <Button type="submit">Criar</Button>
            </Form>
          )}
          {destOptions.length === 0 && (
            <p className="mt-2 text-xs text-ink-soft">Os destinos possíveis são definidos pelo administrador.</p>
          )}
        </Panel>
        <Panel
          title={d ? `${d.number}: ${d.sourceCode} → ${d.destCode} (${d.status})` : 'Selecione uma transferência'}
          className="lg:col-span-2"
        >
          {d && (
            <div className="space-y-3">
              <Table
                rows={d.lines}
                rowKey={(r) => r.id!}
                cols={[
                  { h: 'Artigo', c: (r) => r.skuCode },
                  { h: 'Pedido', c: (r) => fmtQty(r.qtyRequested), num: true },
                  { h: 'Expedido', c: (r) => fmtQty(r.qtyShipped), num: true },
                  { h: 'Recebido', c: (r) => fmtQty(r.qtyReceived), num: true },
                  { h: 'Em trânsito', c: (r) => fmtQty(r.qtyInTransit), num: true },
                  { h: 'Reservado', c: (r) => fmtQty(r.qtyReserved), num: true },
                  { h: 'Perdido', c: (r) => fmtQty(r.qtyLost), num: true },
                  {
                    h: 'Lotes (em trânsito)',
                    c: (r) =>
                      (r.lots ?? []).filter((x) => x.lot).length
                        ? (r.lots ?? []).map((x) => `${x.lot}: ${fmtQty(x.qtyInTransit)}`).join(' · ')
                        : '—',
                  },
                ]}
              />
              {d.sourceWarehouseId === wh && d.status === 'DRAFT' && can('wms.transfer.dispatch') && (
                <Button
                  variant="danger"
                  onClick={() =>
                    void a.run(async () => (await api('POST', `/api/wms/transfers/${d.id}/cancel`), refresh()), 'Transferência anulada.')
                  }
                >
                  Anular transferência
                </Button>
              )}
              {d.sourceWarehouseId === wh &&
                ['DRAFT', 'IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(d.status) &&
                can('wms.transfer.dispatch') && (
                  <Form
                    className="space-y-2"
                    onSubmit={() =>
                      void a.run(async () => {
                        await api('POST', `/api/wms/transfers/${d.id}/dispatch`, {
                          lines: Object.entries(disp).map(([lineId, v]) => ({ lineId, ...v })),
                        });
                        setDisp({});
                        refresh();
                      }, 'Expedido; em trânsito.')
                    }
                  >
                    <h3 className="font-semibold">Expedir (origem)</h3>
                    <p className="text-sm text-ink-soft">
                      <em>Reservar stock</em> guarda as unidades (validade mais próxima primeiro) para que pedidos de saída não as usem.
                    </p>
                    <Button
                      variant="secondary"
                      disabled={a.busy}
                      onClick={() =>
                        void a.run(async () => {
                          const r = await api<{ lines: Array<{ missing: string }> }>('POST', `/api/wms/transfers/${d.id}/allocate`);
                          refresh();
                          return r;
                        }, 'Stock reservado na origem.')
                      }
                    >
                      Reservar stock
                    </Button>
                    {d.pickList.length > 0 && (
                      <Table
                        rows={d.pickList}
                        rowKey={(r) => r.reservationId!}
                        cols={[
                          { h: 'Localização', c: (r) => `${r.nodePath}${r.containerCode ? ` / ${r.containerCode}` : ''}` },
                          { h: 'Artigo', c: (r) => r.skuCode },
                          { h: 'Lote', c: (r) => r.lot ?? '—' },
                          { h: 'Reservado', c: (r) => fmtQty(r.qtyOpen), num: true },
                          {
                            h: '',
                            c: (r) => (
                              <Button
                                small
                                variant="ghost"
                                onClick={() =>
                                  setDisp({ ...disp, [r.lineId!]: { positionId: r.positionId!, qty: String(Number(r.qtyOpen)) } })
                                }
                              >
                                Expedir daqui
                              </Button>
                            ),
                          },
                        ]}
                      />
                    )}
                    {d.lines.map((l) => (
                      <div key={l.id} className="grid gap-2 md:grid-cols-2">
                        <Select
                          label={`Posição de origem para ${l.skuCode}`}
                          value={disp[l.id!]?.positionId ?? ''}
                          onChange={(v) => setDisp({ ...disp, [l.id!]: { positionId: v, qty: disp[l.id!]?.qty ?? '' } })}
                          options={(positions.data ?? [])
                            .filter((p) => p.skuId === l.skuId && p.status === 'AVAILABLE')
                            .map((p) => ({
                              value: p.id!,
                              label: `${p.nodePath}${p.containerCode ? ` / ${p.containerCode}` : ''}${p.lot ? ` · lote ${p.lot}` : ''} (livre ${fmtQty(p.free)})`,
                            }))}
                        />
                        <Field
                          label="Quantidade"
                          value={disp[l.id!]?.qty ?? ''}
                          onChange={(v) => setDisp({ ...disp, [l.id!]: { positionId: disp[l.id!]?.positionId ?? '', qty: v } })}
                          inputMode="decimal"
                        />
                      </div>
                    ))}
                    <Button type="submit">Expedir</Button>
                  </Form>
                )}
              {d.destWarehouseId === wh && ['IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(d.status) && can('wms.transfer.receive') && (
                <div className="space-y-2">
                  <h3 className="font-semibold">Receber (destino)</h3>
                  <Select
                    label="Cais de receção"
                    value={staging}
                    onChange={setStaging}
                    options={nodeOptions(nodes.data, ['STAGING'])}
                    required
                  />
                  <div className="flex gap-2">
                    <Button
                      onClick={() =>
                        void a.run(async () => {
                          await api('POST', `/api/wms/transfers/${d.id}/receive`, {
                            stagingNodeId: staging,
                            lines: d.lines.filter((l) => Number(l.qtyInTransit) > 0).map((l) => ({ lineId: l.id, qty: l.qtyInTransit })),
                          });
                          refresh();
                        }, 'Recebido; tarefas de arrumação criadas.')
                      }
                    >
                      Receber tudo o que está em trânsito
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        void a.run(
                          async () => (await api('POST', `/api/wms/transfers/${d.id}/close`), refresh()),
                          'Transferência fechada; diferenças registadas como perda.',
                        )
                      }
                    >
                      Fechar (registar perdas)
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>
      <ErrorNotice error={a.error ?? list.error} />
      {a.message && <Notice kind="ok">{a.message}</Notice>}
    </Page>
  );
}

/** Returns: receive into inspection, then disposition. */
export function ReturnsPage() {
  const { activeWh } = useSession();
  const wh = activeWh!.id;
  const list = useLoad(() => api<Array<Row & { lines: unknown }>>('GET', `${wp(wh)}/returns`), [wh]);
  const skus = useLoad(() => loadSkus(), []);
  const nodes = useLoad(() => loadNodes(wh), [wh]);
  const boxes = useLoad(() => loadContainers(wh), [wh]);
  const [nf, setNf] = useState({ skuId: '', qty: '', insp: '', ref: '' });
  const [disp, setDisp] = useState({ returnId: '', lineId: '', disposition: 'SALEABLE', qty: '', to: '' });
  const a = useAction();
  return (
    <Page
      title="Devoluções"
      purpose="Receber devoluções para inspeção e decidir: vendável, quarentena, danificado ou abate."
      steps={['Receber para inspeção', 'Inspecionar', 'Aplicar decisão']}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Nova devolução">
          <Form
            className="space-y-2"
            onSubmit={() =>
              void a.run(
                async () => (
                  await api('POST', `${wp(wh)}/returns`, {
                    inspectionNodeId: nf.insp,
                    ...(nf.ref ? { externalRef: nf.ref } : {}),
                    lines: [{ skuId: nf.skuId, qty: nf.qty }],
                  }),
                  list.reload()
                ),
                'Devolução recebida em inspeção.',
              )
            }
          >
            <Select
              label="Artigo"
              value={nf.skuId}
              onChange={(v) => setNf({ ...nf, skuId: v })}
              options={(skus.data ?? []).map((s) => ({ value: s.id, label: s.code }))}
              required
            />
            <Field label="Quantidade" value={nf.qty} onChange={(v) => setNf({ ...nf, qty: v })} required inputMode="decimal" />
            <Select
              label="Zona de inspeção"
              value={nf.insp}
              onChange={(v) => setNf({ ...nf, insp: v })}
              options={nodeOptions(nodes.data, ['INSPECTION'])}
              required
            />
            <Field label="Referência" value={nf.ref} onChange={(v) => setNf({ ...nf, ref: v })} maxLength={80} />
            <Button type="submit">Receber</Button>
          </Form>
        </Panel>
        <Panel title="Em inspeção / histórico">
          {list.loading ? (
            <Loading />
          ) : (
            <ul className="space-y-2 text-sm">
              {(list.data ?? []).map((r) => (
                <li key={r.id} className="rounded border border-line p-2">
                  <strong>{r.number}</strong> <Pill tone={r.status === 'CLOSED' ? 'ok' : 'warn'}>{r.status}</Pill>
                  {(r.lines as Row[]).map((l) => (
                    <div key={l.lineId} className="flex flex-wrap items-center gap-2">
                      {l.skuCode}: recebido {fmtQty(l.qtyReceived)} · vendável {fmtQty(l.qtySaleable)} · quarentena{' '}
                      {fmtQty(l.qtyQuarantined)} · danificado {fmtQty(l.qtyDamaged)} · abate {fmtQty(l.qtyScrapped)}
                      {r.status !== 'CLOSED' && (
                        <Button small variant="secondary" onClick={() => setDisp({ ...disp, returnId: r.id!, lineId: l.lineId! })}>
                          Decidir
                        </Button>
                      )}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
          {disp.lineId && (
            <Form
              className="mt-3 grid grid-cols-2 gap-2"
              onSubmit={() =>
                void a.run(async () => {
                  await api('POST', `${wp(wh)}/returns/${disp.returnId}/disposition`, {
                    lines: [
                      {
                        lineId: disp.lineId,
                        disposition: disp.disposition,
                        qty: disp.qty,
                        ...(disp.disposition !== 'SCRAP' ? { to: holderRef(disp.to) } : {}),
                      },
                    ],
                  });
                  setDisp({ ...disp, lineId: '' });
                  list.reload();
                }, 'Decisão registada.')
              }
            >
              <Select
                label="Decisão"
                value={disp.disposition}
                onChange={(v) => setDisp({ ...disp, disposition: v })}
                options={[
                  { value: 'SALEABLE', label: 'Vendável' },
                  { value: 'QUARANTINE', label: 'Quarentena' },
                  { value: 'DAMAGED', label: 'Danificado' },
                  { value: 'SCRAP', label: 'Abate' },
                ]}
              />
              <Field label="Quantidade" value={disp.qty} onChange={(v) => setDisp({ ...disp, qty: v })} required inputMode="decimal" />
              {disp.disposition !== 'SCRAP' && (
                <Select
                  label="Destino"
                  value={disp.to}
                  onChange={(v) => setDisp({ ...disp, to: v })}
                  options={
                    disp.disposition === 'SALEABLE'
                      ? holderOptions(nodes.data, boxes.data)
                      : holderOptions(nodes.data, [], disp.disposition === 'QUARANTINE' ? ['QUARANTINE'] : ['QUARANTINE', 'INSPECTION'])
                  }
                  required
                />
              )}
              <Button type="submit">Aplicar</Button>
            </Form>
          )}
        </Panel>
      </div>
      <ErrorNotice error={a.error ?? list.error} />
      {a.message && <Notice kind="ok">{a.message}</Notice>}
    </Page>
  );
}

interface CountDoc {
  id: string;
  number: string;
  status: string;
  blind: boolean;
  lines: Row[];
}

/** Stock counts with blind counting, submit, recount and segregated approval. */
export function CountsPage() {
  const { activeWh, can, withStepUp } = useSession();
  const wh = activeWh!.id;
  const list = useLoad(() => api<Row[]>('GET', `${wp(wh)}/counts`), [wh]);
  const nodes = useLoad(() => loadNodes(wh), [wh]);
  const [openId, setOpenId] = useState<string>();
  const doc = useLoad(() => (openId ? api<CountDoc>('GET', `${wp(wh)}/counts/${openId}`) : Promise.resolve(undefined)), [wh, openId]);
  const [scope, setScope] = useState({ kind: 'CYCLE', nodeId: '' });
  const [counts, setCounts] = useState<Record<string, string>>({});
  const a = useAction();
  const d = doc.data;
  const refresh = () => (doc.reload(), list.reload());
  return (
    <Page
      title="Contagens"
      purpose="Contagens totais, parciais ou cíclicas. Contagem cega para operadores; aprovação por outra pessoa com confirmação MFA."
      steps={['Abrir contagem', 'Contar e submeter', 'Aprovar ajustes']}
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Contagens">
          <Table
            rows={list.data ?? []}
            rowKey={(r) => r.id!}
            cols={[
              {
                h: 'Número',
                c: (r) => (
                  <Button small variant="ghost" onClick={() => setOpenId(r.id!)}>
                    {r.number}
                  </Button>
                ),
              },
              { h: 'Tipo', c: (r) => r.kind },
              { h: 'Estado', c: (r) => <Pill>{r.status}</Pill> },
              { h: 'Data', c: (r) => fmtDate(r.createdAt) },
            ]}
          />
          <Form
            className="mt-3 space-y-2"
            onSubmit={() =>
              void a.run(
                async () =>
                  setOpenId(
                    (
                      await api<{ id: string }>('POST', `${wp(wh)}/counts`, {
                        kind: scope.kind,
                        nodeIds: scope.nodeId ? [scope.nodeId] : [],
                      })
                    ).id,
                  ),
                'Contagem aberta.',
              )
            }
          >
            <Select
              label="Tipo"
              value={scope.kind}
              onChange={(v) => setScope({ ...scope, kind: v })}
              options={[
                { value: 'CYCLE', label: 'Cíclica' },
                { value: 'PARTIAL', label: 'Parcial' },
                { value: 'FULL', label: 'Total' },
              ]}
            />
            <Select
              label="Localização (inclui subníveis)"
              value={scope.nodeId}
              onChange={(v) => setScope({ ...scope, nodeId: v })}
              options={(nodes.data ?? []).map((n) => ({ value: n.id, label: n.path }))}
            />
            <Button type="submit">Abrir contagem</Button>
          </Form>
        </Panel>
        <Panel title={d ? `Contagem ${d.number} (${d.status})` : 'Selecione uma contagem'} className="lg:col-span-2">
          {d && (
            <div className="space-y-3">
              {d.blind && <Notice kind="info">Contagem cega: as quantidades esperadas não são mostradas.</Notice>}
              <Table
                rows={d.lines}
                rowKey={(r) => r.id!}
                cols={[
                  { h: 'Localização', c: (r) => `${r.nodePath}${r.containerCode ? ` / ${r.containerCode}` : ''}` },
                  { h: 'Artigo', c: (r) => r.skuCode },
                  ...(d.blind
                    ? []
                    : [
                        { h: 'Esperado', c: (r: Row) => fmtQty(r.qtySnapshot), num: true },
                        { h: 'Diferença', c: (r: Row) => fmtQty(r.delta), num: true },
                      ]),
                  { h: 'Contado', c: (r) => fmtQty(r.qtyCounted), num: true },
                  { h: 'Estado', c: (r) => <Pill tone={r.state === 'STALE' ? 'danger' : 'neutral'}>{r.state}</Pill> },
                  {
                    h: 'Contar',
                    c: (r) =>
                      d.status === 'OPEN' ? (
                        <span className="flex gap-1">
                          <input
                            aria-label={`Quantidade contada ${r.skuCode}`}
                            className="w-20 rounded border border-line-strong px-1"
                            inputMode="decimal"
                            value={counts[r.id!] ?? ''}
                            onChange={(e) => setCounts({ ...counts, [r.id!]: e.target.value })}
                          />
                          <Button
                            small
                            onClick={() =>
                              void a.run(
                                async () => (
                                  await api('POST', `${wp(wh)}/counts/${d.id}/lines/${r.id}/count`, { qtyCounted: counts[r.id!] }),
                                  doc.reload()
                                ),
                              )
                            }
                          >
                            OK
                          </Button>
                        </span>
                      ) : r.state === 'STALE' ? (
                        <Button
                          small
                          variant="secondary"
                          onClick={() =>
                            void a.run(async () => (await api('POST', `${wp(wh)}/counts/${d.id}/lines/${r.id}/recount`), refresh()))
                          }
                        >
                          Recontar
                        </Button>
                      ) : null,
                  },
                ]}
              />
              <div className="flex gap-2">
                {d.status === 'OPEN' && (
                  <Button
                    onClick={() =>
                      void a.run(async () => (await api('POST', `${wp(wh)}/counts/${d.id}/submit`), refresh()), 'Contagem submetida.')
                    }
                  >
                    Submeter
                  </Button>
                )}
                {d.status === 'SUBMITTED' && can('wms.count.approve') && (
                  <Button
                    onClick={() =>
                      void a.run(
                        async () => (await withStepUp(() => api('POST', `${wp(wh)}/counts/${d.id}/approve`)), refresh()),
                        'Ajustes aprovados e lançados.',
                      )
                    }
                  >
                    Aprovar ajustes
                  </Button>
                )}
                {['OPEN', 'SUBMITTED'].includes(d.status) && (
                  <Button
                    variant="secondary"
                    onClick={() => void a.run(async () => (await api('POST', `${wp(wh)}/counts/${d.id}/cancel`), refresh()))}
                  >
                    Cancelar
                  </Button>
                )}
              </div>
            </div>
          )}
        </Panel>
      </div>
      <ErrorNotice error={a.error ?? list.error} />
      {a.message && <Notice kind="ok">{a.message}</Notice>}
    </Page>
  );
}

/** Replenishment rules and suggestions. */
export function ReplenishmentPage() {
  const { activeWh } = useSession();
  const wh = activeWh!.id;
  const skus = useLoad(() => loadSkus(), []);
  const nodes = useLoad(() => loadNodes(wh), [wh]);
  const sug = useLoad(
    () => api<{ moves: Row[]; purchaseSuggestions: Row[]; note: string }>('GET', `${wp(wh)}/replenishment/suggestions`),
    [wh],
  );
  const [exec, setExec] = useState<{ move: Row; scan: string } | null>(null);
  const [r, setR] = useState({ skuId: '', pickNodeId: '', minQty: '', targetQty: '' });
  const a = useAction();
  return (
    <Page
      title="Reposição"
      purpose="Mantém as localizações de picking abastecidas a partir do stock de reserva. Sugestões de compra são apenas informativas."
      steps={['Defina mínimo/alvo', 'Veja sugestões', 'Execute movimentos']}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Regra de reposição">
          <Form
            className="grid grid-cols-2 gap-2"
            onSubmit={() =>
              void a.run(async () => (await api('POST', `${wp(wh)}/replenishment/rules`, r), sug.reload()), 'Regra guardada.')
            }
          >
            <Select
              label="Artigo"
              value={r.skuId}
              onChange={(v) => setR({ ...r, skuId: v })}
              options={(skus.data ?? []).map((s) => ({ value: s.id, label: s.code }))}
              required
            />
            <Select
              label="Localização de picking"
              value={r.pickNodeId}
              onChange={(v) => setR({ ...r, pickNodeId: v })}
              options={nodeOptions(nodes.data, ['SHELF', 'BIN', 'LOCATION'])}
              required
            />
            <Field label="Mínimo" value={r.minQty} onChange={(v) => setR({ ...r, minQty: v })} required inputMode="decimal" />
            <Field label="Alvo" value={r.targetQty} onChange={(v) => setR({ ...r, targetQty: v })} required inputMode="decimal" />
            <Button type="submit">Guardar</Button>
          </Form>
        </Panel>
        <Panel title="Sugestões">
          <Table
            rows={sug.data?.moves ?? []}
            rowKey={(m) => `${m.ruleId}${m.fromPositionId}`}
            cols={[
              { h: 'Artigo', c: (m) => m.skuCode },
              { h: 'De', c: (m) => `${m.fromPath}${m.fromContainer ? ` / ${m.fromContainer}` : ''}` },
              { h: 'Para', c: (m) => m.toPath },
              { h: 'Qtd', c: (m) => fmtQty(m.qty), num: true },
              {
                h: '',
                c: (m) => (
                  <Button small onClick={() => setExec({ move: m, scan: '' })}>
                    Executar
                  </Button>
                ),
              },
            ]}
            empty="Nenhuma localização abaixo do mínimo."
          />
          <h3 className="mt-3 font-semibold">Sugestões de compra (informativas)</h3>
          <Table
            rows={sug.data?.purchaseSuggestions ?? []}
            rowKey={(p) => p.skuId!}
            cols={[
              { h: 'Artigo', c: (p) => p.skuCode },
              { h: 'Qtd sugerida', c: (p) => fmtQty(p.suggestedQty), num: true },
              { h: 'Motivo', c: (p) => p.reason },
            ]}
            empty="Sem sugestões."
          />
          {exec && (
            <Form
              className="mt-3 flex flex-wrap items-end gap-2 rounded border border-teal p-3"
              onSubmit={() =>
                void a.run(async () => {
                  await api('POST', `${wp(wh)}/replenishment/execute`, {
                    ruleId: exec.move.ruleId,
                    fromPositionId: exec.move.fromPositionId,
                    qty: exec.move.qty,
                    scan: exec.scan,
                  });
                  setExec(null);
                  sug.reload();
                }, 'Reposição executada.')
              }
            >
              <p className="w-full text-sm">
                Leve {fmtQty(exec.move.qty)} × {exec.move.skuCode} para {exec.move.toPath} e leia a etiqueta dessa localização.
              </p>
              <Field
                label="Ler etiqueta do destino"
                value={exec.scan}
                onChange={(v) => setExec({ ...exec, scan: v })}
                required
                autoComplete="off"
                maxLength={64}
              />
              <Button type="submit" disabled={a.busy}>
                Confirmar reposição
              </Button>
              <Button variant="secondary" onClick={() => setExec(null)}>
                Cancelar
              </Button>
            </Form>
          )}
        </Panel>
      </div>
      <ErrorNotice error={a.error ?? sug.error} />
      {a.message && <Notice kind="ok">{a.message}</Notice>}
    </Page>
  );
}
