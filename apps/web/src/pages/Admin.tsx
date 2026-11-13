/**
 * @file Secure administrator area: warehouses, users/permissions, MFA & password resets,
 * PII access, key rotation, and the security audit log with hash-chain verification.
 * @module web/pages
 */
import { useState } from 'react';
import { api, fmtDate } from '../api';
import { Button, ErrorNotice, Field, Form, Notice, Page, Panel, Pill, Select, Table, useAction, useLoad } from '../components/ui';
import { useSession } from '../session';
import type { Row } from '../wms-data';

const STAFF_PERMS = [
  'wms.view',
  'wms.receive',
  'wms.putaway',
  'wms.pick',
  'wms.pack',
  'wms.dispatch',
  'wms.transfer.dispatch',
  'wms.transfer.receive',
  'wms.returns',
  'wms.count',
  'wms.count.approve',
  'wms.adjust',
  'wms.replenish',
  'wms.topology.manage',
  'wms.sku.manage',
  'wms.outbound.manage',
  'wms.inbound.manage',
  'wms.report',
  'wms.export',
];

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  warehouseId: string | null;
  mfaEnrolled: boolean;
  hasPhone: boolean;
  permissions: string[];
}

/** Administration screen. */
export function AdminPage() {
  const { session, withStepUp } = useSession();
  const users = useLoad(() => api<UserRow[]>('GET', '/api/admin/users'), []);
  const whs = session!.warehouses;
  const [nu, setNu] = useState({ email: '', displayName: '', role: 'STAFF', warehouseId: '', phone: '' });
  const [perms, setPerms] = useState<string[]>(['wms.view']);
  const [secretOut, setSecretOut] = useState<{ label: string; value: string } | null>(null);
  const [nw, setNw] = useState({ code: '', name: '' });
  const [edit, setEdit] = useState<UserRow | null>(null);
  const a = useAction();
  const link = (kind: string, tok: string) => `${window.location.origin}/#/${kind}/${tok}`;
  // Account recovery needs a recorded identity check (ASVS 5.0 V6.4.4, ADR-0029).
  const [recovery, setRecovery] = useState<{ user: UserRow; kind: 'mfa' | 'password' } | null>(null);
  const [method, setMethod] = useState('IN_PERSON');
  const [reference, setReference] = useState('');
  const runRecovery = () =>
    void a.run(async () => {
      if (!recovery) return;
      const body = { method, reference };
      if (recovery.kind === 'mfa') {
        const r = await withStepUp(() => api<{ mfaResetToken: string }>('POST', `/api/admin/users/${recovery.user.id}/mfa-reset`, body));
        setSecretOut({ label: 'Ligação de reposição MFA', value: link('convite', r.mfaResetToken) });
        users.reload();
      } else {
        const r = await withStepUp(() =>
          api<{ passwordResetToken: string }>('POST', `/api/admin/users/${recovery.user.id}/password-reset`, body),
        );
        setSecretOut({ label: 'Ligação de redefinição de palavra-passe (60 min)', value: link('redefinir', r.passwordResetToken) });
      }
      setRecovery(null);
      setReference('');
    });
  return (
    <Page
      title="Administração"
      purpose="Utilizadores, permissões (por omissão nada é permitido), armazéns e segurança. Ações sensíveis pedem confirmação MFA e ficam auditadas."
    >
      {secretOut && (
        <Notice kind="info">
          <strong>{secretOut.label}</strong> — mostrado uma única vez; entregue por canal seguro:
          <div className="mt-1 break-all font-mono text-xs">{secretOut.value}</div>
          <Button small variant="ghost" onClick={() => setSecretOut(null)}>
            Ocultar
          </Button>
        </Notice>
      )}
      {recovery && (
        <Panel title={`${recovery.kind === 'mfa' ? 'Repor MFA' : 'Repor palavra-passe'} — ${recovery.user.displayName}`}>
          <Form onSubmit={runRecovery} className="flex flex-wrap items-end gap-3">
            <p className="w-full text-sm">
              Confirme primeiro a identidade da pessoa. A verificação fica registada na auditoria; não escreva dados pessoais.
            </p>
            <Select
              label="Como verificou a identidade"
              value={method}
              onChange={(v) => setMethod(v || 'IN_PERSON')}
              options={[
                { value: 'IN_PERSON', label: 'Presencialmente' },
                { value: 'VIDEO_CALL', label: 'Videochamada' },
                { value: 'KNOWN_PHONE_CALLBACK', label: 'Chamada de volta para o número da ficha' },
                { value: 'MANAGER_CONFIRMATION', label: 'Confirmação pelo responsável direto' },
              ]}
            />
            <Field label="Referência da verificação" value={reference} onChange={setReference} required />
            <Button type="submit">Confirmar</Button>
            <Button variant="ghost" onClick={() => setRecovery(null)}>
              Cancelar
            </Button>
          </Form>
        </Panel>
      )}
      <Panel title="Utilizadores">
        <Table<UserRow>
          rows={users.data ?? []}
          rowKey={(u) => u.id}
          cols={[
            { h: 'Nome', c: (u) => u.displayName },
            { h: 'E-mail', c: (u) => u.email },
            { h: 'Papel', c: (u) => (u.role === 'ADMIN' ? 'Administrador' : 'Funcionário') },
            { h: 'Armazém', c: (u) => whs.find((w) => w.id === u.warehouseId)?.code ?? (u.role === 'ADMIN' ? 'Todos' : '—') },
            {
              h: 'Estado',
              c: (u) => <Pill tone={u.status === 'ACTIVE' ? 'ok' : u.status === 'DISABLED' ? 'danger' : 'warn'}>{u.status}</Pill>,
            },
            { h: 'MFA', c: (u) => (u.mfaEnrolled ? 'Sim' : 'Não') },
            {
              h: 'Ações',
              c: (u) => (
                <span className="flex flex-wrap gap-1">
                  {u.role === 'STAFF' && (
                    <Button small variant="secondary" onClick={() => (setEdit(u), setPerms(u.permissions))}>
                      Permissões
                    </Button>
                  )}
                  <Button small variant="secondary" onClick={() => setRecovery({ user: u, kind: 'mfa' })}>
                    Repor MFA
                  </Button>
                  <Button small variant="secondary" onClick={() => setRecovery({ user: u, kind: 'password' })}>
                    Repor palavra-passe
                  </Button>
                  <Button
                    small
                    variant="secondary"
                    onClick={() =>
                      void a.run(async () => {
                        const r = await withStepUp(() => api<{ revoked: number }>('POST', `/api/admin/users/${u.id}/sessions/revoke`));
                        setSecretOut({ label: 'Sessões terminadas', value: String(r.revoked) });
                      })
                    }
                  >
                    Terminar sessões
                  </Button>
                  {u.hasPhone && (
                    <Button
                      small
                      variant="ghost"
                      onClick={() =>
                        void a.run(async () => {
                          const r = await withStepUp(() => api<{ phone: string }>('GET', `/api/admin/users/${u.id}/pii`));
                          setSecretOut({ label: `Telefone de ${u.displayName} (acesso auditado)`, value: r.phone });
                        })
                      }
                    >
                      Ver telefone
                    </Button>
                  )}
                  {u.status !== 'DISABLED' && u.id !== session!.user.id && (
                    <Button
                      small
                      variant="danger"
                      onClick={() =>
                        window.confirm(`Desativar ${u.displayName}?`) &&
                        void a.run(
                          async () => (await api('POST', `/api/admin/users/${u.id}/deactivate`), users.reload()),
                          'Utilizador desativado; sessões terminadas.',
                        )
                      }
                    >
                      Desativar
                    </Button>
                  )}
                </span>
              ),
            },
          ]}
        />
      </Panel>
      {edit && (
        <Panel title={`Permissões de ${edit.displayName}`}>
          <PermissionPicker value={perms} onChange={setPerms} />
          <div className="mt-2 flex gap-2">
            <Button
              onClick={() =>
                void a.run(
                  async () => (
                    await api('PUT', `/api/admin/users/${edit.id}/permissions`, { permissions: perms }),
                    setEdit(null),
                    users.reload()
                  ),
                  'Permissões atualizadas; sessões do utilizador terminadas.',
                )
              }
            >
              Guardar
            </Button>
            <Select
              label="Mudar armazém (MFA)"
              value=""
              onChange={(v) =>
                v &&
                void a.run(
                  async () => (
                    await withStepUp(() => api('PUT', `/api/admin/users/${edit.id}/warehouse`, { warehouseId: v })),
                    users.reload()
                  ),
                  'Armazém atribuído alterado.',
                )
              }
              options={whs.map((w) => ({ value: w.id, label: w.code }))}
            />
          </div>
        </Panel>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Convidar utilizador">
          <Form
            className="space-y-2"
            onSubmit={() =>
              void a.run(async () => {
                const body = {
                  email: nu.email,
                  displayName: nu.displayName,
                  role: nu.role,
                  ...(nu.role === 'STAFF' ? { warehouseId: nu.warehouseId, permissions: perms } : { permissions: [] }),
                  ...(nu.phone ? { phone: nu.phone } : {}),
                };
                const r = await withStepUp(() => api<{ invitationToken: string }>('POST', '/api/admin/users', body));
                setSecretOut({ label: `Ligação de convite para ${nu.email} (72 h)`, value: link('convite', r.invitationToken) });
                users.reload();
              })
            }
          >
            <Field label="E-mail" type="email" value={nu.email} onChange={(v) => setNu({ ...nu, email: v })} required />
            <Field label="Nome" value={nu.displayName} onChange={(v) => setNu({ ...nu, displayName: v })} required maxLength={80} />
            <Select
              label="Papel"
              value={nu.role}
              onChange={(v) => setNu({ ...nu, role: v })}
              options={[
                { value: 'STAFF', label: 'Funcionário (um armazém)' },
                { value: 'ADMIN', label: 'Administrador da empresa' },
              ]}
            />
            {nu.role === 'STAFF' && (
              <>
                <Select
                  label="Armazém"
                  value={nu.warehouseId}
                  onChange={(v) => setNu({ ...nu, warehouseId: v })}
                  options={whs.map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))}
                  required
                />
                <PermissionPicker value={perms} onChange={setPerms} />
              </>
            )}
            <Field label="Telefone (opcional, cifrado)" value={nu.phone} onChange={(v) => setNu({ ...nu, phone: v })} maxLength={20} />
            <Button type="submit">Convidar</Button>
          </Form>
        </Panel>
        <Panel title="Armazéns e chaves">
          <ul className="mb-3 text-sm">
            {whs.map((w) => (
              <li key={w.id}>
                <span className="font-mono">{w.code}</span> · {w.name}
              </li>
            ))}
          </ul>
          <Form
            className="flex items-end gap-2"
            onSubmit={() =>
              void a.run(async () => (await api('POST', '/api/admin/warehouses', nw), window.location.reload()), 'Armazém criado.')
            }
          >
            <Field label="Código" value={nw.code} onChange={(v) => setNw({ ...nw, code: v })} required maxLength={40} />
            <Field label="Nome" value={nw.name} onChange={(v) => setNw({ ...nw, name: v })} required maxLength={80} />
            <Button type="submit">Criar armazém</Button>
          </Form>
          <div className="mt-4">
            <Button
              variant="secondary"
              onClick={() =>
                window.confirm('Rodar a chave de cifra da empresa e recifrar os dados?') &&
                void a.run(async () => {
                  const r = await withStepUp(() => api<{ newVersion: number; reencrypted: number }>('POST', '/api/admin/keys/rotate'));
                  setSecretOut({ label: 'Rotação concluída', value: `Versão ${r.newVersion}; ${r.reencrypted} valores recifrados.` });
                })
              }
            >
              Rodar chave de cifra (MFA)
            </Button>
          </div>
        </Panel>
      </div>
      <ErrorNotice error={a.error ?? users.error} />
      {a.message && <Notice kind="ok">{a.message}</Notice>}
    </Page>
  );
}

function PermissionPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="grid grid-cols-2 gap-1 text-sm md:grid-cols-3">
      <legend className="mb-1 font-medium">Permissões</legend>
      {STAFF_PERMS.map((p) => (
        <label key={p} className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={value.includes(p)}
            onChange={(e) => onChange(e.target.checked ? [...value, p] : value.filter((x) => x !== p))}
          />
          <span className="font-mono text-xs">{p}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** Security audit log with chain verification. */
export function AuditPage() {
  const log = useLoad(() => api<Row[]>('GET', '/api/admin/audit?limit=300'), []);
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; brokenAtSeq?: string } | null>(null);
  const a = useAction();
  return (
    <Page
      title="Auditoria de segurança"
      purpose="Registo encadeado por hash (deteção de adulteração). Não contém palavras-passe, tokens nem dados pessoais completos."
      actions={
        <Button onClick={() => void a.run(async () => setVerify(await api('GET', '/api/admin/audit/verify')))}>Verificar cadeia</Button>
      }
    >
      {verify &&
        (verify.ok ? (
          <Notice kind="ok">Cadeia íntegra ({verify.checked} entradas verificadas).</Notice>
        ) : (
          <Notice kind="error">Cadeia quebrada na entrada {verify.brokenAtSeq}. Inicie o procedimento de incidente.</Notice>
        ))}
      <Panel>
        <Table
          rows={log.data ?? []}
          rowKey={(r) => r.seq!}
          cols={[
            { h: '#', c: (r) => r.seq, num: true },
            { h: 'Quando', c: (r) => fmtDate(r.occurredAt) },
            { h: 'Ação', c: (r) => <span className="font-mono text-xs">{r.action}</span> },
            { h: 'Resultado', c: (r) => <Pill tone={r.outcome === 'SUCCESS' ? 'ok' : 'danger'}>{r.outcome}</Pill> },
            { h: 'Quem', c: (r) => r.actor ?? '—' },
            { h: 'Recurso', c: (r) => `${r.resourceType ?? ''} ${r.resourceId ?? ''}` },
            { h: 'IP', c: (r) => r.clientIp ?? '—' },
            { h: 'Detalhes', c: (r) => <span className="font-mono text-xs">{JSON.stringify(r.details)}</span> },
          ]}
        />
      </Panel>
      <ErrorNotice error={a.error ?? log.error} />
    </Page>
  );
}

/** pt-PT labels for the security counters returned by /api/admin/security/overview. */
const COUNTER_LABELS: Record<string, string> = {
  loginSuccess: 'Entradas com sucesso',
  loginFailure: 'Entradas falhadas',
  mfaFailure: 'Códigos de verificação errados',
  recoveryCodeUsed: 'Códigos de recuperação usados',
  accessDenied: 'Acessos recusados',
  mfaReset: 'Reposições de autenticação',
  passwordChange: 'Alterações de palavra-passe',
  passkeyChange: 'Chaves de acesso adicionadas/removidas',
  piiRead: 'Consultas de dados pessoais',
  export: 'Exportações',
  keyRotation: 'Rotações de chaves',
  privilegeChange: 'Alterações de utilizadores/permissões',
  controlBypass: 'Pedidos rejeitados ou limitados (registos agregados)',
};

/** pt-PT descriptions of alert rules (rule id → text). Unknown ids are shown as-is. */
const RULE_LABELS: Record<string, string> = {
  'auth.login_failures': 'Muitas entradas falhadas',
  'auth.mfa_failures': 'Muitos códigos de verificação errados',
  'authz.denied_spike': 'Muitos acessos recusados',
  'auth.recovery_code_used': 'Código de recuperação usado',
  'auth.mfa_reset': 'Autenticação de um utilizador reposta',
  'admin.pii_read_burst': 'Muitas consultas de dados pessoais',
  'admin.key_rotation': 'Chaves de cifra rodadas',
  'wms.export_burst': 'Muitas exportações',
  'audit.chain_broken': 'Cadeia de auditoria quebrada — iniciar incidente',
  'system.outbox_stuck': 'Eventos por publicar há demasiado tempo',
  'security.probing': 'Muitos pedidos rejeitados ou limitados (sondagem)',
};

const SEVERITY_LABEL: Record<string, { text: string; tone: 'neutral' | 'warn' | 'danger' }> = {
  CRITICAL: { text: 'Crítico', tone: 'danger' },
  HIGH: { text: 'Alto', tone: 'danger' },
  MEDIUM: { text: 'Médio', tone: 'warn' },
  LOW: { text: 'Baixo', tone: 'neutral' },
};

interface SecurityOverview {
  windowMinutes: number;
  counters: Record<string, number>;
  openAlerts: Record<string, number>;
  auditChain: { verifiedSeq: string; verifiedAt: string; result: string; brokenAtSeq: string | null } | null;
  outbox: { pending: number; oldestPendingAt: string | null };
  monitor: { intervalSeconds: number; channels: string[] };
}

/** Security monitoring for administrators: counters, alerts and acknowledgement (ADR-0026). */
export function SecurityPage() {
  const { withStepUp } = useSession();
  const [windowMinutes, setWindowMinutes] = useState('60');
  const [status, setStatus] = useState('OPEN');
  const overview = useLoad(
    () => api<SecurityOverview>('GET', `/api/admin/security/overview?windowMinutes=${windowMinutes}`),
    [windowMinutes],
  );
  const alerts = useLoad(() => api<Row[]>('GET', `/api/admin/security/alerts?status=${status}`), [status]);
  const a = useAction();
  const o = overview.data;
  return (
    <Page
      title="Segurança"
      purpose="Alertas e contadores de segurança calculados a partir do registo de auditoria. Não substitui a monitorização da infraestrutura."
    >
      <div className="flex flex-wrap gap-4">
        <Select
          label="Período"
          value={windowMinutes}
          onChange={(v) => setWindowMinutes(v || '60')}
          options={[
            { value: '60', label: 'Última hora' },
            { value: '1440', label: 'Últimas 24 horas' },
            { value: '10080', label: 'Últimos 7 dias' },
          ]}
        />
        <Select
          label="Alertas"
          value={status}
          onChange={(v) => setStatus(v || 'OPEN')}
          options={[
            { value: 'OPEN', label: 'Por ver' },
            { value: 'ACKNOWLEDGED', label: 'Vistos' },
            { value: 'ALL', label: 'Todos' },
          ]}
        />
      </div>
      {o && (
        <>
          {o.auditChain?.result === 'BROKEN' && (
            <Notice kind="error">
              Cadeia de auditoria quebrada na entrada {o.auditChain.brokenAtSeq}. Inicie o procedimento de incidente.
            </Notice>
          )}
          <Panel title="Estado">
            <ul className="grid gap-1 text-sm sm:grid-cols-2">
              <li>
                Alertas por ver: <strong>{Object.values(o.openAlerts).reduce((s, n) => s + n, 0)}</strong> (críticos {o.openAlerts.CRITICAL}
                , altos {o.openAlerts.HIGH})
              </li>
              <li>
                Cadeia de auditoria:{' '}
                {o.auditChain
                  ? `${o.auditChain.result === 'OK' ? 'íntegra' : 'QUEBRADA'} até à entrada ${o.auditChain.verifiedSeq} (${fmtDate(o.auditChain.verifiedAt)})`
                  : 'ainda não verificada pelo monitor'}
              </li>
              <li>
                Eventos por publicar: {o.outbox.pending}
                {o.outbox.oldestPendingAt ? ` (mais antigo ${fmtDate(o.outbox.oldestPendingAt)})` : ''}
              </li>
              <li>
                Monitor: a cada {Math.round(o.monitor.intervalSeconds / 60)} min · canais {o.monitor.channels.join(', ')}
              </li>
            </ul>
          </Panel>
          <Panel title="Contadores do período">
            <Table
              rows={Object.entries(o.counters).map(([key, n]) => ({ key, n }))}
              rowKey={(r) => r.key}
              cols={[
                { h: 'Evento', c: (r) => COUNTER_LABELS[r.key] ?? r.key },
                { h: 'Total', c: (r) => r.n, num: true },
              ]}
            />
          </Panel>
        </>
      )}
      <Panel title="Resposta a incidentes">
        <p className="mb-2 text-sm">
          Termina todas as sessões da empresa exceto a sua. Todos terão de voltar a entrar com o segundo fator.
        </p>
        <Button
          variant="danger"
          onClick={() =>
            void a.run(async () => {
              const r = await withStepUp(() => api<{ revoked: number }>('POST', '/api/admin/sessions/revoke-all'));
              overview.reload();
              return r;
            }, 'Todas as outras sessões foram terminadas.')
          }
        >
          Terminar todas as sessões
        </Button>
      </Panel>
      <Panel title="Alertas">
        <Table
          rows={alerts.data ?? []}
          rowKey={(r) => r.id!}
          cols={[
            {
              h: 'Gravidade',
              c: (r) => (
                <Pill tone={SEVERITY_LABEL[r.severity!]?.tone ?? 'neutral'}>{SEVERITY_LABEL[r.severity!]?.text ?? r.severity}</Pill>
              ),
            },
            { h: 'Alerta', c: (r) => RULE_LABELS[r.rule!] ?? r.rule },
            { h: 'Ocorrências', c: (r) => r.occurrences, num: true },
            { h: 'Primeiro', c: (r) => fmtDate(r.firstSeenAt) },
            { h: 'Último', c: (r) => fmtDate(r.lastSeenAt) },
            {
              h: 'Estado',
              c: (r) =>
                r.status === 'OPEN' ? (
                  <Button
                    onClick={() =>
                      void a.run(async () => {
                        await withStepUp(() => api('POST', `/api/admin/security/alerts/${r.id}/ack`, {}));
                        alerts.reload();
                        overview.reload();
                      }, 'Alerta marcado como visto.')
                    }
                  >
                    Marcar como visto
                  </Button>
                ) : (
                  `Visto por ${r.acknowledgedBy ?? '—'} (${fmtDate(r.acknowledgedAt)})`
                ),
            },
          ]}
        />
      </Panel>
      <ErrorNotice error={a.error ?? overview.error ?? alerts.error} />
      {a.message && <Notice kind="ok">{a.message}</Notice>}
    </Page>
  );
}
