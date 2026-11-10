/**
 * @file Stock overview (per-SKU totals), stock positions and internal moves.
 * @module web/pages
 */
import { useState } from 'react';
import { api, fmtQty } from '../api';
import { Button, ErrorNotice, Field, Form, Loading, Notice, Page, Panel, Pill, Select, Table, useAction, useLoad } from '../components/ui';
import { useSession } from '../session';
import { holderOptions, holderRef, loadContainers, loadNodes, loadPositions, type Row, STATUS_PT, wp } from '../wms-data';

/** Stock overview screen. */
export function StockPage() {
  const { activeWh, can, withStepUp } = useSession();
  const wh = activeWh!.id;
  const [skuId, setSkuId] = useState<string>();
  const summary = useLoad(() => api<Row[]>('GET', `${wp(wh)}/stock/summary`), [wh]);
  const positions = useLoad(() => loadPositions(wh, skuId), [wh, skuId]);
  const nodes = useLoad(() => loadNodes(wh), [wh]);
  const containers = useLoad(() => loadContainers(wh), [wh]);
  const [move, setMove] = useState({ positionId: '', qty: '', to: '', reason: '', scan: '' });
  const emptyStatus = { positionId: '', from: '', qty: '', toStatus: 'QUARANTINE', to: '', reason: '' };
  const [st, setSt] = useState(emptyStatus);
  const a = useAction();
  return (
    <Page
      title="Stock"
      purpose={`Existências do armazém ${activeWh!.code}: totais por artigo e posições físicas.`}
      steps={['Escolha um artigo', 'Veja onde está', 'Mova stock livre se necessário']}
    >
      <Panel title="Totais por artigo">
        {summary.loading ? (
          <Loading />
        ) : (
          <Table
            rows={summary.data ?? []}
            rowKey={(r) => r.skuId!}
            cols={[
              {
                h: 'Artigo',
                c: (r) => (
                  <Button variant="ghost" small onClick={() => setSkuId(r.skuId!)}>
                    {r.skuCode}
                  </Button>
                ),
              },
              { h: 'Descrição', c: (r) => r.description },
              { h: 'Existência', c: (r) => fmtQty(r.onHand), num: true },
              { h: 'Reservado', c: (r) => fmtQty(r.reserved), num: true },
              { h: 'Disponível p/ alocar', c: (r) => <strong>{fmtQty(r.availableToAllocate)}</strong>, num: true },
              { h: 'Por arrumar', c: (r) => fmtQty(r.received), num: true },
              { h: 'Inspeção', c: (r) => fmtQty(r.inspection), num: true },
              { h: 'Quarentena', c: (r) => fmtQty(r.quarantine), num: true },
              { h: 'Separado', c: (r) => fmtQty(r.picked), num: true },
              { h: 'Posições', c: (r) => r.positions, num: true },
            ]}
          />
        )}
        <ErrorNotice error={summary.error} />
      </Panel>
      <Panel title={skuId ? 'Posições do artigo selecionado' : 'Todas as posições'}>
        {skuId && (
          <Button variant="ghost" small onClick={() => setSkuId(undefined)}>
            Mostrar todas
          </Button>
        )}
        {positions.loading ? (
          <Loading />
        ) : (
          <Table
            rows={positions.data ?? []}
            rowKey={(r) => r.id!}
            cols={[
              { h: 'Artigo', c: (r) => r.skuCode },
              { h: 'Localização', c: (r) => r.nodePath },
              { h: 'Caixa', c: (r) => r.containerCode ?? '—' },
              {
                h: 'Estado',
                c: (r) => (
                  <Pill tone={r.status === 'AVAILABLE' ? 'ok' : r.status === 'DAMAGED' || r.status === 'QUARANTINE' ? 'danger' : 'warn'}>
                    {STATUS_PT[r.status!] ?? r.status}
                  </Pill>
                ),
              },
              { h: 'Lote', c: (r) => r.lot || '—' },
              { h: 'Existência', c: (r) => fmtQty(r.onHand), num: true },
              { h: 'Reservado', c: (r) => fmtQty(r.reserved), num: true },
              { h: 'Livre', c: (r) => fmtQty(r.free), num: true },
              ...(can('wms.putaway') || can('wms.adjust')
                ? [
                    {
                      h: 'Ação',
                      c: (r: Row) => (
                        <div className="flex gap-1">
                          {can('wms.putaway') && (
                            <Button small variant="secondary" onClick={() => setMove({ ...move, positionId: r.id! })}>
                              Mover
                            </Button>
                          )}
                          {can('wms.adjust') && ['AVAILABLE', 'QUARANTINE', 'DAMAGED', 'INSPECTION'].includes(r.status!) && (
                            <Button
                              small
                              variant="secondary"
                              onClick={() =>
                                setSt({
                                  ...emptyStatus,
                                  positionId: r.id!,
                                  from: r.status!,
                                  toStatus: r.status === 'AVAILABLE' ? 'QUARANTINE' : 'AVAILABLE',
                                })
                              }
                            >
                              Estado
                            </Button>
                          )}
                        </div>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Panel>
      {move.positionId && (
        <Panel title="Mover stock livre">
          <Form
            className="grid grid-cols-1 gap-3 md:grid-cols-5"
            onSubmit={() =>
              void a.run(async () => {
                await api('POST', `${wp(wh)}/stock/move`, {
                  positionId: move.positionId,
                  qty: move.qty,
                  to: holderRef(move.to),
                  scan: move.scan,
                  ...(move.reason ? { reason: move.reason } : {}),
                });
                setMove({ positionId: '', qty: '', to: '', reason: '', scan: '' });
                summary.reload();
                positions.reload();
              }, 'Movimento registado.')
            }
          >
            <Field label="Quantidade" value={move.qty} onChange={(v) => setMove({ ...move, qty: v })} required inputMode="decimal" />
            <Select
              label="Destino"
              value={move.to}
              onChange={(v) => setMove({ ...move, to: v })}
              options={holderOptions(nodes.data, containers.data, ['SHELF', 'BIN', 'LOCATION', 'QUARANTINE', 'INSPECTION'])}
              required
            />
            <Field label="Motivo" value={move.reason} onChange={(v) => setMove({ ...move, reason: v })} />
            <Field
              label="Ler etiqueta do destino"
              value={move.scan}
              onChange={(v) => setMove({ ...move, scan: v })}
              required
              autoComplete="off"
              maxLength={64}
            />
            <div className="flex items-end gap-2">
              <Button type="submit" disabled={a.busy}>
                Mover
              </Button>
              <Button variant="secondary" onClick={() => setMove({ positionId: '', qty: '', to: '', reason: '', scan: '' })}>
                Cancelar
              </Button>
            </div>
          </Form>
        </Panel>
      )}
      {st.positionId && (
        <Panel title={`Alterar estado de qualidade (atual: ${STATUS_PT[st.from] ?? st.from})`}>
          <p className="mb-2 text-sm text-ink-soft">
            Bloquear stock (quarentena, danificado, inspeção) ou libertá-lo para venda. Libertar exige confirmação de identidade e um
            destino de armazenagem (prateleira, bin ou localização). Tudo fica no registo de auditoria.
          </p>
          <Form
            className="grid grid-cols-1 gap-3 md:grid-cols-5"
            onSubmit={() =>
              void a.run(async () => {
                await withStepUp(() =>
                  api('POST', `${wp(wh)}/stock/status`, {
                    positionId: st.positionId,
                    qty: st.qty,
                    toStatus: st.toStatus,
                    ...(st.to ? { to: holderRef(st.to) } : {}),
                    reason: st.reason,
                  }),
                );
                setSt(emptyStatus);
                summary.reload();
                positions.reload();
              }, 'Estado alterado.')
            }
          >
            <Field label="Quantidade" value={st.qty} onChange={(v) => setSt({ ...st, qty: v })} required inputMode="decimal" />
            <Select
              label="Novo estado"
              value={st.toStatus}
              onChange={(v) => setSt({ ...st, toStatus: v })}
              options={['AVAILABLE', 'QUARANTINE', 'DAMAGED', 'INSPECTION']
                .filter((x) => x !== st.from)
                .map((x) => ({ value: x, label: STATUS_PT[x] ?? x }))}
              required
            />
            <Select
              label="Destino (vazio = mesmo local)"
              value={st.to}
              onChange={(v) => setSt({ ...st, to: v })}
              options={holderOptions(
                nodes.data,
                containers.data,
                st.toStatus === 'AVAILABLE' ? ['SHELF', 'BIN', 'LOCATION'] : ['QUARANTINE', 'INSPECTION', 'SHELF', 'BIN', 'LOCATION'],
              )}
            />
            <Field label="Motivo" value={st.reason} onChange={(v) => setSt({ ...st, reason: v })} required maxLength={500} />
            <div className="flex items-end gap-2">
              <Button type="submit" disabled={a.busy}>
                Confirmar
              </Button>
              <Button variant="secondary" onClick={() => setSt(emptyStatus)}>
                Cancelar
              </Button>
            </div>
          </Form>
        </Panel>
      )}
      <ErrorNotice error={a.error} />
      {a.message && <Notice kind="ok">{a.message}</Notice>}
    </Page>
  );
}
