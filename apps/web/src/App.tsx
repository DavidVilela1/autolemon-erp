/**
 * @file Application shell: hash router, navigation (permission-aware), warehouse selector for
 * admins, and the step-up MFA dialog.
 * @module web
 *
 * Hiding navigation items is a usability aid only — the API enforces every permission and
 * warehouse scope server-side.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { Button, Field, Form } from './components/ui';
import { AdminPage, AuditPage } from './pages/Admin';
import { EnrollmentPage, LoginPage, ResetPasswordPage } from './pages/Auth';
import { InboundPage, PutawayPage } from './pages/Inbound';
import { CountsPage, ReplenishmentPage, ReturnsPage, TransfersPage } from './pages/Operations';
import { OutboundPage } from './pages/Outbound';
import { CorrectionsPage, ReportsPage } from './pages/Reports';
import { LabelsPage, SkusPage } from './pages/Skus';
import { StockPage } from './pages/Stock';
import { StructurePage } from './pages/Structure';
import { useSession } from './session';

interface RouteDef {
  path: string;
  label: string;
  perm?: string;
  admin?: boolean;
  render: () => ReactNode;
}

const ROUTES: RouteDef[] = [
  { path: '/', label: 'Stock', perm: 'wms.view', render: () => <StockPage /> },
  { path: '/rececao', label: 'Receção', perm: 'wms.receive', render: () => <InboundPage /> },
  { path: '/arrumacao', label: 'Arrumação', perm: 'wms.putaway', render: () => <PutawayPage /> },
  { path: '/saidas', label: 'Saídas', perm: 'wms.pick', render: () => <OutboundPage /> },
  { path: '/transferencias', label: 'Transferências', perm: 'wms.view', render: () => <TransfersPage /> },
  { path: '/devolucoes', label: 'Devoluções', perm: 'wms.returns', render: () => <ReturnsPage /> },
  { path: '/contagens', label: 'Contagens', perm: 'wms.count', render: () => <CountsPage /> },
  { path: '/reposicao', label: 'Reposição', perm: 'wms.replenish', render: () => <ReplenishmentPage /> },
  { path: '/historico', label: 'Histórico', perm: 'wms.report', render: () => <CorrectionsPage /> },
  { path: '/relatorios', label: 'Relatórios', perm: 'wms.report', render: () => <ReportsPage /> },
  { path: '/artigos', label: 'Artigos', perm: 'wms.view', render: () => <SkusPage /> },
  { path: '/estrutura', label: 'Estrutura', perm: 'wms.view', render: () => <StructurePage /> },
  { path: '/etiquetas', label: 'Etiquetas', perm: 'wms.view', render: () => <LabelsPage /> },
  { path: '/admin', label: 'Administração', admin: true, render: () => <AdminPage /> },
  { path: '/auditoria', label: 'Auditoria', perm: 'admin.audit.read', render: () => <AuditPage /> },
];

function useHashPath(): string {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.slice(1) || '/';
}

function StepUpDialog() {
  const { stepUpPrompt } = useSession();
  const [code, setCode] = useState('');
  if (!stepUpPrompt) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="stepup-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50"
    >
      <div className="w-full max-w-sm rounded-md bg-surface p-5 shadow-lg">
        <h2 id="stepup-title" className="mb-2 text-lg font-semibold">
          Confirmar identidade
        </h2>
        <p className="mb-3 text-sm text-ink-soft">Esta ação é sensível. Introduza o código atual da aplicação autenticadora.</p>
        <Form
          className="space-y-3"
          onSubmit={() => {
            stepUpPrompt.resolve(code);
            setCode('');
          }}
        >
          <Field
            label="Código de 6 dígitos"
            value={code}
            onChange={setCode}
            required
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
          />
          <div className="flex gap-2">
            <Button type="submit">Confirmar</Button>
            <Button variant="secondary" onClick={() => (stepUpPrompt.resolve(null), setCode(''))}>
              Cancelar
            </Button>
          </div>
        </Form>
      </div>
    </div>
  );
}

/** Root component. */
export function App() {
  const path = useHashPath();
  const { session, loading, activeWh, setActiveWh, can, logout } = useSession();
  const invite = /^\/convite\/([A-Za-z0-9_-]{43})$/.exec(path);
  if (invite) return <EnrollmentPage token={invite[1]!} />;
  const reset = /^\/redefinir\/([A-Za-z0-9_-]{43})$/.exec(path);
  if (reset) return <ResetPasswordPage token={reset[1]!} />;
  if (loading) return <p className="m-8 text-ink-soft">A carregar…</p>;
  if (!session) return <LoginPage />;
  const isAdmin = session.user.role === 'ADMIN';
  const visible = ROUTES.filter((r) => (r.admin ? isAdmin : !r.perm || can(r.perm)));
  const route = visible.find((r) => r.path === path) ?? visible[0];
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only">
        Saltar para o conteúdo
      </a>
      <header className="no-print flex flex-wrap items-center justify-between gap-3 bg-ink px-4 py-2 text-white">
        <span className="font-semibold">
          Auto<span className="rounded bg-lemon px-1 text-ink">Lemon</span> · Armazém
        </span>
        <div className="flex items-center gap-3 text-sm">
          {isAdmin ? (
            <label className="flex items-center gap-2">
              <span>Armazém</span>
              <select
                className="rounded bg-white px-2 py-1 text-ink"
                value={activeWh?.id ?? ''}
                onChange={(e) => void setActiveWh(e.target.value)}
              >
                {session.warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} · {w.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span>Armazém: {activeWh?.code}</span>
          )}
          <span aria-label="Utilizador">{session.user.displayName}</span>
          <button className="rounded border border-white/40 px-2 py-1 hover:bg-white/10" onClick={() => void logout()}>
            Sair
          </button>
        </div>
      </header>
      <div className="flex">
        <nav aria-label="Principal" className="no-print w-48 shrink-0 border-r border-line bg-surface p-2">
          <ul className="space-y-0.5">
            {visible.map((r) => (
              <li key={r.path}>
                <a
                  href={`#${r.path}`}
                  aria-current={route?.path === r.path ? 'page' : undefined}
                  className={`block rounded px-2 py-1.5 text-sm ${route?.path === r.path ? 'bg-teal-soft font-semibold text-teal-dark' : 'hover:bg-paper'}`}
                >
                  {r.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" className="min-w-0 flex-1 p-5">
          {activeWh ? route?.render() : <p>Sem armazém atribuído. Contacte o administrador.</p>}
        </main>
      </div>
      <StepUpDialog />
    </div>
  );
}
