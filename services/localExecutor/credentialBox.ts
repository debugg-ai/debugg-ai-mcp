/**
 * Sealed-box credential delivery. The executor makes a fresh X25519 keypair per session
 * and sends ONLY the public key at session creation. The server decrypts a stored
 * credential with its own key (which never leaves the server), then re-encrypts it to
 * this public key before it enters any queue or response. Only this process can open it.
 *
 * Envelope (JSON, all base64): { v:1, alg:'x25519-hkdf-sha256-aes256gcm', epk, iv, ct, tag }
 *   epk = sender's ephemeral X25519 public key, SPKI DER
 *   key = HKDF-SHA256(ikm = ECDH(epk, recipient private), salt = empty, info = 'debuggai-executor-credential-v1', 32 bytes)
 *   ct/tag = AES-256-GCM(key, iv(12 bytes), plaintext); AAD = the session id
 */
import crypto from 'node:crypto';

export const SEAL_ALG = 'x25519-hkdf-sha256-aes256gcm';
export const SEAL_INFO = 'debuggai-executor-credential-v1';

export interface SealedEnvelope { v: 1; alg: typeof SEAL_ALG; epk: string; iv: string; ct: string; tag: string }
export interface SessionKeys { publicKey: string; open(env: SealedEnvelope, sessionId: string): string }

export function generateSessionKeys(): SessionKeys {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    open(env, sessionId) {
      if (env.v !== 1 || env.alg !== SEAL_ALG) throw new Error(`Unsupported credential envelope (${env.alg}).`);
      const epk = crypto.createPublicKey({ key: Buffer.from(env.epk, 'base64'), type: 'spki', format: 'der' });
      const shared = crypto.diffieHellman({ privateKey, publicKey: epk });
      const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), SEAL_INFO, 32));
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
      d.setAAD(Buffer.from(sessionId));
      d.setAuthTag(Buffer.from(env.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]).toString('utf8');
    },
  };
}

/** Reference sealer (server side lives in the platform repo; used here for tests and as the spec). */
export function sealTo(publicKeyB64: string, plaintext: string, sessionId: string): SealedEnvelope {
  const recipient = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), type: 'spki', format: 'der' });
  const eph = crypto.generateKeyPairSync('x25519');
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), SEAL_INFO, 32));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(sessionId));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { v: 1, alg: SEAL_ALG, epk: eph.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}
