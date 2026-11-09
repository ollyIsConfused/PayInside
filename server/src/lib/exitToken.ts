import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, randomBytes, KeyObject } from 'node:crypto';

// Exit-Codes sind digital signierte Kurz-Tokens (Ed25519). Die Schranke kann sie online prüfen
// (inkl. "nur einmal gültig") oder notfalls offline mit dem öffentlichen Schlüssel.
//
// Format:  PI1.<base64url(47-Byte-Payload)>.<base64url(64-Byte-Signatur über "PI1.<payload>")>
// Payload (binär, kompakt → kleiner QR-Code, schnelles Scannen):
//   Byte 0       Version (1)
//   Byte 1–16    Bestell-ID (UUID)
//   Byte 17–32   Laden-ID (UUID)
//   Byte 33–41   Nonce (9 Byte)
//   Byte 42–45   Ablauf (Unix-Sekunden, uint32 big-endian)
//   Byte 46      Flags: Bit 0 = Ausweis prüfen, Bit 1 = Stichprobe

export interface ExitPayload {
  o: string; // Bestell-ID
  s: string; // Laden-ID
  n: string; // Nonce (base64url, 9 Byte)
  e: number; // Ablauf
  c: string[]; // Kontrollen: 'age', 'audit'
}

export interface ExitSigner {
  sign(payload: ExitPayload): string;
  verify(token: string, nowSeconds?: number): { ok: true; payload: ExitPayload } | { ok: false; reason: string };
  publicKeyPem: string;
  publicKeyRawBase64: string;
}

const PREFIX = 'PI1';
const LEN = 47;

export function generateExitKeyPem(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

export function newNonce(): string {
  return randomBytes(9).toString('base64url');
}

const uuidToBytes = (u: string) => Buffer.from(u.replace(/-/g, ''), 'hex');
const bytesToUuid = (b: Buffer) => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export function encodePayload(p: ExitPayload): Buffer {
  const buf = Buffer.alloc(LEN);
  buf[0] = 1;
  const o = uuidToBytes(p.o);
  const s = uuidToBytes(p.s);
  const n = Buffer.from(p.n, 'base64url');
  if (o.length !== 16 || s.length !== 16 || n.length !== 9) throw new Error('Ungültige Exit-Payload');
  o.copy(buf, 1);
  s.copy(buf, 17);
  n.copy(buf, 33);
  buf.writeUInt32BE(p.e, 42);
  buf[46] = (p.c.includes('age') ? 1 : 0) | (p.c.includes('audit') ? 2 : 0);
  return buf;
}

export function decodePayload(buf: Buffer): ExitPayload | null {
  if (buf.length !== LEN || buf[0] !== 1) return null;
  const flags = buf[46];
  return {
    o: bytesToUuid(buf.subarray(1, 17)),
    s: bytesToUuid(buf.subarray(17, 33)),
    n: buf.subarray(33, 42).toString('base64url'),
    e: buf.readUInt32BE(42),
    c: [...(flags & 1 ? ['age'] : []), ...(flags & 2 ? ['audit'] : [])],
  };
}

export function createExitSigner(privateKeyPem: string): ExitSigner {
  const priv: KeyObject = createPrivateKey(privateKeyPem);
  const pub: KeyObject = createPublicKey(priv);
  const publicKeyPem = pub.export({ type: 'spki', format: 'pem' }).toString();
  // Rohschlüssel (32 Byte) = letzte 32 Byte der SPKI-DER-Kodierung
  const der = pub.export({ type: 'spki', format: 'der' });
  const publicKeyRawBase64 = der.subarray(der.length - 32).toString('base64');

  return {
    publicKeyPem,
    publicKeyRawBase64,
    sign(payload) {
      const body = encodePayload(payload).toString('base64url');
      const sig = sign(null, Buffer.from(`${PREFIX}.${body}`), priv).toString('base64url');
      return `${PREFIX}.${body}.${sig}`;
    },
    verify(token, nowSeconds = Math.floor(Date.now() / 1000)) {
      const parts = token.trim().split('.');
      if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: 'format' };
      const [, body, sig] = parts;
      let valid = false;
      try {
        valid = verify(null, Buffer.from(`${PREFIX}.${body}`), pub, Buffer.from(sig, 'base64url'));
      } catch {
        valid = false;
      }
      if (!valid) return { ok: false, reason: 'signature' };
      const payload = decodePayload(Buffer.from(body, 'base64url'));
      if (!payload) return { ok: false, reason: 'format' };
      if (payload.e < nowSeconds) return { ok: false, reason: 'expired' };
      return { ok: true, payload };
    },
  };
}
