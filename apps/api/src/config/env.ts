/**
 * @file Validated runtime configuration (fail-fast on unsafe production settings).
 * @module platform/config
 *
 * All configuration comes from environment variables and is parsed once with Zod. Unknown
 * variables are ignored; malformed ones abort startup. Secrets are never logged: only the
 * presence of key material is reported by {@link describeConfig}.
 */
import { z } from 'zod';

const Bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Runtime connection (least-privileged `autolemon_app` role, subject to RLS). */
  APP_DATABASE_URL: z.string().min(1),
  /** Owner connection, used ONLY by migration/seed/reset tooling. */
  DATABASE_URL: z.string().min(1).optional(),
  /** Postgres TLS mode. Production requires verify-full. */
  DB_SSL: z.enum(['disable', 'require', 'verify-full']).default('disable'),
  DB_SSL_CA_FILE: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Exact browser origin allowed to call the API (CSRF origin check + CORS). */
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  /** Fastify trustProxy: 'false' or a comma-separated list of proxy IPs/CIDRs. Never 'true'. */
  TRUST_PROXY: z.string().default('false'),
  COOKIE_SECURE: Bool.default(true),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24).default(12),
  STEP_UP_MINUTES: z.coerce.number().int().min(1).max(30).default(5),
  /** Key provider. 'local-dev' is UNSAFE FOR PRODUCTION and refused there. */
  KEY_PROVIDER: z.enum(['local-dev', 'external-kms']).default('local-dev'),
  /** Local dev keyring: "kekId:base64key[,kekId:base64key]". First entry is active. */
  LOCAL_DEV_KEKS: z.string().optional(),
  /** 32-byte base64 secret used to derive per-session CSRF tokens (HMAC). */
  CSRF_SECRET: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'CSRF_SECRET must be 32 bytes base64'),
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(19456).max(1048576).default(65536),
  ARGON2_ITERATIONS: z.coerce.number().int().min(2).max(10).default(3),
  /** Retention windows in days (minimum 7, enforced again inside the database function). */
  RETENTION_COMMAND_LOG_DAYS: z.coerce.number().int().min(7).max(3650).default(30),
  RETENTION_SESSION_DAYS: z.coerce.number().int().min(7).max(3650).default(30),
  RETENTION_TOKEN_DAYS: z.coerce.number().int().min(7).max(3650).default(30),
  RETENTION_OUTBOX_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
  /** Optional offline breached-password corpus (sorted SHA-1 lines); see breached-corpus.ts. */
  BREACHED_PASSWORD_CORPUS: z.string().min(1).optional(),
  /** Security monitor period (ADR-0026): rule evaluation, audit-chain checkpoints, alert delivery. */
  SECURITY_MONITOR_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  /**
   * Optional alert webhook (SIEM / chat / pager bridge). https only in production; plain http
   * only to a loopback address outside production. Requests are HMAC-signed with
   * ALERT_WEBHOOK_SECRET and carry no personal data.
   */
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  /** HMAC-SHA256 key for the webhook signature (≥ 32 characters; from the secrets manager). */
  ALERT_WEBHOOK_SECRET: z.string().min(32).optional(),
  /** WebAuthn relying-party id (defaults to the WEB_ORIGIN hostname). */
  WEBAUTHN_RP_ID: z
    .string()
    .regex(/^[a-z0-9.-]{1,253}$/)
    .optional(),
  /**
   * When true, company administrators must use a passkey (phishing-resistant) as their second
   * factor and for step-up once they have one; until they register one, only account security
   * routes are reachable. Mandatory in production.
   */
  ADMIN_PASSKEY_REQUIRED: Bool.default(false),
  /** Comma-separated optional modules to load. WMS is always on. */
  ENABLED_MODULES: z.string().default('wms'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Disable throttling ONLY inside automated tests that hammer login deliberately. */
  AUTH_THROTTLE_ENABLED: Bool.default(true),
});

/** Parsed configuration type. */
export type AppConfig = z.infer<typeof EnvSchema>;

/**
 * Parses `process.env` (or a supplied record) and applies production safety rules.
 * @throws Error describing every violated rule (no secret values included).
 */
export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  const problems: string[] = [];
  if (cfg.NODE_ENV === 'production') {
    // Production must never run with development shortcuts.
    if (cfg.KEY_PROVIDER === 'local-dev') problems.push('KEY_PROVIDER=local-dev is forbidden in production');
    if (cfg.DB_SSL !== 'verify-full') problems.push('DB_SSL must be verify-full in production');
    if (!cfg.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true in production');
    if (!cfg.WEB_ORIGIN.startsWith('https://')) problems.push('WEB_ORIGIN must be https in production');
    if (!cfg.AUTH_THROTTLE_ENABLED) problems.push('AUTH_THROTTLE_ENABLED must be true in production');
    if (!cfg.ADMIN_PASSKEY_REQUIRED) problems.push('ADMIN_PASSKEY_REQUIRED must be true in production');
    if (cfg.TRUST_PROXY.trim().toLowerCase() === 'true') problems.push('TRUST_PROXY=true is forbidden; list proxy addresses');
  }
  if (cfg.ALERT_WEBHOOK_URL) {
    const u = new URL(cfg.ALERT_WEBHOOK_URL);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (!cfg.ALERT_WEBHOOK_SECRET) problems.push('ALERT_WEBHOOK_SECRET is required when ALERT_WEBHOOK_URL is set');
    if (u.username || u.password) problems.push('ALERT_WEBHOOK_URL must not embed credentials');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback && cfg.NODE_ENV !== 'production')) {
      problems.push('ALERT_WEBHOOK_URL must be https (http only to loopback outside production)');
    }
  }
  if (cfg.KEY_PROVIDER === 'local-dev' && !cfg.LOCAL_DEV_KEKS) {
    problems.push('LOCAL_DEV_KEKS is required for KEY_PROVIDER=local-dev (run: node scripts/gen-dev-keys.mjs)');
  }
  if (problems.length) throw new Error(`Unsafe configuration: ${problems.join('; ')}`);
  return cfg;
}

/** WebAuthn relying-party id: explicit setting or the hostname of WEB_ORIGIN. */
export function rpIdOf(cfg: AppConfig): string {
  return cfg.WEBAUTHN_RP_ID ?? new URL(cfg.WEB_ORIGIN).hostname;
}

/** Returns a log-safe summary of configuration (no secrets, no connection strings). */
export function describeConfig(cfg: AppConfig): Record<string, unknown> {
  return {
    env: cfg.NODE_ENV,
    dbSsl: cfg.DB_SSL,
    keyProvider: cfg.KEY_PROVIDER,
    modules: cfg.ENABLED_MODULES,
    webOrigin: cfg.WEB_ORIGIN,
    trustProxy: cfg.TRUST_PROXY !== 'false',
    alertWebhook: !!cfg.ALERT_WEBHOOK_URL,
  };
}

/** Parses TRUST_PROXY into the value Fastify expects (false or an address list). */
export function trustProxySetting(cfg: AppConfig): false | string[] {
  const v = cfg.TRUST_PROXY.trim();
  if (v === '' || v === 'false') return false;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
