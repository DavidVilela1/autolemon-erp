/**
 * @file Receiving (WMS-native inbound documents, scanner receipt, shortages) and putaway.
 * @module web/pages
 */
import { useState } from 'react';
import { api, fmtDate, fmtQty, newIdempotencyKey } from '../api';
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
import { holderOptions, holderRef, loadContainers, loadNodes, loadSkus, nodeOptions, type Row, wp } from '../wms-data';

interface InboundDoc {
  id: string;
  number: string;
  kind: string;
  status: string;
  lines: Row[];
}

/** Receiving screen. */
export function InboundPage() {
  const { activeWh, can } = useSession();
  const wh = activeWh!.id;
  const list = useLoad(() => api<Row[]>('GET', `${wp(wh)}/inbound`), [wh]);
  const nodes = useLoad(() => loadNodes(wh), [wh]);
  const skus = useLoad(() => loadSkus(), []);
  const [openId, setOpenId] = useState<string>();
  const doc = useLoad(() => (openId ? api<InboundDoc>('GET', `${wp(wh)}/inbound/${openId}`) : Promise.resolve(undefined)), [wh, openId]);
  const [nl, setNl] = useState({ skuId: '', qty: '', externalRef: '' });
  const [rx, setRx] = useState({ staging: '', damaged: '', qty: '1', condition: 'GOOD' });
  const a = useAction();
  const refresh = () => (list.reload(), doc.reload());
  return (
    <Page
      title="Receção"
      purpose="Entradas previstas ou não planeadas, sem necessidade de encomenda de compra. Faltas, excessos e danos ficam registados."
      steps={['Crie/abra a entrada', 'Leia os códigos', 'Feche para registar faltas']}
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Entradas" className="lg:col-span-1">
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
                    <Button variant="ghost" small onClick={() => setOpenId(r.id!)}>
                      {r.number}
                    </Button>
                  ),
                },
                { h: 'Estado', c: (r) => <Pill tone={r.status === 'CLOSED' ? 'ok' : 'warn'}>{r.status}</Pill> },
                { h: 'Rec./Prev.', c: (r) => `${fmtQty(r.qtyReceived)} / ${fmtQty(r.qtyExpected)}`, num: true },
                { h: 'Data', c: (r) => fmtDate(r.createdAt) },
              ]}
            />
          )}
          {can('wms.inbound.manage') && (
            <Form
              className="mt-3 space-y-2"
              onSubmit={() =>
                void a.run(async () => {
                  const r = await api<{ id: string }>(
                    'POST',
                    `${wp(wh)}/inbound`,
                    nl.skuId
                      ? {
                          kind: 'EXPECTED',
                          ...(nl.externalRef ? { externalRef: nl.externalRef } : {}),
                          lines: [{ skuId: nl.skuId, qtyExpected: nl.qty }],
                        }
                      : { kind: 'UNPLANNED', ...(nl.externalRef ? { externalRef: nl.externalRef } : {}) },
                  );
                  if (nl.skuId) await api('POST', `${wp(wh)}/inbound/${r.id}/release`);
                  setOpenId(r.id);
                  list.reload();
                }, 'Entrada criada.')
              }
            >
              <h3 className="font-semibold">Nova entrada</h3>
              <Select
                label="Artigo previsto (vazio = não planeada)"
                value={nl.skuId}
                onChange={(v) => setNl({ ...nl, skuId: v })}
                options={(skus.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.description}` }))}
              />
              {nl.skuId && (
                <Field label="Quantidade prevista" value={nl.qty} onChange={(v) => setNl({ ...nl, qty: v })} required inputMode="decimal" />
              )}
              <Field
                label="Referência externa (guia do fornecedor)"
                value={nl.externalRef}
                onChange={(v) => setNl({ ...nl, externalRef: v })}
                maxLength={80}
              />
              <Button type="submit" disabled={a.busy}>
                Criar
              </Button>
            </Form>
          )}
        </Panel>
        <Panel title={doc.data ? `Entrada ${doc.data.number} (${doc.data.status})` : 'Selecione uma entrada'} className="lg:col-span-2">
          {doc.data && (
            <>
              <Table
                rows={doc.data.lines}
                rowKey={(r) => r.id!}
                cols={[
                  { h: 'Artigo', c: (r) => r.skuCode },
                  { h: 'Previsto', c: (r) => fmtQty(r.qtyExpected), num: true },
                  { h: 'Recebido', c: (r) => fmtQty(r.qtyReceived), num: true },
                  { h: 'Danificado', c: (r) => fmtQty(r.qtyDamaged), num: true },
                  { h: 'Falta', c: (r) => fmtQty(r.qtyShort), num: true },
                  { h: 'Excesso', c: (r) => fmtQty(r.qtyExcess), num: true },
                ]}
              />
              {['OPEN', 'RECEIVING'].includes(doc.data.status) && can('wms.receive') && (
                <div className="mt-4 grid gap-3 md:grid-cols-4">
                  <Select
                    label="Cais de receção"
                    value={rx.staging}
                    onChange={(v) => setRx({ ...rx, staging: v })}
                    options={nodeOptions(nodes.data, ['STAGING'])}
                    required
                  />
                  <Select
                    label="Zona p/ danificados"
                    value={rx.damaged}
                    onChange={(v) => setRx({ ...rx, damaged: v })}
                    options={nodeOptions(nodes.data, ['QUARANTINE', 'INSPECTION'])}
                  />
                  <Field label="Quantidade por leitura" value={rx.qty} onChange={(v) => setRx({ ...rx, qty: v })} inputMode="decimal" />
                  <Select
                    label="Condição"
                    value={rx.condition}
                    onChange={(v) => setRx({ ...rx, condition: v })}
                    options={[
                      { value: 'GOOD', label: 'Boa' },
                      { value: 'DAMAGED', label: 'Danificado' },
                    ]}
                  />
                  <div className="md:col-span-4">
                    <ScanInput
                      label="Ler código de barras do artigo"
                      onScan={(barcode) =>
                        void a.run(async () => {
                          await api('POST', `${wp(wh)}/inbound/${doc.data!.id}/receive`, {
                            stagingNodeId: rx.staging,
                            ...(rx.damaged ? { damagedNodeId: rx.damaged } : {}),
                            lines: [{ barcode, qty: rx.qty, condition: rx.condition }],
                          });
                          refresh();
                        }, `Recebido ${rx.qty} × ${barcode}.`)
                      }
                    />
                  </div>
                  <div className="md:col-span-4">
                    <Button
                      variant="secondary"
                      onClick={() =>
                        void a.run(
                          async () => (await api('POST', `${wp(wh)}/inbound/${doc.data!.id}/close`), refresh()),
                          'Entrada fechada; faltas/excessos registados.',
                        )
                      }
                    >
                      Fechar receção
                    </Button>
                  </div>
                </div>
              )}
              {doc.data.status === 'DRAFT' && (
                <Button onClick={() => void a.run(async () => (await api('POST', `${wp(wh)}/inbound/${doc.data!.id}/release`), refresh()))}>
                  Libertar para receção
                </Button>
              )}
            </>
          )}
        </Panel>
      </div>
      <ErrorNotice error={a.error ?? list.error} />
      {a.message && <Notice kind="ok">{a.message}</Notice>}
    </Page>
  );
}

/** Putaway screen. */
export function PutawayPage() {
  const { activeWh } = useSession();
  const wh = activeWh!.id;
  const tasks = useLoad(() => api<Row[]>('GET', `${wp(wh)}/putaway`), [wh]);
  const nodes = useLoad(() => loadNodes(wh), [wh]);
  const boxes = useLoad(() => loadContainers(wh), [wh]);
  const [task, setTask] = useState<Row>();
  const sug = useLoad(
    () => (task ? api<Row[]>('GET', `${wp(wh)}/putaway/${task.id}/suggestions`) : Promise.resolve([] as Row[])),
    [wh, task?.id],
  );
  const [f, setF] = useState({ to: '', qty: '', scan: '' });
  const [key, setKey] = useState(newIdempotencyKey());
  const a = useAction();
  return (
    <Page
      title="Arrumação"
      purpose="Mover stock recebido do cais para localizações, compartimentos ou caixas. Arrumação parcial permitida."
      steps={['Escolha a tarefa', 'Siga a sugestão ou escolha destino', 'Confirme a quantidade']}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Tarefas pendentes">
          <Table
            rows={tasks.data ?? []}
            rowKey={(r) => r.id!}
            cols={[
              { h: 'Artigo', c: (r) => r.skuCode },
              { h: 'Cais', c: (r) => r.stagingPath },
              { h: 'Pendente', c: (r) => fmtQty(r.qtyRemaining), num: true },
              {
                h: '',
                c: (r) => (
                  <Button small onClick={() => (setTask(r), setF({ to: '', qty: r.qtyRemaining!, scan: '' }), setKey(newIdempotencyKey()))}>
                    Arrumar
                  </Button>
                ),
              },
            ]}
            empty="Sem tarefas de arrumação."
          />
        </Panel>
        {task && (
          <Panel title={`Arrumar ${task.skuCode}`}>
            <h3 className="text-sm font-semibold">Sugestões</h3>
            <ul className="mb-3 text-sm">
              {(sug.data ?? []).map((s) => (
                <li key={`${s.nodeId}${s.containerId}`}>
                  <Button small variant="ghost" onClick={() => setF({ ...f, to: s.containerId ? `c:${s.containerId}` : `n:${s.nodeId}` })}>
                    {s.reason === 'CONSOLIDATE' ? 'Consolidar em' : 'Vazio:'} {s.path}
                    {s.containerCode ? ` / ${s.containerCode}` : ''} ({fmtQty(s.currentQty)})
                  </Button>
                </li>
              ))}
            </ul>
            <Form
              className="grid grid-cols-2 gap-2"
              onSubmit={() =>
                void a.run(async () => {
                  await api(
                    'POST',
                    `${wp(wh)}/putaway/${task.id}/complete`,
                    { qty: f.qty, to: holderRef(f.to), scan: f.scan },
                    { idempotencyKey: key },
                  );
                  setTask(undefined);
                  tasks.reload();
                }, 'Arrumação registada.')
              }
            >
              <Select
                label="Destino"
                value={f.to}
                onChange={(v) => setF({ ...f, to: v })}
                options={holderOptions(nodes.data, boxes.data)}
                required
              />
              <Field label="Quantidade" value={f.qty} onChange={(v) => setF({ ...f, qty: v })} required inputMode="decimal" />
              <Field
                label="Ler etiqueta do destino"
                value={f.scan}
                onChange={(v) => setF({ ...f, scan: v })}
                required
                autoComplete="off"
                maxLength={64}
              />
              <Button type="submit" disabled={a.busy}>
                Confirmar
              </Button>
            </Form>
          </Panel>
        )}
      </div>
      <ErrorNotice error={a.error ?? tasks.error} />
      {a.message && <Notice kind="ok">{a.message}</Notice>}
    </Page>
  );
}
