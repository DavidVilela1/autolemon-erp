# ADR-0027 — Signed audit-chain digests for off-site, write-once storage

Status: Accepted (v0.6.5). Owning module: platform (audit). Closes the code part of
SEC-OPEN-008; contributes to gate S-05.

**Context.** The security audit log is hash-chained (ADR on audit) and the security monitor
verifies it incrementally (ADR-0026). Both only prove _internal_ consistency: a database
superuser (or anyone holding the owner role) can edit an entry and recompute every later hash,
and the chain verifies again. Detection needs a reference the database operator cannot change.

**Decision.**

- `pnpm audit:digest create --key <private.pem> --out-dir <dir>` writes a **digest**: for every
  non-empty chain (pre-authentication chain + one per company) the head `(seq, hash)`, the time
  and the key id, signed with **Ed25519**. Files are written once (`wx`), read-only, named
  `audit-digest-<UTC timestamp>.json`, and contain no audit contents (ids, sequence numbers,
  hashes only).
- `pnpm audit:digest verify --pub <public.pem> <file|dir>…` checks each file (strict schema, key
  id, signature) and then walks each chain once from the genesis, stopping exactly at every
  digested sequence number: `CHAIN_BROKEN` (chain does not verify), `ENTRIES_MISSING` (database
  ends before a digested seq — deletion/truncation), `HASH_MISMATCH` (consistent rewrite). Exit
  codes 0 / 1 / 2 (usage).
- `pnpm audit:digest keygen --out-dir <dir>` creates the key pair; it **refuses to write inside the
  repository**, writes the private key with mode 0600 and never prints it. `*.pem` and
  `audit-digest-*.json` are git-ignored and excluded from the archive (`verify:handover` fails if
  one slips in).
- The signing key is **not** an application secret: the API never reads it. It lives with the
  operator who runs the scheduled job (or in the secrets manager of that job), separate from the
  database credentials. The public key is kept with the digests and with the auditor.
- Scheduling and storage are owner-side (OPERATIONS §6a): run `create` daily (cron/systemd timer
  /Task Scheduler) and copy the file immediately to write-once storage (e.g. object-lock bucket in
  compliance mode, another account/organisation). Run `verify` weekly and during incidents.

**Alternatives.** HMAC digests (the verifier would need the signing secret, so the auditor could
forge digests); storing digests in the same database (the attacker controls them); RFC 3161
timestamping or a transparency log (stronger ordering guarantees, but needs an external service
and spending — possible later on top of this format); signing inside the API on a timer (puts the
signing key on the most exposed host).

**Consequences.** Tampering _after_ the latest stored digest and before the next one is only
detected by the chain check (consistent rewrites in that window are not), so the digest interval
is the exposure window — daily by default, shorten it for high-risk periods. Key rotation:
generate a new pair, start signing with it, keep old public keys to verify old digests (the key id
selects the key; `verify` takes one `--pub` per run). Losing the private key only stops new
digests; old ones stay verifiable with the public key.
