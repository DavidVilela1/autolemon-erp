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
  const { activeWh, can } = useSession();
  const wh = activeWh!.id;
  const [skuId, setSkuId] = useState<string>();
  const summary = useLoad(() => api<Row[]>('GET', `${wp(wh)}/stock/summary`), [wh]);
  const positions = useLoad(() => loadPositions(wh, skuId), [wh, skuId]);
  const nodes = useLoad(() => loadNodes(wh), [wh]);
  const containers = useLoad(() => loadContainers(wh), [wh]);
  const [move, setMove] = useState({ positionId: '', qty: '', to: '', reason: '' });
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
              ...(can('wms.putaway')
                ? [
                    {
                      h: 'Ação',
                      c: (r: Row) => (
                        <Button small variant="secondary" onClick={() => setMove({ ...move, positionId: r.id! })}>
                          Mover
                        </Button>
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
            className="grid grid-cols-1 gap-3 md:grid-cols-4"
            onSubmit={() =>
              void a.run(async () => {
                await api('POST', `${wp(wh)}/stock/move`, {
                  positionId: move.positionId,
                  qty: move.qty,
                  to: holderRef(move.to),
                  ...(move.reason ? { reason: move.reason } : {}),
                });
                setMove({ positionId: '', qty: '', to: '', reason: '' });
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
            <div className="flex items-end gap-2">
              <Button type="submit" disabled={a.busy}>
                Mover
              </Button>
              <Button variant="secondary" onClick={() => setMove({ positionId: '', qty: '', to: '', reason: '' })}>
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
