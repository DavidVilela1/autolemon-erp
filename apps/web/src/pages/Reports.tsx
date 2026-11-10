/**
 * @file Activity history with audited corrections (reversal, adjustment) and reports/exports.
 * @module web/pages
 */
import { useState } from 'react';
import { api, fmtDate, fmtQty } from '../api';
import { Button, ErrorNotice, Field, Form, Notice, Page, Panel, Select, Table, useAction, useLoad } from '../components/ui';
import { useSession } from '../session';
import { loadPositions, type Row, STATUS_PT, wp } from '../wms-data';

const REVERSIBLE = ['OPENING', 'MOVE', 'ADJUST', 'REPLENISH', 'CONTAINER_MOVE'];

/** Activity history + corrections. */
export function CorrectionsPage() {
  const { activeWh, can, withStepUp } = useSession();
  const wh = activeWh!.id;
  const [type, setType] = useState('');
  const ledger = useLoad(() => api<Row[]>('GET', `${wp(wh)}/reports/ledger${type ? `?type=${type}` : ''}`), [wh, type]);
  const positions = useLoad(() => loadPositions(wh), [wh]);
  const [adj, setAdj] = useState({ positionId: '', qtyDelta: '', reasonCode: 'DAMAGE', note: '' });
  const a = useAction();
  return (
    <Page
      title="Histórico e correções"
      purpose="Histórico imutável de movimentos. Erros corrigem-se com movimentos compensatórios auditados — nunca apagando histórico."
      steps={['Encontre o movimento', 'Reverta ou ajuste com motivo']}
    >
      <Panel title="Movimentos">
        <Select
          label="Filtrar tipo"
          value={type}
          onChange={setType}
          options={[
            'OPENING',
            'RECEIPT',
            'PUTAWAY',
            'MOVE',
            'CONTAINER_MOVE',
            'PICK',
            'PACK',
            'DISPATCH',
            'TRANSFER_OUT',
            'TRANSFER_IN',
            'RETURN_RECEIPT',
            'RETURN_DISPOSITION',
            'COUNT_ADJUST',
            'ADJUST',
            'REPLENISH',
            'REVERSAL',
            'STATUS_CHANGE',
            'UNPICK',
            'UNPACK',
          ].map((t) => ({ value: t, label: t }))}
        />
        <Table
          rows={ledger.data ?? []}
          rowKey={(r) => r.id!}
          cols={[
            { h: 'Quando', c: (r) => fmtDate(r.at) },
            { h: 'Tipo', c: (r) => r.type },
            { h: 'Artigo', c: (r) => r.skuCode },
            { h: 'Local', c: (r) => `${r.nodePath ?? ''}${r.containerCode ? ` / ${r.containerCode}` : ''}` },
            { h: 'Estado', c: (r) => STATUS_PT[r.status!] ?? r.status },
            { h: 'Δ', c: (r) => fmtQty(r.delta), num: true },
            { h: 'Quem', c: (r) => r.actor },
            {
              h: '',
              c: (r) =>
                can('wms.adjust') && REVERSIBLE.includes(r.type!) && !r.reversalOf ? (
                  <Button
                    small
                    variant="secondary"
                    onClick={() => {
                      const reason = window.prompt('Motivo da reversão (obrigatório):');
                      if (reason)
                        void a.run(
                          async () => (
                            await withStepUp(() => api('POST', `${wp(wh)}/transactions/${r.txnId}/reverse`, { reason })),
                            ledger.reload()
                          ),
                          'Reversão registada.',
                        );
                    }}
                  >
                    Reverter
                  </Button>
                ) : null,
            },
          ]}
        />
      </Panel>
      {can('wms.adjust') && (
        <Panel title="Ajuste auditado (requer confirmação MFA)">
          <Form
            className="grid gap-2 md:grid-cols-4"
            onSubmit={() =>
              void a.run(
                async () => (await withStepUp(() => api('POST', `${wp(wh)}/stock/adjust`, adj)), ledger.reload(), positions.reload()),
                'Ajuste registado e auditado.',
              )
            }
          >
            <Select
              label="Posição"
              value={adj.positionId}
              onChange={(v) => setAdj({ ...adj, positionId: v })}
              options={(positions.data ?? []).map((p) => ({
                value: p.id!,
                label: `${p.skuCode} @ ${p.nodePath}${p.containerCode ? ` / ${p.containerCode}` : ''} (${fmtQty(p.onHand)})`,
              }))}
              required
            />
            <Field label="Variação (ex.: -1)" value={adj.qtyDelta} onChange={(v) => setAdj({ ...adj, qtyDelta: v })} required />
            <Select
              label="Motivo"
              value={adj.reasonCode}
              onChange={(v) => setAdj({ ...adj, reasonCode: v })}
              options={[
                { value: 'DAMAGE', label: 'Dano' },
                { value: 'LOSS', label: 'Perda' },
                { value: 'FOUND', label: 'Encontrado' },
                { value: 'DATA_ERROR', label: 'Erro de registo' },
                { value: 'OTHER', label: 'Outro' },
              ]}
            />
            <Field label="Nota" value={adj.note} onChange={(v) => setAdj({ ...adj, note: v })} required />
            <Button type="submit">Registar ajuste</Button>
          </Form>
        </Panel>
      )}
      <ErrorNotice error={a.error ?? ledger.error} />
      {a.message && <Notice kind="ok">{a.message}</Notice>}
    </Page>
  );
}

