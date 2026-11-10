/**
 * @file Login (password + MFA), invitation/MFA-reset enrolment and password reset screens.
 * @module web/pages
 */
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';
import { api, ApiError, setCsrf } from '../api';
import { Button, ErrorNotice, Field, Form, Notice, Panel, useAction } from '../components/ui';
import { useSession } from '../session';

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto mt-16 max-w-md px-4">
      <p className="mb-2 text-sm font-semibold tracking-wide text-teal">
        Auto<span className="rounded bg-lemon px-1 text-ink">Lemon</span> ERP · Armazém
      </p>
      <Panel title={title}>{children}</Panel>
      <p className="mt-3 text-xs text-ink-soft">Acesso restrito. Todas as ações são registadas.</p>
    </main>
  );
}

/** Two-step login: password, then a passkey, TOTP or recovery code. */
export function LoginPage() {
  const { reload } = useSession();
  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const a = useAction();
  const passkeySupported = browserSupportsWebAuthn();
  const finish = async (csrfToken: string) => {
    setCsrf(csrfToken);
    await reload();
    window.location.hash = '#/';
  };
  const usePasskey = () =>
    void a.run(async () => {
      const optionsJSON = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>('POST', '/api/auth/mfa/passkey/options');
      const response = await startAuthentication({ optionsJSON });
      await finish((await api<{ csrfToken: string }>('POST', '/api/auth/mfa/passkey/verify', { response })).csrfToken);
    });
  const passkeyRequired = a.error instanceof ApiError && a.error.code === 'PASSKEY_REQUIRED';
  return (
    <Shell title={step === 'password' ? 'Entrar' : 'Verificação em dois passos'}>
      {step === 'password' ? (
        <Form
          className="space-y-3"
          onSubmit={() =>
            void a.run(async () => {
              const r = await api<{ csrfToken: string }>('POST', '/api/auth/login', { email, password });
              setCsrf(r.csrfToken);
              setPassword('');
              setStep('mfa');
            })
          }
        >
          <Field label="E-mail" type="email" value={email} onChange={setEmail} required autoFocus autoComplete="username" />
          <Field
            label="Palavra-passe"
            type="password"
            value={password}
            onChange={setPassword}
            required
            autoComplete="current-password"
            maxLength={128}
          />
          <ErrorNotice error={a.error} />
          <Button type="submit" disabled={a.busy}>
            Continuar
          </Button>
        </Form>
      ) : (
        <Form
          className="space-y-3"
          onSubmit={() =>
            void a.run(async () =>
              finish(
                (await api<{ csrfToken: string }>('POST', '/api/auth/mfa/verify', useRecovery ? { recoveryCode: code } : { code }))
                  .csrfToken,
              ),
            )
          }
        >
          {passkeySupported && (
            <div className="space-y-2 border-b border-line pb-3">
              <Button onClick={usePasskey} disabled={a.busy}>
                Usar chave de acesso
              </Button>
              {passkeyRequired && <p className="text-sm text-ink-soft">A sua conta de administrador exige a chave de acesso registada.</p>}
              <p className="text-xs text-ink-soft">Ou introduza um código:</p>
            </div>
          )}
          <Field
            label={useRecovery ? 'Código de recuperação' : 'Código da aplicação autenticadora (6 dígitos)'}
            value={code}
            onChange={setCode}
            required
            autoFocus
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            maxLength={useRecovery ? 19 : 6}
          />
          <ErrorNotice error={a.error} />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={a.busy}>
              Verificar
            </Button>
            <Button variant="ghost" onClick={() => (setUseRecovery(!useRecovery), setCode(''))}>
              {useRecovery ? 'Usar código da aplicação' : 'Usar código de recuperação'}
            </Button>
          </div>
        </Form>
      )}
    </Shell>
  );
}

/**
 * Invitation or MFA reset: the token arrives in the URL fragment and is removed from the
 * address bar/history immediately.
 */
export function EnrollmentPage({ token: initial }: { token: string }) {
  const [token] = useState(initial);
  useEffect(() => {
    history.replaceState(null, '', '#/convite');
  }, []);
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const a = useAction();
  if (codes) {
    return (
      <Shell title="Conta ativada">
        <Notice kind="ok">
          Autenticação em dois passos ativa. Guarde estes códigos de recuperação num local seguro — cada um só funciona uma vez e não
          voltarão a ser mostrados.
        </Notice>
        <ul className="my-3 grid grid-cols-2 gap-1 font-mono">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <Button onClick={() => (window.location.hash = '#/entrar')}>Ir para o início de sessão</Button>
      </Shell>
    );
  }
  return (
    <Shell title="Ativar conta">
      {!secret ? (
        <Form
          className="space-y-3"
          onSubmit={() => void a.run(async () => setSecret(await api('POST', '/api/auth/enrollment/start', { token, password })))}
        >
          <p className="text-sm text-ink-soft">
            Defina uma palavra-passe longa (mínimo 12 caracteres). Frases são bem-vindas; não há regras de símbolos.
          </p>
          <Field
            label="Palavra-passe (ou a atual, se for reposição de MFA)"
            type="password"
            value={password}
            onChange={setPassword}
            required
            autoFocus
            autoComplete="new-password"
            maxLength={128}
          />
          <ErrorNotice error={a.error} />
          <Button type="submit" disabled={a.busy}>
            Continuar
          </Button>
        </Form>
      ) : (
        <Form
          className="space-y-3"
          onSubmit={() =>
            void a.run(async () =>
              setCodes((await api<{ recoveryCodes: string[] }>('POST', '/api/auth/enrollment/confirm', { token, code })).recoveryCodes),
            )
          }
        >
          <p className="text-sm">Adicione esta conta à sua aplicação autenticadora (introduza a chave manualmente):</p>
          <p className="break-all rounded bg-paper p-2 font-mono text-sm" aria-label="Chave secreta TOTP">
            {secret.secret}
          </p>
          <p className="text-xs text-ink-soft">Tipo: baseado no tempo (TOTP), 6 dígitos, 30 segundos.</p>
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
          <ErrorNotice error={a.error} />
          <Button type="submit" disabled={a.busy}>
            Confirmar
          </Button>
        </Form>
      )}
    </Shell>
  );
}

/** Administrator-issued password reset. */
export function ResetPasswordPage({ token: initial }: { token: string }) {
  const [token] = useState(initial);
  useEffect(() => {
    history.replaceState(null, '', '#/redefinir');
  }, []);
  const [password, setPassword] = useState('');
  const a = useAction();
  return (
    <Shell title="Redefinir palavra-passe">
      <Form
        className="space-y-3"
        onSubmit={() =>
          void a.run(
            () => api('POST', '/api/auth/password/reset', { token, password }),
            'Palavra-passe alterada. Todas as sessões foram terminadas.',
          )
        }
      >
        <Field
          label="Nova palavra-passe"
          type="password"
          value={password}
          onChange={setPassword}
          required
          autoFocus
          autoComplete="new-password"
          maxLength={128}
        />
        <ErrorNotice error={a.error} />
        {a.message && <Notice kind="ok">{a.message}</Notice>}
        <Button type="submit" disabled={a.busy}>
          Guardar
        </Button>
      </Form>
    </Shell>
  );
}
