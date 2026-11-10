/**
 * @file Warehouse structure editor (fixed nodes) and movable containers (create, move, history).
 * @module web/pages
 */
import { useState } from 'react';
import { api, fmtDate, fmtQty } from '../api';
import { Button, ErrorNotice, Field, Form, Loading, Notice, Page, Panel, Select, Table, useAction, useLoad } from '../components/ui';
import { useSession } from '../session';
import { type ContainerRow, loadContainers, loadNodes, nodeOptions, type Row, wp } from '../wms-data';

const KINDS = ['ZONE', 'AISLE', 'RACK', 'SHELF', 'BIN', 'LOCATION', 'STAGING', 'INSPECTION', 'QUARANTINE', 'DISPATCH'];
const KIND_PT: Record<string, string> = {
  ZONE: 'Zona',
  AISLE: 'Corredor',
  RACK: 'Estante',
  SHELF: 'Prateleira',
  BIN: 'Compartimento',
  LOCATION: 'Local direto',
  STAGING: 'Cais de receção',
  INSPECTION: 'Inspeção',
  QUARANTINE: 'Quarentena',
  DISPATCH: 'Expedição',
};

/** Structure screen. */
export function StructurePage() {
  const { activeWh, can } = useSession();
  const wh = activeWh!.id;
  const nodes = useLoad(() => loadNodes(wh), [wh]);
  const containers = useLoad(() => loadContainers(wh), [wh]);
  const [n, setN] = useState({ parentId: '', kind: '', code: '', name: '' });
  const [c, setC] = useState({ code: '', kind: 'BOX', nodeId: '' });
  const [mv, setMv] = useState<{ id: string; to: string; scan: string } | null>(null);
  const [hist, setHist] = useState<{ code: string; rows: Row[] } | null>(null);
  const [edit, setEdit] = useState<{ id: string; code: string; name: string } | null>(null);
  const setActive = (id: string, active: boolean) =>
    void a.run(
      async () => {
        await api('POST', `${wp(wh)}/nodes/${id}`, { active });
        nodes.reload();
      },
      active ? 'Localização reativada.' : 'Localização desativada (incluindo as que estão abaixo).',
    );
  const a = useAction();
  const manage = can('wms.topology.manage');
  return (
    <Page
      title="Estrutura do armazém"
      purpose="Zonas, corredores, estantes, prateleiras, compartimentos e áreas operacionais; caixas móveis e o seu histórico."
      steps={['Crie a hierarquia fixa', 'Crie caixas numa localização', 'Mova caixas inteiras quando necessário']}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Localizações fixas">
          {nodes.loading ? (
            <Loading />
          ) : (
            <ul className="max-h-[28rem] overflow-auto text-sm" tabIndex={0} aria-label="Localizações fixas">
              {(nodes.data ?? []).map((x) => (
                <li
                  key={x.id}
                  className={`flex items-center justify-between gap-2 border-b border-line py-1 ${x.active ? '' : 'text-ink-soft'}`}
                  style={{ paddingLeft: `${x.depth * 1.25}rem` }}
                >
                  <span>
                    <span className={`font-mono ${x.active ? '' : 'line-through'}`}>{x.code}</span> · {x.name}{' '}
                    <span className="text-ink-soft">
                      ({KIND_PT[x.kind]}
                      {x.holdsStock ? ', guarda stock' : ''}
                      {x.active ? '' : ', inativa'})
                    </span>
                  </span>
                  {manage && (
                    <span className="flex shrink-0 gap-1">
                      <Button small variant="ghost" onClick={() => setEdit({ id: x.id, code: x.code, name: x.name })}>
                        Renomear
                      </Button>
                      <Button small variant="ghost" onClick={() => setActive(x.id, !x.active)}>
                        {x.active ? 'Desativar' : 'Reativar'}
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {edit && (
            <Form
              className="mt-3 flex items-end gap-2"
              onSubmit={() =>
                void a.run(async () => {
                  await api('POST', `${wp(wh)}/nodes/${edit.id}`, { name: edit.name });
                  setEdit(null);
                  nodes.reload();
                }, 'Nome alterado.')
              }
            >
              <Field
                label={`Novo nome de ${edit.code}`}
                value={edit.name}
                onChange={(v) => setEdit({ ...edit, name: v })}
                required
                maxLength={80}
              />
              <Button type="submit">Guardar</Button>
              <Button variant="secondary" onClick={() => setEdit(null)}>
                Cancelar
              </Button>
            </Form>
          )}
          {manage && (
            <Form
              className="mt-3 grid grid-cols-2 gap-2"
              onSubmit={() =>
                void a.run(async () => {
                  await api('POST', `${wp(wh)}/nodes`, {
                    kind: n.kind,
                    code: n.code,
                    name: n.name,
                    ...(n.parentId ? { parentId: n.parentId } : {}),
                  });
                  setN({ ...n, code: '', name: '' });
                  nodes.reload();
                }, 'Localização criada.')
              }
            >
              <Select
                label="Tipo"
                value={n.kind}
                onChange={(v) => setN({ ...n, kind: v })}
                options={KINDS.map((k) => ({ value: k, label: KIND_PT[k]! }))}
                required
              />
              <Select
                label="Dentro de"
                value={n.parentId}
                onChange={(v) => setN({ ...n, parentId: v })}
                options={(nodes.data ?? []).filter((x) => x.active).map((x) => ({ value: x.id, label: x.path }))}
              />
              <Field label="Código" value={n.code} onChange={(v) => setN({ ...n, code: v })} required maxLength={40} />
              <Field label="Nome" value={n.name} onChange={(v) => setN({ ...n, name: v })} required maxLength={80} />
              <div className="col-span-2">
                <Button type="submit" disabled={a.busy}>
                  Criar localização
                </Button>
              </div>
            </Form>
          )}
        </Panel>
        <Panel title="Caixas móveis">
          <Table<ContainerRow>
            rows={(containers.data ?? []).filter((x) => x.kind !== 'PACKAGE')}
            rowKey={(r) => r.id}
            cols={[
              { h: 'Código', c: (r) => <span className="font-mono">{r.code}</span> },
              { h: 'Localização', c: (r) => r.nodePath },
              { h: 'Unid.', c: (r) => fmtQty(r.qtyTotal), num: true },
              {
                h: 'Ações',
                c: (r) => (
                  <span className="flex gap-1">
                    {can('wms.putaway') && r.status === 'ACTIVE' && (
                      <Button small variant="secondary" onClick={() => setMv({ id: r.id, to: '', scan: '' })}>
                        Mover
                      </Button>
                    )}
                    {manage && r.status === 'ACTIVE' && Number(r.qtyTotal) === 0 && (
                      <Button
                        small
                        variant="secondary"
                        onClick={() =>
                          void a.run(async () => {
                            await api('POST', `${wp(wh)}/containers/${r.id}/close`);
                            containers.reload();
                          }, 'Caixa fechada.')
                        }
                      >
                        Fechar
                      </Button>
                    )}
                    {r.status !== 'ACTIVE' && <span className="text-xs text-ink-soft">Fechada</span>}
                    <Button
                      small
                      variant="ghost"
                      onClick={() =>
                        void api<Row[]>('GET', `${wp(wh)}/containers/${r.id}/history`).then((rows) => setHist({ code: r.code, rows }))
                      }
                    >
                      Histórico
                    </Button>
                  </span>
                ),
              },
            ]}
          />
          {mv && (
            <Form
              className="mt-3 flex items-end gap-2"
              onSubmit={() =>
                void a.run(async () => {
                  await api('POST', `${wp(wh)}/containers/${mv.id}/move`, { toNodeId: mv.to, scan: mv.scan });
                  setMv(null);
                  containers.reload();
                }, 'Caixa movida (conteúdo inalterado).')
              }
            >
              <Select
                label="Nova localização"
                value={mv.to}
                onChange={(v) => setMv({ ...mv, to: v })}
                options={nodeOptions(nodes.data)}
                required
              />
              <Field label="Ler etiqueta do destino" value={mv.scan} onChange={(v) => setMv({ ...mv, scan: v })} required maxLength={64} />
              <Button type="submit">Confirmar</Button>
              <Button variant="secondary" onClick={() => setMv(null)}>
                Cancelar
              </Button>
            </Form>
          )}
          {manage && (
            <Form
              className="mt-3 grid grid-cols-3 gap-2"
              onSubmit={() =>
                void a.run(async () => {
                  await api('POST', `${wp(wh)}/containers`, c);
                  setC({ ...c, code: '' });
                  containers.reload();
                }, 'Caixa criada.')
              }
            >
              <Field label="Código da caixa" value={c.code} onChange={(v) => setC({ ...c, code: v })} required maxLength={40} />
              <Select
                label="Tipo"
                value={c.kind}
                onChange={(v) => setC({ ...c, kind: v })}
                options={[
                  { value: 'BOX', label: 'Caixa' },
                  { value: 'TOTE', label: 'Contentor' },
                  { value: 'PALLET', label: 'Palete' },
                ]}
              />
              <Select
                label="Localização"
                value={c.nodeId}
                onChange={(v) => setC({ ...c, nodeId: v })}
                options={nodeOptions(nodes.data)}
                required
              />
              <div className="col-span-3">
                <Button type="submit">Criar caixa</Button>
              </div>
            </Form>
          )}
          {hist && (
            <div className="mt-3">
              <h3 className="font-semibold">Histórico de {hist.code}</h3>
              <Table
                rows={hist.rows}
                rowKey={(r) => r.txnId!}
                cols={[
                  { h: 'Quando', c: (r) => fmtDate(r.movedAt) },
                  { h: 'De', c: (r) => r.from },
                  { h: 'Para', c: (r) => r.to },
                  { h: 'Quem', c: (r) => r.actor },
                  { h: 'Motivo', c: (r) => r.reason ?? '—' },
                ]}
              />
            </div>
          )}
        </Panel>
      </div>
      <ErrorNotice error={a.error ?? nodes.error ?? containers.error} />
      {a.message && <Notice kind="ok">{a.message}</Notice>}
    </Page>
  );
}
