// Minimal MIME reader: enough to find attachments (with their names) in an e-mail.

function splitHead(raw) {
  const m = raw.match(/\r?\n\r?\n/);
  if (!m) return [raw, ''];
  return [raw.slice(0, m.index), raw.slice(m.index + m[0].length)];
}

function parseHeaders(text) {
  const out = {};
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    out[k] = out[k] ? `${out[k]}, ${line.slice(i + 1).trim()}` : line.slice(i + 1).trim();
  }
  return out;
}

// value; a=b; c="d e"; f*=utf-8''x%20y; g*0*=...; g*1*=...
function parseParams(v = '') {
  const [value, ...rest] = splitParams(v);
  const params = {};
  const cont = {};
  for (const p of rest) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const key = p.slice(0, i).trim().toLowerCase();
    let val = p.slice(i + 1).trim();
    if (val.startsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    const c = key.match(/^(.+?)\*(\d+)\*?$/);
    if (c) { (cont[c[1]] ||= [])[+c[2]] = { val, enc: key.endsWith('*') }; continue; }
    if (key.endsWith('*')) params[key.slice(0, -1)] = decode2231(val, true);
    else params[key] = val;
  }
  for (const [k, pieces] of Object.entries(cont)) {
    const enc = pieces[0]?.enc;
    params[k] = decode2231(pieces.map((p) => p?.val || '').join(''), enc);
  }
  return { value: value.trim().toLowerCase(), params };
}

function splitParams(v) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === '"' && v[i - 1] !== '\\') q = !q;
    if (ch === ';' && !q) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function decode2231(val, encoded) {
  if (!encoded) return val;
  const m = val.match(/^([^']*)'[^']*'(.*)$/);
  const charset = (m ? m[1] : 'utf-8') || 'utf-8';
  const bytes = Buffer.from((m ? m[2] : val).replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  return toText(bytes, charset);
}

function toText(bytes, charset = 'utf-8') {
  try { return new TextDecoder(charset.toLowerCase()).decode(bytes); } catch { return bytes.toString('utf8'); }
}

// =?utf-8?B?...?= and =?iso-8859-1?Q?...?=
export function decodeWords(s = '') {
  return s.replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, cs, enc, data) => {
    const bytes = enc.toUpperCase() === 'B'
      ? Buffer.from(data, 'base64')
      : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    return toText(bytes, cs);
  });
}

function decodeBody(body, encoding = '') {
  const e = encoding.toLowerCase();
  if (e === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (e === 'quoted-printable') {
    return Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  }
  return Buffer.from(body, 'latin1');
}

function walk(raw, out) {
  const [head, body] = splitHead(raw);
  const h = parseHeaders(head);
  const ct = parseParams(h['content-type'] || 'text/plain');
  if (ct.value.startsWith('multipart/') && ct.params.boundary) {
    const b = `--${ct.params.boundary}`;
    const chunks = body.split(b).slice(1);
    for (const chunk of chunks) {
      if (chunk.startsWith('--')) break;
      walk(chunk.replace(/^\r?\n/, ''), out);
    }
    return;
  }
  const cd = parseParams(h['content-disposition'] || '');
  const filename = decodeWords(cd.params.filename || ct.params.name || '');
  if (filename || cd.value === 'attachment') {
    out.push({ filename: filename || 'anexo', contentType: ct.value, data: decodeBody(body.replace(/\r?\n$/, ''), h['content-transfer-encoding']) });
  }
}

export function parseMail(buf) {
  const raw = Buffer.isBuffer(buf) ? buf.toString('latin1') : buf;
  const [head] = splitHead(raw);
  const h = parseHeaders(head);
  const attachments = [];
  walk(raw, attachments);
  return {
    from: decodeWords(h.from || ''),
    subject: decodeWords(h.subject || ''),
    date: h.date ? new Date(h.date) : null,
    messageId: h['message-id'] || null,
    attachments,
  };
}
