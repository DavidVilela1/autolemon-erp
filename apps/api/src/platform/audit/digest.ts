/**
 * @file Signed audit-chain digests for off-site, write-once storage (SEC-OPEN-008; ADR-0027).
 * @module platform/audit
 *
 * Why: the hash chain detects a single altered entry, but someone with database superuser
 * rights can rewrite an entry AND recompute every later hash, leaving a chain that verifies.
 * A digest records each chain's head `(seq, hash)` at a point in time, signed with an Ed25519
 * key that never lives in the database or the application. Once a digest is stored where the
 * database operator cannot change it (object-lock bucket, another organisation, printed paper),
 * any later rewrite of an entry at or before a digested sequence number changes the hash at that
 * point and is detected by {@link verifyDigestsAgainstDb}; deleting entries is detected because
 * the database head falls below a digested sequence number.
 *
 * Format (`autolemon.audit-digest`, version 1): JSON with `generatedAt`, `keyId` (first 16 hex of
 * SHA-256 over the SPKI public key), `chains: [{ chainKey, seq, hash }]` and `signature` = Ed25519
 * over the canonical JSON of every other field. Digests contain chain ids (company ids / the
 * pre-authentication chain), sequence numbers and hashes only — no audit contents.
 */
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalJson } from '../../common/crypto-util.js';
import type { Database } from '../../db/database.js';
import { row, rows } from '../../db/database.js';
import { AUDIT_GENESIS_HASH, type AuditService, PRE_AUTH_CHAIN } from './audit.service.js';

/** Digest format identifier. */
export const DIGEST_FORMAT = 'autolemon.audit-digest' as const;

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const ChainHead = z.object({ chainKey: z.string().uuid(), seq: z.string().regex(/^[1-9][0-9]{0,18}$/), hash: Hex64 }).strict();

/** Strict schema of a digest file (rejects unknown fields, oversized lists, malformed values). */
export const AuditDigestSchema = z
  .object({
    format: z.literal(DIGEST_FORMAT),
    version: z.literal(1),
    generatedAt: z.string().datetime(),
    keyId: z.string().regex(/^[0-9a-f]{16}$/),
    chains: z.array(ChainHead).max(100_000),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();

/** A signed digest. */
export type AuditDigest = z.infer<typeof AuditDigestSchema>;

/** Generates an Ed25519 key pair for digest signing (PEM: PKCS#8 private, SPKI public). */
export function generateDigestKeyPair(): { privatePem: string; publicPem: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    keyId: keyIdOf(publicKey),
  };
}

/** Short, stable identifier of a public key (lets verifiers pick the right key after rotation). */
export function keyIdOf(publicKey: KeyObject): string {
  return createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 16);
}

/** Throws unless the key is an Ed25519 key (refuses RSA/EC keys passed by mistake). */
export function assertEd25519(key: KeyObject): void {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('digest keys must be Ed25519');
}

/**
 * Reads the current head `(seq, hash)` of every non-empty audit chain: the pre-authentication
 * chain and one chain per company (one indexed lookup per chain).
 */
export async function readChainHeads(database: Database): Promise<AuditDigest['chains']> {
  return database.systemTx(async (tx) => {
    const companies = await rows<{ id: string }>(tx, sql`SELECT id FROM companies ORDER BY id`);
    const heads: AuditDigest['chains'] = [];
    for (const chainKey of [PRE_AUTH_CHAIN, ...companies.map((c) => c.id)]) {
      const h = await row<{ seq: string; hash: Buffer }>(
        tx,
        sql`SELECT seq::text, hash FROM security_audit_log WHERE chain_key = ${chainKey} ORDER BY seq DESC LIMIT 1`,
      );
      if (h) heads.push({ chainKey, seq: h.seq, hash: h.hash.toString('hex') });
    }
    return heads;
  });
}

function signedPayload(d: Omit<AuditDigest, 'signature'>): Buffer {
  return Buffer.from(canonicalJson({ format: d.format, version: d.version, generatedAt: d.generatedAt, keyId: d.keyId, chains: d.chains }));
}

