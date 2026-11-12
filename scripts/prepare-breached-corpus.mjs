/**
 * @file `node scripts/prepare-breached-corpus.mjs <hibp-sha1-ordered-by-hash.txt> <out.txt>`
 * Converts the Have I Been Pwned "SHA-1, ordered by hash" download (lines "HASH:COUNT") into the
 * fixed-width format read by apps/api/src/platform/auth/breached-corpus.ts ("HASH\n", 41 bytes).
 * Owning module: platform/auth tooling. Streams; verifies ascending order and hash format;
 * never sees plaintext passwords. Point BREACHED_PASSWORD_CORPUS at the output file.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/prepare-breached-corpus.mjs <input> <output>');
  process.exit(2);
}
const out = createWriteStream(output);
let prev = '';
let n = 0;
for await (const raw of createInterface({ input: createReadStream(input), crlfDelay: Infinity })) {
  const h = raw.split(':')[0]?.trim().toUpperCase() ?? '';
  if (!h) continue;
  if (!/^[0-9A-F]{40}$/.test(h)) throw new Error(`line ${n + 1}: not a SHA-1 hash`);
  if (h <= prev) throw new Error(`line ${n + 1}: input is not strictly ascending (use the "ordered by hash" download)`);
  if (!out.write(`${h}\n`)) await new Promise((r) => out.once('drain', r));
  prev = h;
  n++;
}
await new Promise((r) => out.end(r));
console.log(`Wrote ${n} hashes to ${output}`);
