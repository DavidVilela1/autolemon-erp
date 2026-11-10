/**
 * @file Outbound: WMS-native requests, allocation, scanner picking, packing, partial dispatch,
 * backorders and the internal dispatch note (not a fiscal transport document).
 * @module web/pages
 */
import { useState } from 'react';
import { api, fmtQty } from '../api';
import {
  Button,
  ErrorNotice,
  Field,
  Form,
  Loading,
  Notice,
  Page,
  Panel,
  Pill,
  ScanInput,
  Select,
  Table,
  useAction,
  useLoad,
} from '../components/ui';
import { useSession } from '../session';
import { holderOptions, holderRef, loadNodes, loadSkus, nodeOptions, type Row, wp } from '../wms-data';

interface OutDoc {
  id: string;
  number: string;
  status: string;
  externalRef: string | null;
  recipientContact: string | null;
  lines: Row[];
  pickList: Row[];
  packages: Array<{ id: string; code: string; status: string; contents: Array<{ lineId: string; qty: string }> }>;
}

/** Outbound screen. */
export function OutboundPage() {
  const { activeWh, can } = useSession();
  const wh = activeWh!.id;
  const list = useLoad(() => api<Row[]>('GET', `${wp(wh)}/outbound`), [wh]);
  const skus = useLoad(() => loadSkus(), []);
  const nodes = useLoad(() => loadNodes(wh), [wh]);
  const [openId, setOpenId] = useState<string>();
  const doc = useLoad(() => (openId ? api<OutDoc>('GET', `${wp(wh)}/outbound/${openId}`) : Promise.resolve(undefined)), [wh, openId]);
  const [nf, setNf] = useState({ skuId: '', qty: '', externalRef: '', recipient: '' });
  const [packNode, setPackNode] = useState('');
  const [pick, setPick] = useState<{ reservationId: string; qty: string; short: boolean } | null>(null);
  const [pack, setPack] = useState({ packageId: '', lineId: '', qty: '' });
  const [sel, setSel] = useState<string[]>([]);
  const [unpick, setUnpick] = useState<{ lineId: string; qty: string; to: string } | null>(null);
  const [unpack, setUnpack] = useState<{ packageId: string; lineId: string; qty: string } | null>(null);
  const a = useAction();
  const refresh = () => (doc.reload(), list.reload());
  const d = doc.data;
  return (
    <Page
      title="Saídas"
      purpose="Pedidos de saída do armazém (sem módulo de vendas): reservar, separar com leitura, embalar em volumes e expedir."
      steps={['Crie e aloque', 'Separe com leitura', 'Embale em volumes', 'Expedir (parcial permitido)']}
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Pedidos">
          {list.loading ? (
            <Loading />
          ) : (
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
                { h: 'Estado', c: (r) => <Pill tone={r.status === 'CLOSED' ? 'ok' : 'warn'}>{r.status}</Pill> },
                { h: 'Exp./Ped.', c: (r) => `${fmtQty(r.qtyDispatched)} / ${fmtQty(r.qtyRequested)}`, num: true },
              ]}
            />
          )}
          {can('wms.outbound.manage') && (
            <Form
              className="mt-3 space-y-2"
              onSubmit={() =>
                void a.run(async () => {
                  const r = await api<{ id: string }>('POST', `${wp(wh)}/outbound`, {
                    lines: [{ skuId: nf.skuId, qty: nf.qty }],
                    ...(nf.externalRef ? { externalRef: nf.externalRef } : {}),
                    ...(nf.recipient ? { recipientContact: nf.recipient } : {}),
                  });
                  setOpenId(r.id);
                  list.reload();
                }, 'Pedido criado (rascunho).')
              }
            >
              <h3 className="font-semibold">Novo pedido</h3>
              <Select
                label="Artigo"
                value={nf.skuId}
                onChange={(v) => setNf({ ...nf, skuId: v })}
                options={(skus.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.description}` }))}
                required
              />
              <Field label="Quantidade" value={nf.qty} onChange={(v) => setNf({ ...nf, qty: v })} required inputMode="decimal" />
              <Field label="Referência externa" value={nf.externalRef} onChange={(v) => setNf({ ...nf, externalRef: v })} maxLength={80} />
              <Field
                label="Contacto/morada de entrega (cifrado)"
                value={nf.recipient}
                onChange={(v) => setNf({ ...nf, recipient: v })}
                maxLength={500}
              />
              <Button type="submit" disabled={a.busy}>
                Criar
              </Button>
            </Form>
          )}
        </Panel>
        <Panel title={d ? `Pedido ${d.number} (${d.status})` : 'Selecione um pedido'} className="lg:col-span-2">
          {d && (
            <div className="space-y-4">
              {d.recipientContact && <p className="text-sm">Entrega: {d.recipientContact}</p>}
              <Table
                rows={d.lines}
                rowKey={(r) => r.id!}
                cols={[
                  { h: 'Artigo', c: (r) => r.skuCode },
                  { h: 'Pedido', c: (r) => fmtQty(r.qtyRequested), num: true },
                  { h: 'Reservado', c: (r) => fmtQty(r.qtyAllocated), num: true },
                  { h: 'Separado', c: (r) => fmtQty(r.qtyPicked), num: true },
                  { h: 'Embalado', c: (r) => fmtQty(r.qtyPacked), num: true },
                  { h: 'Expedido', c: (r) => fmtQty(r.qtyDispatched), num: true },
                  { h: 'Falta', c: (r) => fmtQty(r.qtyShort), num: true },
                  {
                    h: '',
                    c: (r) =>
                      d.status === 'IN_PROGRESS' &&
                      can('wms.pick') &&
                      Number(r.qtyPicked) > Number(r.qtyPacked) && (
                        <Button
                          small
                          variant="secondary"
                          onClick={() => setUnpick({ lineId: r.id!, qty: String(Number(r.qtyPicked) - Number(r.qtyPacked)), to: '' })}
                        >
                          Anular separação
                        </Button>
                      ),
                  },
                ]}
              />
              {unpick && (
                <Form
                  className="grid gap-2 rounded border border-teal p-3 md:grid-cols-4"
                  onSubmit={() =>
                    void a.run(async () => {
                      await api('POST', `${wp(wh)}/outbound/${d.id}/unpick`, {
                        lineId: unpick.lineId,
                        qty: unpick.qty,
                        fromNodeId: packNode,
                        to: holderRef(unpick.to),
                      });
                      setUnpick(null);
                      refresh();
                    }, 'Separação anulada; stock devolvido à armazenagem.')
                  }
                >
                  <p className="text-sm md:col-span-4">
                    Devolve unidades separadas (fora de volumes) da zona de embalagem selecionada abaixo para uma localização de
                    armazenagem.
                  </p>
                  <Field
                    label="Quantidade a devolver"
                    value={unpick.qty}
                    onChange={(v) => setUnpick({ ...unpick, qty: v })}
                    required
                    inputMode="decimal"
                  />
                  <Select
                    label="Devolver para"
                    value={unpick.to}
                    onChange={(v) => setUnpick({ ...unpick, to: v })}
                    options={holderOptions(nodes.data, undefined)}
                    required
                  />
                  <div className="flex items-end gap-2 md:col-span-2">
                    <Button type="submit" disabled={a.busy || !packNode}>
                      Confirmar devolução
                    </Button>
                    <Button variant="secondary" onClick={() => setUnpick(null)}>
                      Cancelar
                    </Button>
                  </div>
                </Form>
              )}
              <div className="no-print flex flex-wrap gap-2">
                {['DRAFT', 'ALLOCATED', 'IN_PROGRESS'].includes(d.status) && can('wms.outbound.manage') && (
                  <Button
                    onClick={() =>
                      void a.run(async () => (await api('POST', `${wp(wh)}/outbound/${d.id}/allocate`), refresh()), 'Alocação concluída.')
                    }
                  >
                    Alocar stock
                  </Button>
                )}
                {['ALLOCATED', 'IN_PROGRESS'].includes(d.status) && can('wms.outbound.manage') && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void a.run(
                        async () => (await api('POST', `${wp(wh)}/outbound/${d.id}/close`, { createBackorder: true }), refresh()),
                        'Pedido fechado; pendente passou a encomenda pendente (backorder).',
                      )
                    }
                  >
                    Fechar com pendente
                  </Button>
                )}
                {['DRAFT', 'ALLOCATED', 'IN_PROGRESS'].includes(d.status) && can('wms.outbound.manage') && (
                  <Button
                    variant="danger"
                    onClick={() =>
                      void a.run(async () => (await api('POST', `${wp(wh)}/outbound/${d.id}/cancel`), refresh()), 'Pedido cancelado.')
                    }
                  >
                    Cancelar
                  </Button>
                )}
                <Button variant="ghost" onClick={() => window.print()}>
                  Imprimir guia interna
                </Button>
              </div>
              <Select
                label="Zona de embalagem/expedição"
                value={packNode}
                onChange={setPackNode}
                options={nodeOptions(nodes.data, ['DISPATCH'])}
              />
              <h3 className="font-semibold">Lista de separação</h3>
              <Table
                rows={d.pickList}
                rowKey={(r) => r.reservationId!}
                cols={[
                  { h: 'Localização', c: (r) => `${r.nodePath}${r.containerCode ? ` / ${r.containerCode}` : ''}` },
                  { h: 'Artigo', c: (r) => r.skuCode },
                  { h: 'A separar', c: (r) => fmtQty(r.qtyOpen), num: true },
                  {
                    h: '',
                    c: (r) =>
                      can('wms.pick') && (
                        <Button small onClick={() => setPick({ reservationId: r.reservationId!, qty: r.qtyOpen!, short: false })}>
                          Separar
                        </Button>
                      ),
                  },
                ]}
                empty="Nada por separar."
              />
              {pick && (
                <div className="grid gap-2 rounded border border-teal p-3 md:grid-cols-3">
                  <Field label="Quantidade separada" value={pick.qty} onChange={(v) => setPick({ ...pick, qty: v })} inputMode="decimal" />
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={pick.short} onChange={(e) => setPick({ ...pick, short: e.target.checked })} /> Falta:
                    libertar o restante
                  </label>
                  <div className="md:col-span-3">
                    <ScanInput
                      label="Ler artigo para confirmar"
                      onScan={(barcode) =>
                        void a.run(async () => {
                          await api('POST', `${wp(wh)}/outbound/${d.id}/pick`, {
                            reservationId: pick.reservationId,
                            qty: pick.qty,
                            barcode,
                            packingNodeId: packNode,
                            closeShort: pick.short,
                          });
                          setPick(null);
                          refresh();
                        }, 'Separação registada.')
                      }
                    />
                  </div>
                </div>
              )}
              {d.status === 'IN_PROGRESS' && (
                <>
                  <h3 className="font-semibold">Volumes</h3>
                  <Table
                    rows={d.packages}
                    rowKey={(p) => p.id}
                    cols={[
                      {
                        h: '',
                        c: (p) =>
                          p.status === 'ACTIVE' && (
                            <input
                              aria-label={`Selecionar ${p.code}`}
                              type="checkbox"
                              checked={sel.includes(p.id)}
                              onChange={(e) => setSel(e.target.checked ? [...sel, p.id] : sel.filter((x) => x !== p.id))}
                            />
                          ),
                      },
                      { h: 'Volume', c: (p) => p.code },
                      { h: 'Estado', c: (p) => p.status },
                      { h: 'Unidades', c: (p) => fmtQty(p.contents.reduce((s, c) => s + Number(c.qty), 0)), num: true },
                      {
                        h: '',
                        c: (p) =>
                          p.status === 'ACTIVE' &&
                          can('wms.pack') && (
                            <span className="flex gap-1">
                              <Button
                                small
                                variant="secondary"
                                onClick={() => setPack({ packageId: p.id, lineId: d.lines[0]?.id ?? '', qty: '' })}
                              >
                                Embalar aqui
                              </Button>
                              {p.contents.length > 0 && (
                                <Button
                                  small
                                  variant="ghost"
                                  onClick={() => setUnpack({ packageId: p.id, lineId: p.contents[0]!.lineId, qty: '' })}
                                >
                                  Retirar
                                </Button>
                              )}
                            </span>
                          ),
                      },
                    ]}
                  />
                  <div className="flex flex-wrap gap-2">
                    {can('wms.pack') && (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          void a.run(
                            async () => (
                              await api('POST', `${wp(wh)}/outbound/${d.id}/packages`, {
                                code: `${d.number.slice(-6)}-V${d.packages.length + 1}`,
                                nodeId: packNode,
                              }),
                              refresh()
                            ),
                            'Volume criado.',
                          )
                        }
                      >
                        Novo volume
                      </Button>
                    )}
                    {can('wms.dispatch') && (
                      <Button
                        disabled={!sel.length}
                        onClick={() =>
                          void a.run(
                            async () => (
                              await api('POST', `${wp(wh)}/outbound/${d.id}/dispatch`, { packageIds: sel }),
                              setSel([]),
                              refresh()
                            ),
                            'Volumes expedidos.',
                          )
                        }
                      >
                        Expedir selecionados
                      </Button>
                    )}
                  </div>
                  {unpack && (
                    <Form
                      className="grid gap-2 rounded border border-teal p-3 md:grid-cols-4"
                      onSubmit={() =>
                        void a.run(async () => {
                          await api('POST', `${wp(wh)}/outbound/${d.id}/unpack`, unpack);
                          setUnpack(null);
                          refresh();
                        }, 'Unidades retiradas do volume (ficam separadas na zona de embalagem).')
                      }
                    >
                      <Select
                        label="Linha"
                        value={unpack.lineId}
                        onChange={(v) => setUnpack({ ...unpack, lineId: v })}
                        options={d.lines.map((l) => ({ value: l.id!, label: l.skuCode! }))}
                        required
                      />
                      <Field
                        label="Quantidade a retirar"
                        value={unpack.qty}
                        onChange={(v) => setUnpack({ ...unpack, qty: v })}
                        required
                        inputMode="decimal"
                      />
                      <div className="flex items-end gap-2 md:col-span-2">
                        <Button type="submit" disabled={a.busy}>
                          Retirar do volume
                        </Button>
                        <Button variant="secondary" onClick={() => setUnpack(null)}>
                          Cancelar
                        </Button>
                      </div>
                    </Form>
                  )}
                  {pack.packageId && (
                    <div className="grid gap-2 rounded border border-teal p-3 md:grid-cols-3">
                      <Select
                        label="Linha"
                        value={pack.lineId}
                        onChange={(v) => setPack({ ...pack, lineId: v })}
                        options={d.lines.map((l) => ({ value: l.id!, label: l.skuCode! }))}
                      />
                      <Field label="Quantidade" value={pack.qty} onChange={(v) => setPack({ ...pack, qty: v })} inputMode="decimal" />
                      <div className="md:col-span-3">
                        <ScanInput
                          label="Ler artigo a embalar"
                          onScan={(barcode) =>
                            void a.run(async () => {
                              await api('POST', `${wp(wh)}/outbound/${d.id}/pack`, { ...pack, barcode });
                              setPack({ packageId: '', lineId: '', qty: '' });
                              refresh();
                            }, 'Embalado.')
                          }
                        />
                      </div>
                    </div>
                  )}
                </>
              )}
              <p className="text-xs text-ink-soft">
                Documento interno de expedição. Não substitui documento de transporte com comunicação à AT (DL 147/2003).
              </p>
            </div>
          )}
        </Panel>
      </div>
      <ErrorNotice error={a.error ?? list.error ?? doc.error} />
      {a.message && <Notice kind="ok">{a.message}</Notice>}
    </Page>
  );
}
