/**
 * @file Offline breached-password corpus (NIST SP 800-63B-4 §3.1.1.2 blocklist; ASVS V6).
 * Owning module: platform/auth.
 *
 * Optional, configured with BREACHED_PASSWORD_CORPUS = path to a file of UPPERCASE SHA-1 hashes,
 * one per line, sorted ascending, exactly 41 bytes per line ("<40 hex>\n"). Produce it from the
 * Have I Been Pwned "ordered by hash" SHA-1 download with `node scripts/prepare-breached-corpus.mjs`.
 * Lookups are a binary search with positioned reads (no network call, nothing leaves the
 * server, memory stays constant regardless of corpus size). The small built-in list in
 * common-passwords.ts is always checked as well.
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const LINE = 41;

/** Read-only, binary-searchable corpus of breached-password SHA-1 hashes. */
export class BreachedPasswordCorpus {
  private readonly fd: number;
  private readonly count: number;

  /** Opens and validates the corpus file (throws on a malformed size or unsorted sample). */
  constructor(path: string) {
    this.fd = openSync(path, 'r');
    const size = fstatSync(this.fd).size;
    if (size === 0 || size % LINE !== 0) {
      closeSync(this.fd);
      throw new Error('BREACHED_PASSWORD_CORPUS: file must contain 41-byte lines (40 hex + newline)');
    }
    this.count = size / LINE;
    if (this.count > 1 && this.hashAt(0) > this.hashAt(this.count - 1)) throw new Error('BREACHED_PASSWORD_CORPUS: file is not sorted');
  }

  /** Number of hashes in the corpus. */
  get size(): number {
    return this.count;
  }

  private hashAt(i: number): string {
    const buf = Buffer.alloc(40);
    readSync(this.fd, buf, 0, 40, i * LINE);
    return buf.toString('latin1');
  }

  /** True when the password's SHA-1 is in the corpus. */
  contains(password: string): boolean {
    const h = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.hashAt(mid);
      if (v === h) return true;
      if (v < h) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  /** Releases the file handle. */
  close(): void {
    closeSync(this.fd);
  }
}

let corpus: BreachedPasswordCorpus | undefined;

/** Installs (or clears) the process-wide corpus used by screenPassword(). */
export function configureBreachedCorpus(path: string | undefined): BreachedPasswordCorpus | undefined {
  corpus?.close();
  corpus = path ? new BreachedPasswordCorpus(path) : undefined;
  return corpus;
}

/** True when a corpus is configured and contains the password. */
export function isBreached(password: string): boolean {
  return corpus?.contains(password) ?? false;
}
