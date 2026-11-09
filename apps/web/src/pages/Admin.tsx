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
                  <Button
                    small
                    variant="secondary"
                    onClick={() =>
                      void a.run(async () => {
                        const r = await withStepUp(() => api<{ mfaResetToken: string }>('POST', `/api/admin/users/${u.id}/mfa-reset`));
                        setSecretOut({ label: 'Ligação de reposição MFA', value: link('convite', r.mfaResetToken) });
                        users.reload();
                      })
                    }
                  >
                    Repor MFA
                  </Button>
                  <Button
                    small
                    variant="secondary"
                    onClick={() =>
                      void a.run(async () => {
                        const r = await withStepUp(() =>
                          api<{ passwordResetToken: string }>('POST', `/api/admin/users/${u.id}/password-reset`),
                        );
                        setSecretOut({
                          label: 'Ligação de redefinição de palavra-passe (60 min)',
                          value: link('redefinir', r.passwordResetToken),
                        });
                      })
                    }
                  >
                    Repor palavra-passe
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
