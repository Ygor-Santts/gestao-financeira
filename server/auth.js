// Single-user login. The password comes from the FINANCAS_SENHA environment variable
// (a GitHub secret written to the server's .env by the deploy). Sessions are signed
// tokens in an httpOnly cookie, so nothing about the session is stored in the browser's JS.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getSetting, setSetting } from './db.js';

const COOKIE = 'fin_sess';
const MAX_AGE_DAYS = 90;

export function initAuth(db, password) {
  let secret = getSetting(db, 'session_secret');
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    setSetting(db, 'session_secret', secret);
  }
  // The password is hashed at boot; the plain text is only kept in the env.
  let hash = null;
  if (password) {
    const salt = randomBytes(16);
    hash = { salt, key: scryptSync(password, salt, 64) };
  }
  const attempts = new Map(); // ip -> { n, until }

  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  function verify(token) {
    if (!token || !token.includes('.')) return null;
    const [body, mac] = token.split('.');
    const expected = createHmac('sha256', secret).update(body).digest('base64url');
    if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp < Date.now()) return null;
    return p;
  }

  function checkPassword(ip, pass) {
    const a = attempts.get(ip) || { n: 0, until: 0 };
    if (a.until > Date.now()) return { ok: false, wait: Math.ceil((a.until - Date.now()) / 1000) };
    if (!hash) return { ok: false, error: 'Senha não configurada no servidor (FINANCAS_SENHA).' };
    const key = scryptSync(String(pass || ''), hash.salt, 64);
    if (timingSafeEqual(key, hash.key)) {
      attempts.delete(ip);
      return { ok: true };
    }
    a.n += 1;
    if (a.n >= 5) { a.until = Date.now() + 60_000 * Math.min(30, 2 ** (a.n - 5)); }
    attempts.set(ip, a);
    return { ok: false };
  }

  function cookieFor(token, secure) {
    const maxAge = token ? MAX_AGE_DAYS * 86400 : 0;
    return `${COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  function session(req) {
    const raw = req.headers.cookie || '';
    const m = raw.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
    return verify(m ? m.slice(COOKIE.length + 1) : null);
  }

  function newToken() {
    return sign({ u: 'owner', exp: Date.now() + MAX_AGE_DAYS * 86400_000 });
  }

  return { checkPassword, cookieFor, session, newToken, configured: !!hash };
}
