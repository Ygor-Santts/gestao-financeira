// Web Push without libraries: VAPID (RFC 8292) and aes128gcm payload encryption
// (RFC 8188 + RFC 8291), using only node:crypto.
import {
  createECDH, createCipheriv, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign,
} from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s).replace(/=+$/, ''), 'base64url');

// A P-256 key pair for VAPID, kept as JWK so it survives restarts.
export function newVapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { jwk, publicKey: publicKeyFromJwk(jwk) };
}

export function publicKeyFromJwk(jwk) {
  // Uncompressed point: 0x04 || X || Y (65 bytes), what the browser expects.
  return b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]));
}

export function vapidHeader(endpoint, vapid, subject, nowSec = Math.floor(Date.now() / 1000)) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: subject }));
  const data = `${header}.${claims}`;
  const key = createPrivateKey({ key: vapid.jwk, format: 'jwk' });
  const sig = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// Encrypts the payload for one subscription. salt and serverKeys can be passed in tests.
export function encrypt(payload, sub, { salt = randomBytes(16), serverKeys } = {}) {
  const uaPublic = fromB64u(sub.keys.p256dh);
  const authSecret = fromB64u(sub.keys.auth);
  const ecdh = createECDH('prime256v1');
  if (serverKeys) ecdh.setPrivateKey(serverKeys.privateKey); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02 = last record
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Sends one notification. Returns { ok, gone } — gone means the subscription no
// longer exists (the person uninstalled the app or turned notifications off).
export async function sendPush(sub, message, vapid, subject) {
  const body = encrypt(JSON.stringify(message), sub);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(sub.endpoint, vapid, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(24 * 3600),
      Urgency: 'normal',
    },
    body,
  });
  return { ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status };
}
