/**
 * @file "A minha conta": self-service account security — passkeys (WebAuthn), password change,
 * own sessions and recovery-code regeneration. Every sensitive action is re-checked by the API
 * (step-up, ownership, policy); this screen only drives the flows.
 * @module web/pages
 */
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { useState } from 'react';
import { api, fmtDate } from '../api';
import { Button, ErrorNotice, Field, Form, Loading, Notice, Page, Panel, Pill, Table, useAction, useLoad } from '../components/ui';
import { useSession } from '../session';

interface PasskeyRow {
  id: string;
  name: string;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface SessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  clientIp: string | null;
  userAgent: string | null;
  current: boolean;
}

function Passkeys({ enforced }: { enforced: boolean }) {
  const { withStepUp, reload: reloadSession, session } = useSession();
  const list = useLoad(() => api<PasskeyRow[]>('GET', '/api/auth/passkeys'), []);
  const [name, setName] = useState('');
  const a = useAction();
  const supported = browserSupportsWebAuthn();
  const policy = session?.security.adminPasskeyPolicy && session.user.role === 'ADMIN';

  const register = () =>
    void a.run(async () => {
      await withStepUp(async () => {
        const optionsJSON = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>(
          'POST',
          '/api/auth/passkeys/register/options',
        );
        const response = await startRegistration({ optionsJSON });
        await api('POST', '/api/auth/passkeys/register', { response, name: name.trim() || 'Chave de acesso' });
      });
      setName('');
      list.reload();
      await reloadSession();
    }, 'Chave de acesso registada.');

  const revoke = (id: string) =>
    void a.run(async () => {
      await withStepUp(() => api('POST', `/api/auth/passkeys/${id}/revoke`));
      list.reload();
      await reloadSession();
    }, 'Chave de acesso removida.');

  return (
    <Panel title="Chaves de acesso (passkeys)">
      <p className="mb-3 text-sm text-ink-soft">
        Uma chave de acesso usa o desbloqueio do dispositivo (impressão digital, rosto, PIN ou chave física). Resiste a phishing porque só
        funciona neste endereço.
        {policy && ' Para administradores, a chave de acesso é obrigatória.'}
      </p>
      {enforced && <Notice kind="info">Registe uma chave de acesso para continuar. Até lá, as restantes áreas estão bloqueadas.</Notice>}
      {!supported && <Notice kind="error">Este navegador não suporta chaves de acesso.</Notice>}
      {list.loading ? (
        <Loading />
      ) : (
        <Table
          rows={list.data ?? []}
          rowKey={(r) => r.id}
          empty="Ainda não tem chaves de acesso."
          cols={[
            { h: 'Nome', c: (r) => r.name },
            {
              h: 'Tipo',
              c: (r) => (r.deviceType === 'multiDevice' ? <Pill tone="ok">Sincronizada</Pill> : <Pill>Neste dispositivo</Pill>),
            },
            { h: 'Criada', c: (r) => fmtDate(r.createdAt) },
            { h: 'Última utilização', c: (r) => (r.lastUsedAt ? fmtDate(r.lastUsedAt) : '—') },
            {
              h: 'Ações',
              c: (r) => (
                <Button small variant="danger" onClick={() => revoke(r.id)} disabled={a.busy}>
                  Remover
                </Button>
              ),
            },
          ]}
        />
      )}
      <ErrorNotice error={list.error} />
      <Form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={register}>
        <Field label="Nome da nova chave" value={name} onChange={setName} maxLength={60} placeholder="p. ex. Portátil do armazém" />
        <Button type="submit" disabled={a.busy || !supported}>
          Registar chave de acesso
        </Button>
      </Form>
      <ErrorNotice error={a.error} />
      {a.message && <Notice kind="ok">{a.message}</Notice>}
    </Panel>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const a = useAction();
  return (
    <Panel title="Alterar palavra-passe">
      <Form
        className="space-y-3"
        onSubmit={() =>
          void a.run(async () => {
            const r = await api<{ otherSessionsRevoked: number }>('POST', '/api/auth/password/change', {
              currentPassword: current,
              newPassword: next,
            });
            setCurrent('');
            setNext('');
            return r;
          }, 'Palavra-passe alterada. As outras sessões foram terminadas.')
        }
      >
        <Field
          label="Palavra-passe atual"
          type="password"
          value={current}
          onChange={setCurrent}
          required
          autoComplete="current-password"
          maxLength={128}
        />
        <Field
          label="Nova palavra-passe (mínimo 12 caracteres)"
          type="password"
          value={next}
          onChange={setNext}
          required
          autoComplete="new-password"
          maxLength={128}
        />
        <ErrorNotice error={a.error} />
        {a.message && <Notice kind="ok">{a.message}</Notice>}
        <Button type="submit" disabled={a.busy}>
          Alterar palavra-passe
        </Button>
      </Form>
    </Panel>
  );
}

function Sessions() {
  const { withStepUp } = useSession();
  const list = useLoad(() => api<SessionRow[]>('GET', '/api/auth/sessions'), []);
  const a = useAction();
  return (
    <Panel title="Sessões ativas">
      {list.loading ? (
        <Loading />
      ) : (
        <Table
          rows={list.data ?? []}
          rowKey={(r) => r.id}
          cols={[
            { h: 'Início', c: (r) => fmtDate(r.createdAt) },
            { h: 'Última atividade', c: (r) => fmtDate(r.lastSeenAt) },
            { h: 'Origem', c: (r) => r.clientIp ?? '—' },
            { h: 'Navegador', c: (r) => <span className="line-clamp-1 max-w-xs break-all text-xs">{r.userAgent ?? '—'}</span> },
            {
              h: 'Ações',
              c: (r) =>
                r.current ? (
                  <Pill tone="ok">Esta sessão</Pill>
                ) : (
                  <Button
                    small
                    variant="secondary"
                    disabled={a.busy}
                    onClick={() =>
                      void a.run(
                        async () => (await withStepUp(() => api('POST', `/api/auth/sessions/${r.id}/revoke`)), list.reload()),
                        'Sessão terminada.',
                      )
                    }
                  >
                    Terminar
                  </Button>
                ),
            },
          ]}
        />
      )}
      <div className="mt-3">
        <Button
          variant="secondary"
          disabled={a.busy}
          onClick={() =>
            void a.run(
              async () => (await withStepUp(() => api('POST', '/api/auth/sessions/revoke-others')), list.reload()),
              'Outras sessões terminadas.',
            )
          }
        >
          Terminar todas as outras sessões
        </Button>
      </div>
      <ErrorNotice error={list.error ?? a.error} />
      {a.message && <Notice kind="ok">{a.message}</Notice>}
    </Panel>
  );
}

function RecoveryCodes() {
  const { withStepUp } = useSession();
  const [codes, setCodes] = useState<string[] | null>(null);
  const a = useAction();
  return (
    <Panel title="Códigos de recuperação">
      <p className="mb-3 text-sm text-ink-soft">
        Gerar novos códigos invalida imediatamente todos os anteriores. Os novos só são mostrados uma vez.
      </p>
      {codes && (
        <>
          <Notice kind="ok">Guarde estes códigos num local seguro.</Notice>
          <ul aria-label="Novos códigos de recuperação" className="my-3 grid grid-cols-2 gap-1 font-mono">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      )}
      <Button
        variant="secondary"
        disabled={a.busy}
        onClick={() =>
          void a.run(async () =>
            setCodes(
              (await withStepUp(() => api<{ recoveryCodes: string[] }>('POST', '/api/auth/recovery-codes/regenerate'))).recoveryCodes,
            ),
          )
        }
      >
        Gerar novos códigos
      </Button>
      <ErrorNotice error={a.error} />
    </Panel>
  );
}

/** Account security page; `enforced` when the admin passkey policy blocks everything else. */
export function AccountPage({ enforced = false }: { enforced?: boolean }) {
  const { logout } = useSession();
  return (
    <Page
      title="A minha conta"
      purpose="Gerir a forma como entra no sistema: chaves de acesso, palavra-passe, sessões e códigos de recuperação."
      actions={
        enforced ? (
          <Button variant="secondary" onClick={() => void logout()}>
            Sair
          </Button>
        ) : undefined
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Passkeys enforced={enforced} />
        {!enforced && <ChangePassword />}
        {!enforced && <Sessions />}
        {!enforced && <RecoveryCodes />}
      </div>
    </Page>
  );
}
