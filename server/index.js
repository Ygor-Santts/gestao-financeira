// Entry point: serves the API under /api and the PWA from /public.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { initAuth } from './auth.js';
import { makeApi } from './api.js';

const ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const DB_FILE = process.env.DB_FILE || fileURLToPath(new URL('../data/financas.db', import.meta.url));

const db = openDb(DB_FILE);
const auth = initAuth(db, process.env.FINANCAS_SENHA || '');
if (!auth.configured) console.warn('FINANCAS_SENHA não definida: ninguém consegue entrar até ela ser configurada.');
const api = makeApi(db, auth);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function readBodyOf(req) {
  return (limit) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Arquivo grande demais.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sender(req, res) {
  return (status, data) => {
    const body = Buffer.from(JSON.stringify(data));
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (body.length > 1024 && /gzip/.test(req.headers['accept-encoding'] || '')) {
      res.setHeader('Content-Encoding', 'gzip');
      return res.end(gzipSync(body));
    }
    return res.end(body);
  };
}

const cache = new Map();
async function serveStatic(req, res, pathname) {
  let rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if (rel.includes('..')) rel = '';
  let file = join(ROOT, rel || 'index.html');
  try {
    if (!(await stat(file)).isFile()) throw new Error();
  } catch {
    file = join(ROOT, 'index.html'); // SPA fallback
  }
  let entry = cache.get(file);
  if (!entry || process.env.NODE_ENV !== 'production') {
    const raw = await readFile(file);
    const type = TYPES[extname(file)] || 'application/octet-stream';
    const etag = `"${createHash('sha1').update(raw).digest('base64url').slice(0, 16)}"`;
    entry = { raw, gz: /text|json|svg|javascript|manifest/.test(type) ? gzipSync(raw) : null, type, etag };
    cache.set(file, entry);
  }
  res.setHeader('Content-Type', entry.type);
  // Code and pages are always checked with the server (cheap thanks to the ETag),
  // so an update shows up the next time the app opens. Only images are cached.
  const isImage = /\.(png|ico|svg|woff2)$/.test(file);
  res.setHeader('Cache-Control', isImage ? 'public, max-age=86400' : 'no-cache');
  res.setHeader('ETag', entry.etag);
  if (req.headers['if-none-match'] === entry.etag) { res.statusCode = 304; return res.end(); }
  if (entry.gz && /gzip/.test(req.headers['accept-encoding'] || '')) {
    res.setHeader('Content-Encoding', 'gzip');
    return res.end(entry.gz);
  }
  return res.end(entry.raw);
}

const server = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
      return await api(req, res, url, readBodyOf(req), sender(req, res));
    }
    // Share target without the service worker yet: just open the import screen.
    if (url.pathname === '/share' && req.method === 'POST') { res.statusCode = 303; res.setHeader('Location', '/#/importar'); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = e.status || 500;
      res.setHeader('Content-Type', 'application/json');
    }
    if (!e.status) console.error(e);
    res.end(JSON.stringify({ error: e.status ? e.message : 'Erro interno.' }));
  }
});

server.listen(PORT, () => console.log(`Finanças rodando na porta ${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(); db.close(); process.exit(0); });
}
