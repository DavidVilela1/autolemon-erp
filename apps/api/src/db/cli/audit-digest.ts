/**
 * @file CLI for signed audit-chain digests (SEC-OPEN-008; ADR-0027).
 * @module platform/audit
 *
 * Usage (from the repository root; relative paths resolve against the directory you run pnpm in):
 *   pnpm audit:digest keygen --out-dir <dir outside the repository>
 *   pnpm audit:digest create --key <private.pem> --out-dir <digest dir>
 *   pnpm audit:digest verify --pub <public.pem> [--chain <company id>]... <digest file or directory>...
 *
 * Exit codes: 0 ok · 1 verification found problems · 2 usage/configuration error.
 * The private key is only ever read from a file given on the command line; it is never logged,
 * never written inside the repository and never stored in the database. Digest files are written
 * once (`wx`, read-only mode); ship them to write-once storage (see OPERATIONS.md §6a).
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { loadConfig } from '../../config/env.js';
import { Database } from '../database.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import {
  createDigest,
  generateDigestKeyPair,
  parseAndVerifyDigest,
  verifyDigestsAgainstDb,
  type AuditDigest,
} from '../../platform/audit/digest.js';
import { loadToolEnv } from './env.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const [command, ...rest] = process.argv.slice(2);

function usage(msg: string): never {
  console.error(
    `${msg}\nUsage:\n  audit:digest keygen --out-dir <dir>\n  audit:digest create --key <private.pem> --out-dir <dir>\n  audit:digest verify --pub <public.pem> [--chain <id>]... <file|dir>...`,
  );
  process.exit(2);
}

/** Resolves a user path against the directory pnpm was started from (INIT_CWD), not apps/api. */
function userPath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.env.INIT_CWD ?? process.cwd(), p);
}

function flag(name: string): string | undefined {
  const i = rest.indexOf(name);
  if (i === -1) return undefined;
  const v = rest[i + 1];
  if (!v || v.startsWith('--')) usage(`${name} needs a value`);
  rest.splice(i, 2);
  return v;
}

function insideRepo(p: string): boolean {
  const rel = relative(REPO_ROOT, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function withAudit<T>(fn: (db: Database, audit: AuditService) => Promise<T>): Promise<T> {
  await loadToolEnv();
  const cfg = loadConfig();
  const db = new Database(cfg);
  try {
    return await fn(db, new AuditService(db));
  } finally {
    await db.close();
  }
}

if (command === 'keygen') {
  const outDir = userPath(flag('--out-dir') ?? usage('--out-dir is required'));
  // A signing key inside the working tree is one `git add -A` away from being published.
  if (insideRepo(outDir)) usage('Refusing to write keys inside the repository; choose a directory outside it.');
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const k = generateDigestKeyPair();
  const priv = join(outDir, `audit-digest-${k.keyId}.private.pem`);
  const pub = join(outDir, `audit-digest-${k.keyId}.public.pem`);
  writeFileSync(priv, k.privatePem, { mode: 0o600, flag: 'wx' });
  writeFileSync(pub, k.publicPem, { mode: 0o644, flag: 'wx' });
  console.log(
    `Key id ${k.keyId}\nPrivate key: ${priv} (keep offline / in the secrets manager; never in the repository)\nPublic key:  ${pub}`,
  );
} else if (command === 'create') {
  const keyPath = userPath(flag('--key') ?? usage('--key is required'));
  const outDir = userPath(flag('--out-dir') ?? usage('--out-dir is required'));
  const privateKey = createPrivateKey(readFileSync(keyPath));
  mkdirSync(outDir, { recursive: true });
  const digest = await withAudit((db) => createDigest(db, privateKey));
  const file = join(outDir, `audit-digest-${digest.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json`);
  writeFileSync(file, `${JSON.stringify(digest, null, 2)}\n`, { mode: 0o444, flag: 'wx' });
  console.log(`Digest written: ${file} (${digest.chains.length} chains, key ${digest.keyId}). Copy it to write-once storage now.`);
} else if (command === 'verify') {
  const pubPath = userPath(flag('--pub') ?? usage('--pub is required'));
  // Optional scope (repeatable): investigate one company without being blocked by others.
  const only = new Set<string>();
  for (let c = flag('--chain'); c; c = flag('--chain')) only.add(c);
  if (!rest.length) usage('give at least one digest file or directory');
  const publicKey = createPublicKey(readFileSync(pubPath));
  const files = rest.map(userPath).flatMap((p) =>
    statSync(p).isDirectory()
      ? readdirSync(p)
          .filter((f) => /^audit-digest-.*\.json$/.test(f))
          .sort()
          .map((f) => join(p, f))
      : [p],
  );
  if (!files.length) usage('no audit-digest-*.json files found');
  const digests: Array<{ source: string; digest: AuditDigest }> = [];
  let invalid = 0;
  for (const f of files) {
    try {
      // Bounded read: a digest of 100 000 chains is < 15 MB.
      if (statSync(f).size > 16 * 1024 * 1024) throw new Error('file too large');
      digests.push({ source: basename(f), digest: parseAndVerifyDigest(JSON.parse(readFileSync(f, 'utf8')), publicKey) });
    } catch (e) {
      invalid++;
      console.error(`INVALID ${basename(f)}: ${e instanceof Error ? e.message : 'unreadable'}`);
    }
  }
  const scoped = only.size
    ? digests.map((d) => ({ ...d, digest: { ...d.digest, chains: d.digest.chains.filter((c) => only.has(c.chainKey)) } }))
    : digests;
  const report = await withAudit((_db, audit) => verifyDigestsAgainstDb(audit, scoped));
  for (const p of report.problems) console.error(`${p.problem} ${p.source} chain ${p.chainKey} seq ${p.seq}: ${p.detail}`);
  const ok = report.ok && invalid === 0;
  console.log(
    `${ok ? 'OK' : 'FAILED'}: ${digests.length} valid digest(s), ${invalid} invalid, ${report.chains} chain(s), ${report.checkpoints} checkpoint(s), ${report.problems.length} problem(s).`,
  );
  process.exit(ok ? 0 : 1);
} else {
  usage(command ? `Unknown command ${command}` : 'Missing command');
}
