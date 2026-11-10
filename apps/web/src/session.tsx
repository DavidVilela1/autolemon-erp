/**
 * @file Session context: current user, permissions, visible warehouses, active warehouse and
 * the step-up MFA flow shared by all screens.
 * @module web
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { api, ApiError, setCsrf } from './api';

/** Warehouse visible to the user. */
export interface Warehouse {
  id: string;
  code: string;
  name: string;
}

/** Session payload from /api/auth/session. */
export interface SessionInfo {
  user: { id: string; displayName: string; role: 'ADMIN' | 'STAFF'; warehouseId: string | null; permissions: string[] };
  warehouses: Warehouse[];
  csrfToken: string;
  security: { passkeys: number; mustRegisterPasskey: boolean; adminPasskeyPolicy: boolean };
}

/** Answer to a step-up prompt: a TOTP code, a passkey ceremony, or cancel (null). */
export type StepUpAnswer = { kind: 'totp'; code: string } | { kind: 'passkey' } | null;

/** Runs the passkey (WebAuthn) step-up ceremony against the API. */
export async function passkeyStepUp(): Promise<void> {
  const optionsJSON = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>('POST', '/api/auth/step-up/passkey/options');
  const response = await startAuthentication({ optionsJSON });
  await api('POST', '/api/auth/step-up/passkey', { response });
}

interface Ctx {
  session: SessionInfo | null;
  loading: boolean;
  activeWh: Warehouse | null;
  setActiveWh: (id: string) => Promise<void>;
  can: (perm: string) => boolean;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
  /** Runs an action; when the API demands step-up MFA, asks for a code and retries once. */
  withStepUp: <T>(fn: () => Promise<T>) => Promise<T>;
  stepUpPrompt: { resolve: (answer: StepUpAnswer) => void; passkeys: number; totpAllowed: boolean } | null;
}

const SessionContext = createContext<Ctx | null>(null);

/** Provides the session to the component tree. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stepUpPrompt, setStepUpPrompt] = useState<Ctx['stepUpPrompt']>(null);

  // `loading` is only true for the initial fetch: a background refresh must not unmount the
  // screen (which would drop its local state, e.g. a success message or new recovery codes).
  const reload = useCallback(async () => {
    try {
      const s = await api<SessionInfo>('GET', '/api/auth/session');
      setCsrf(s.csrfToken);
      setSession(s);
      setActiveId((cur) => cur ?? s.user.warehouseId ?? s.warehouses[0]?.id ?? null);
    } catch {
      setSession(null);
      setCsrf(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setActiveWh = useCallback(
    async (id: string) => {
      if (session?.user.role === 'ADMIN') await api('POST', '/api/session/warehouse', { warehouseId: id });
      setActiveId(id);
    },
    [session],
  );

  const logout = useCallback(async () => {
    await api('POST', '/api/auth/logout').catch(() => undefined);
    setCsrf(null);
    setSession(null);
    setActiveId(null);
    window.location.hash = '#/entrar';
  }, []);

  const withStepUp = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'STEP_UP_REQUIRED') throw e;
        const sec = session?.security;
        const passkeys = sec?.passkeys ?? 0;
        // Under the admin passkey policy, an admin who owns a passkey must use it.
        const totpAllowed = !(sec?.adminPasskeyPolicy && session?.user.role === 'ADMIN' && passkeys > 0);
        const answer = await new Promise<StepUpAnswer>((resolve) => setStepUpPrompt({ resolve, passkeys, totpAllowed }));
        setStepUpPrompt(null);
        if (!answer) throw new ApiError(403, 'STEP_UP_CANCELLED', 'Confirmação MFA cancelada');
        if (answer.kind === 'passkey') await passkeyStepUp();
        else await api('POST', '/api/auth/step-up', { code: answer.code });
        return fn();
      }
    },
    [session],
  );

  const value = useMemo<Ctx>(
    () => ({
      session,
      loading,
      activeWh: session?.warehouses.find((w) => w.id === activeId) ?? null,
      setActiveWh,
      can: (p: string) => !!session?.user.permissions.includes(p),
      reload,
      logout,
      withStepUp,
      stepUpPrompt,
    }),
    [session, loading, activeId, setActiveWh, reload, logout, withStepUp, stepUpPrompt],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Accesses the session context. */
export function useSession(): Ctx {
  const c = useContext(SessionContext);
  if (!c) throw new Error('useSession outside SessionProvider');
  return c;
}
