/**
 * @file Stock items (SKU master): search, create, validated CSV import and printable labels.
 * @module web/pages
 */
import { useState } from 'react';
import { api } from '../api';
import { Barcode } from '../components/Barcode';
import { Button, ErrorNotice, Field, Form, Loading, Notice, Page, Panel, Table, useAction, useLoad } from '../components/ui';
import { useSession } from '../session';
import { loadContainers, loadNodes, loadSkus, type SkuRow } from '../wms-data';

/** SKU master screen. */
export function SkusPage() {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const skus = useLoad(() => loadSkus(q), [q]);
  const [f, setF] = useState({ code: '', description: '', brand: '', barcode: '' });
  const a = useAction();
  const [csvName, setCsvName] = useState('');
  return (
    <Page
      title="Artigos"
      purpose="Ficha de artigo da empresa (independente de catálogos automóveis). Códigos de barras para leitura em armazém."
      steps={['Pesquise', 'Crie ou importe CSV', 'Imprima etiquetas']}
    >
      <Panel>
        <Field label="Pesquisar código ou descrição" value={q} onChange={setQ} maxLength={60} />
        {skus.loading ? (
          <Loading />
        ) : (
          <Table<SkuRow>
            rows={skus.data ?? []}
            rowKey={(r) => r.id}
            cols={[
              { h: 'Código', c: (r) => <span className="font-mono">{r.code}</span> },
              { h: 'Descrição', c: (r) => r.description },
              { h: 'Marca', c: (r) => r.brand ?? '—' },
              { h: 'Unid.', c: (r) => r.baseUom },
              { h: 'Códigos de barras', c: (r) => r.barcodes.map((b) => b.barcode).join(', ') || '—' },
            ]}
          />
        )}
        <ErrorNotice error={skus.error} />
      </Panel>
      {can('wms.sku.manage') && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Novo artigo">
            <Form
              className="grid grid-cols-2 gap-2"
              onSubmit={() =>
                void a.run(async () => {
                  await api('POST', '/api/wms/skus', {
                    code: f.code,
                    description: f.description,
                    ...(f.brand ? { brand: f.brand } : {}),
                    barcodes: f.barcode ? [{ barcode: f.barcode, uom: 'UN', qtyPerUom: 1 }] : [],
                  });
                  setF({ code: '', description: '', brand: '', barcode: '' });
                  skus.reload();
                }, 'Artigo criado.')
              }
            >
              <Field label="Código" value={f.code} onChange={(v) => setF({ ...f, code: v })} required maxLength={40} />
              <Field label="Código de barras (EAN)" value={f.barcode} onChange={(v) => setF({ ...f, barcode: v })} maxLength={64} />
              <Field label="Descrição" value={f.description} onChange={(v) => setF({ ...f, description: v })} required />
              <Field label="Marca" value={f.brand} onChange={(v) => setF({ ...f, brand: v })} maxLength={80} />
              <div className="col-span-2">
                <Button type="submit" disabled={a.busy}>
                  Criar
                </Button>
              </div>
            </Form>
          </Panel>
          <Panel title="Importar CSV">
            <p className="mb-2 text-sm text-ink-soft">
              Colunas: code, description, base_uom, brand, manufacturer_ref, barcode. Máx. 1 MB / 2000 linhas. Tudo ou nada: uma linha
              inválida rejeita o ficheiro.
            </p>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Ficheiro .csv</span>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setCsvName(file.name);
                  if (file.size > 1_000_000) {
                    void a.run(async () => Promise.reject(new Error('Ficheiro demasiado grande')));
                    return;
                  }
                  void file.text().then((text) =>
                    a.run(async () => {
                      const r = await api<{ imported: number }>('POST', '/api/wms/skus/import', undefined, { text });
                      skus.reload();
                      return r;
                    }, `Importação concluída (${file.name}).`),
                  );
                }}
              />
            </label>
            {csvName && <p className="mt-1 text-xs text-ink-soft">Último ficheiro: {csvName}</p>}
          </Panel>
        </div>
      )}
      <ErrorNotice error={a.error} />
      {a.message && <Notice kind="ok">{a.message}</Notice>}
    </Page>
  );
}

/** Printable labels for SKUs, locations and boxes. */
export function LabelsPage() {
  const { activeWh } = useSession();
  const wh = activeWh!.id;
  const skus = useLoad(() => loadSkus(), []);
  const nodes = useLoad(() => loadNodes(wh), [wh]);
  const boxes = useLoad(() => loadContainers(wh), [wh]);
  const [kind, setKind] = useState<'sku' | 'node' | 'box'>('node');
  const items =
    kind === 'sku'
      ? (skus.data ?? []).map((s) => ({ id: s.id, value: s.barcodes[0]?.barcode ?? s.code, caption: `${s.code} · ${s.description}` }))
      : kind === 'node'
        ? (nodes.data ?? []).filter((n) => n.holdsStock).map((n) => ({ id: n.id, value: n.code, caption: n.name }))
        : (boxes.data ?? [])
            .filter((b) => b.kind !== 'PACKAGE')
            .map((b) => ({ id: b.id, value: b.code, caption: `Caixa @ ${b.nodePath}` }));
  return (
    <Page
      title="Etiquetas"
      purpose="Etiquetas Code 128 imprimíveis para artigos, localizações e caixas."
      actions={<Button onClick={() => window.print()}>Imprimir</Button>}
    >
      <div className="no-print flex gap-2">
        <Button variant={kind === 'node' ? 'primary' : 'secondary'} onClick={() => setKind('node')}>
          Localizações
        </Button>
        <Button variant={kind === 'box' ? 'primary' : 'secondary'} onClick={() => setKind('box')}>
          Caixas
        </Button>
        <Button variant={kind === 'sku' ? 'primary' : 'secondary'} onClick={() => setKind('sku')}>
          Artigos
        </Button>
      </div>
      <div className="flex flex-wrap gap-3">
        {items.map((i) => (
          <Barcode key={i.id} value={i.value} caption={i.caption} />
        ))}
      </div>
    </Page>
  );
}
