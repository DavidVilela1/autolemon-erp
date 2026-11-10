/**
 * @file "Pesquisa": cross-document search inside the active warehouse — document numbers and
 * external references, SKUs (code, description, barcode), locations and containers.
 * Owning module: web / WMS. The API scopes results to the warehouse and escapes wildcards.
 * @module web/pages
 */
import { useState } from 'react';
import { api } from '../api';
import { Button, ErrorNotice, Field, Form, Notice, Page, Panel, Pill, Table, useAction } from '../components/ui';
import { useSession } from '../session';
import { wp } from '../wms-data';

interface Hit {
  kind: 'inbound' | 'outbound' | 'transfer' | 'return' | 'count' | 'sku' | 'location' | 'container';
  id: string;
  label: string;
  detail: string | null;
  status: string | null;
}

/** pt-PT name of each result kind and the screen where it is handled. */
const KIND: Record<Hit['kind'], { pt: string; href: string }> = {
  inbound: { pt: 'Entrada', href: '#/rececao' },
  outbound: { pt: 'Saída', href: '#/saidas' },
  transfer: { pt: 'Transferência', href: '#/transferencias' },
  return: { pt: 'Devolução', href: '#/devolucoes' },
  count: { pt: 'Contagem', href: '#/contagens' },
  sku: { pt: 'Artigo', href: '#/artigos' },
  location: { pt: 'Localização', href: '#/estrutura' },
  container: { pt: 'Caixa', href: '#/estrutura' },
};

/** Search page. */
export function SearchPage() {
  const { activeWh } = useSession();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const a = useAction();
  return (
    <Page
      title="Pesquisa"
      purpose="Encontrar qualquer documento, artigo, localização ou caixa deste armazém por número, referência externa, código ou código de barras."
      steps={['Escreva ou leia um código', 'Abra o ecrã indicado']}
    >
      <Panel title="Pesquisar">
        <Form
          className="flex flex-wrap items-end gap-2"
          onSubmit={() =>
            void a.run(async () => {
              const r = await api<{ hits: Hit[] }>('GET', `${wp(activeWh!.id)}/search?q=${encodeURIComponent(q.trim())}`);
              setHits(r.hits);
            })
          }
        >
          <Field label="Texto, número ou código de barras" value={q} onChange={setQ} required maxLength={64} autoComplete="off" />
          <Button type="submit" disabled={a.busy}>
            Pesquisar
          </Button>
        </Form>
        <ErrorNotice error={a.error} />
      </Panel>
      {hits && (
        <Panel title={`Resultados (${hits.length})`}>
          {hits.length === 0 ? (
            <Notice kind="info">Nada encontrado neste armazém.</Notice>
          ) : (
            <Table
              rows={hits}
              rowKey={(h) => `${h.kind}:${h.id}`}
              cols={[
                { h: 'Tipo', c: (h) => <Pill>{KIND[h.kind].pt}</Pill> },
                { h: 'Identificação', c: (h) => <span className="font-mono">{h.label}</span> },
                { h: 'Detalhe', c: (h) => h.detail ?? '—' },
                { h: 'Estado', c: (h) => h.status ?? '—' },
                {
                  h: 'Abrir',
                  c: (h) => (
                    <a className="text-teal underline" href={KIND[h.kind].href}>
                      Ir para {KIND[h.kind].pt.toLowerCase()}
                    </a>
                  ),
                },
              ]}
            />
          )}
        </Panel>
      )}
    </Page>
  );
}
