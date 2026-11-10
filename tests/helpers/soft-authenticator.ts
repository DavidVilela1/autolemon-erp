/**
 * @file Software WebAuthn authenticator for integration tests (owning module: tests).
 *
 * Produces REAL registration (attestation "none") and assertion responses with a P-256 key,
 * CBOR-encoded authenticator data and ECDSA/SHA-256 signatures, so the server's
 * @simplewebauthn verification runs unmodified. Test-only; never shipped.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

type Cbor = number | string | Buffer | CborMap | { [k: string]: Cbor };
type CborMap = Map<Cbor, Cbor>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

/** Minimal CBOR encoder (ints, text, bytes, maps) sufficient for WebAuthn structures. */
export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, val]) => [cbor(k as Cbor), cbor(val as Cbor)])]);
}

const b64u = (b: Buffer) => b.toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

/** A software passkey bound to one RP ID and origin. */
export class SoftAuthenticator {
  readonly credId = randomBytes(32);
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private counter = 0;

  constructor(
    readonly rpId = 'localhost',
    readonly origin = 'http://localhost:5173',
  ) {}

  /** Credential id (base64url). */
  get id(): string {
    return b64u(this.credId);
  }

  private coseKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    return cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
  }

  private authData(withCredential: boolean, rpId = this.rpId): Buffer {
    const flags = 0x01 | 0x04 | (withCredential ? 0x40 : 0); // UP | UV | AT
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const parts: Buffer[] = [sha256(rpId), Buffer.from([flags]), count];
    if (withCredential) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credId.length);
      parts.push(Buffer.alloc(16), len, this.credId, this.coseKey());
    }
    return Buffer.concat(parts);
  }

  /** Responds to PublicKeyCredentialCreationOptionsJSON. */
  register(options: { challenge: string }) {
    const clientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false }),
    );
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', this.authData(true)],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestationObject), transports: ['internal'] },
      authenticatorAttachment: 'platform' as const,
      clientExtensionResults: {},
    };
  }

  /**
   * Responds to PublicKeyCredentialRequestOptionsJSON.
   * @param overrides simulate attacks: wrong origin (phishing), wrong RP id, tampered signature.
   */
  assert(options: { challenge: string }, overrides: { origin?: string; rpId?: string; tamper?: boolean } = {}) {
    this.counter++;
    const clientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: overrides.origin ?? this.origin, crossOrigin: false }),
    );
    const authenticatorData = this.authData(false, overrides.rpId);
    let signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientData)]), this.keys.privateKey);
    if (overrides.tamper) signature = Buffer.from(signature.map((x, i) => (i === signature.length - 1 ? x ^ 1 : x)));
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authenticatorData), signature: b64u(signature) },
      clientExtensionResults: {},
    };
  }
}