/** Builds and signs a digest of the current chain heads. */
export async function createDigest(database: Database, privateKey: KeyObject, now = new Date()): Promise<AuditDigest> {
  assertEd25519(privateKey);
  const unsigned = {
    format: DIGEST_FORMAT,
    version: 1 as const,
    generatedAt: now.toISOString(),
    keyId: keyIdOf(createPublicKey(privateKey)),
    chains: await readChainHeads(database),
  };
  return { ...unsigned, signature: sign(null, signedPayload(unsigned), privateKey).toString('base64') };
}

/**
 * Parses an untrusted digest (file contents) and checks its signature and key id.
 * @throws Error describing the first problem (schema, key id, signature).
 */
export function parseAndVerifyDigest(json: unknown, publicKey: KeyObject): AuditDigest {
  assertEd25519(publicKey);
  const parsed = AuditDigestSchema.safeParse(json);
  if (!parsed.success) throw new Error(`not a valid ${DIGEST_FORMAT} v1 file`);
  const d = parsed.data;
  if (d.keyId !== keyIdOf(publicKey)) throw new Error(`signed with another key (${d.keyId})`);
  if (!verify(null, signedPayload(d), publicKey, Buffer.from(d.signature, 'base64'))) throw new Error('signature does not verify');
  return d;
}

/** One finding of a verification run. */
export interface DigestProblem {
  source: string;
  chainKey: string;
  seq: string;
  problem: 'CHAIN_BROKEN' | 'ENTRIES_MISSING' | 'HASH_MISMATCH';
  detail: string;
}

/**
 * Compares signed digests with the database. Every chain is walked once from the genesis
 * (bounded pages), stopping exactly at each digested sequence number:
 *  - the chain itself must verify up to that point (`CHAIN_BROKEN` otherwise);
 *  - the database must still contain that sequence number (`ENTRIES_MISSING`: truncation);
 *  - the recomputed hash must equal the digested hash (`HASH_MISMATCH`: consistent rewrite).
 * @param digests already signature-checked digests with a label (e.g. the file name).
 */
export async function verifyDigestsAgainstDb(
  audit: AuditService,
  digests: Array<{ source: string; digest: AuditDigest }>,
): Promise<{ ok: boolean; chains: number; checkpoints: number; problems: DigestProblem[] }> {
  const byChain = new Map<string, Array<{ seq: bigint; hash: string; source: string }>>();
  for (const { source, digest } of digests) {
    for (const c of digest.chains) {
      const list = byChain.get(c.chainKey) ?? [];
      list.push({ seq: BigInt(c.seq), hash: c.hash, source });
      byChain.set(c.chainKey, list);
    }
  }
  const problems: DigestProblem[] = [];
  let checkpoints = 0;
  for (const [chainKey, targets] of byChain) {
    targets.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    let cur: { seq: bigint; hash: Buffer } = { seq: 0n, hash: AUDIT_GENESIS_HASH };
    let stopped: DigestProblem['problem'] | undefined;
    let stopDetail = '';
    for (const t of targets) {
      checkpoints++;
      while (!stopped && cur.seq < t.seq) {
        const remaining = t.seq - cur.seq;
        const r = await audit.verifyRange(chainKey, cur, remaining > 50_000n ? 50_000 : Number(remaining));
        if (!r.ok) {
          stopped = 'CHAIN_BROKEN';
          stopDetail = `chain does not verify at seq ${r.brokenAtSeq}`;
        } else if (r.checked === 0) {
          stopped = 'ENTRIES_MISSING';
          stopDetail = `database ends at seq ${cur.seq}`;
        } else {
          cur = { seq: r.lastSeq, hash: r.lastHash };
        }
      }
      if (stopped) {
        problems.push({ source: t.source, chainKey, seq: t.seq.toString(), problem: stopped, detail: stopDetail });
      } else if (cur.hash.toString('hex') !== t.hash) {
        problems.push({
          source: t.source,
          chainKey,
          seq: t.seq.toString(),
          problem: 'HASH_MISMATCH',
          detail: 'entries up to this point were rewritten',
        });
      }
    }
  }
  return { ok: problems.length === 0, chains: byChain.size, checkpoints, problems };
}