/** Reports and exports. */
export function ReportsPage() {
  const { activeWh, can, withStepUp } = useSession();
  const wh = activeWh!.id;
  const disc = useLoad(() => api<{ inbound: Row[]; counts: Row[] }>('GET', `${wp(wh)}/reports/discrepancies`), [wh]);
  const transit = useLoad(() => api<Row[]>('GET', '/api/wms/reports/in-transit'), []);
  const rec = useLoad(() => api<{ ledgerMismatches: Row[]; reservationMismatches: Row[] }>('GET', `${wp(wh)}/stock/reconciliation`), [wh]);
  const a = useAction();
  return (
    <Page title="Relatórios" purpose="Discrepâncias, mercadoria em trânsito, reconciliação do razão e exportação autorizada.">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Reconciliação razão ↔ saldos">
          {rec.data && rec.data.ledgerMismatches.length === 0 && rec.data.reservationMismatches.length === 0 ? (
            <Notice kind="ok">Saldos e reservas coincidem com o razão de movimentos.</Notice>
          ) : (
            rec.data && (
              <Notice kind="error">
                Foram encontradas {rec.data.ledgerMismatches.length + rec.data.reservationMismatches.length} divergências. Contacte o
                administrador.
              </Notice>
            )
          )}
        </Panel>
        <Panel title="Exportação CSV de stock">
          {can('wms.export') ? (
            <Button
              onClick={() =>
                void a.run(async () => {
                  const csv = await withStepUp(() => api<string>('GET', `${wp(wh)}/reports/stock.csv`, undefined, { asText: true }));
                  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = `stock-${activeWh!.code}.csv`;
                  link.click();
                  URL.revokeObjectURL(url);
                }, 'Exportação gerada (registada na auditoria).')
              }
            >
              Exportar (requer MFA)
            </Button>
          ) : (
            <p className="text-sm text-ink-soft">Sem permissão de exportação.</p>
          )}
        </Panel>
        <Panel title="Faltas, excessos e danos na receção">
          <Table
            rows={disc.data?.inbound ?? []}
            rowKey={(r) => `${r.number}${r.skuCode}`}
            cols={[
              { h: 'Entrada', c: (r) => r.number },
              { h: 'Artigo', c: (r) => r.skuCode },
              { h: 'Prev.', c: (r) => fmtQty(r.expected), num: true },
              { h: 'Rec.', c: (r) => fmtQty(r.received), num: true },
              { h: 'Falta', c: (r) => fmtQty(r.short), num: true },
              { h: 'Excesso', c: (r) => fmtQty(r.excess), num: true },
              { h: 'Dano', c: (r) => fmtQty(r.damaged), num: true },
            ]}
          />
        </Panel>
        <Panel title="Diferenças de contagem">
          <Table
            rows={disc.data?.counts ?? []}
            rowKey={(r) => `${r.number}${r.skuCode}${r.delta}`}
            cols={[
              { h: 'Contagem', c: (r) => r.number },
              { h: 'Artigo', c: (r) => r.skuCode },
              { h: 'Esperado', c: (r) => fmtQty(r.expected), num: true },
              { h: 'Contado', c: (r) => fmtQty(r.counted), num: true },
              { h: 'Δ', c: (r) => fmtQty(r.delta), num: true },
              { h: 'Estado', c: (r) => r.state },
            ]}
          />
        </Panel>
        <Panel title="Em trânsito">
          <Table
            rows={transit.data ?? []}
            rowKey={(r) => `${r.number}${r.skuCode}`}
            cols={[
              { h: 'Transf.', c: (r) => r.number },
              { h: 'Rota', c: (r) => `${r.source} → ${r.dest}` },
              { h: 'Artigo', c: (r) => r.skuCode },
              { h: 'Qtd', c: (r) => fmtQty(r.qtyInTransit), num: true },
            ]}
            empty="Nada em trânsito."
          />
        </Panel>
      </div>
      <ErrorNotice error={a.error ?? disc.error} />
      {a.message && <Notice kind="ok">{a.message}</Notice>}
    </Page>
  );
}
