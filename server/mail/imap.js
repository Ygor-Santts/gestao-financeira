// Tiny IMAP client (TLS), just what is needed to read statements from Gmail:
// LOGIN, LIST, EXAMINE, UID SEARCH (with Gmail's X-GM-RAW search), UID FETCH, LOGOUT.
import tls from 'node:tls';

export const quote = (s) => `"${String(s).replace(/[\\"]/g, (c) => `\\${c}`)}"`;

export class Imap {
  constructor({ host = 'imap.gmail.com', port = 993, connect } = {}) {
    this.host = host;
    this.port = port;
    this.connectFn = connect; // tests pass a fake socket factory
    this.buf = Buffer.alloc(0);
    this.n = 0;
    this.pending = null; // { tag, untagged, resolve, reject }
    this.greeting = null;
  }

  open(timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      const sock = this.connectFn ? this.connectFn() : tls.connect({ host: this.host, port: this.port, servername: this.host });
      this.sock = sock;
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('Tempo esgotado ao conectar no Gmail.')); }, timeoutMs);
      this.greeting = { resolve: () => { clearTimeout(timer); resolve(); }, reject };
      sock.setTimeout?.(60_000, () => sock.destroy(new Error('Conexão com o Gmail parada.')));
      sock.on('data', (d) => this.onData(d));
      sock.on('error', (e) => { clearTimeout(timer); this.fail(e); reject(e); });
      sock.on('close', () => this.fail(new Error('Conexão com o Gmail fechada.')));
    });
  }

  fail(err) {
    if (this.pending) { this.pending.reject(err); this.pending = null; }
  }

  // Splits the stream into responses; a response may carry literals ({n}\r\n<n bytes>).
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const unit = this.readUnit();
      if (!unit) return;
      this.dispatch(unit);
    }
  }

  readUnit() {
    let pos = 0;
    let text = '';
    const literals = [];
    for (;;) {
      const nl = this.buf.indexOf('\r\n', pos);
      if (nl < 0) return null;
      const line = this.buf.toString('latin1', pos, nl);
      const lit = line.match(/\{(\d+)\}$/);
      if (!lit) {
        text += line;
        this.buf = this.buf.subarray(nl + 2);
        return { text, literals };
      }
      const size = Number(lit[1]);
      const start = nl + 2;
      if (this.buf.length < start + size) return null;
      text += line;
      literals.push(this.buf.subarray(start, start + size));
      pos = start + size;
    }
  }

  dispatch(unit) {
    if (this.greeting) {
      const g = this.greeting;
      this.greeting = null;
      if (/^\* (OK|PREAUTH)/i.test(unit.text)) g.resolve(); else g.reject(new Error(`Gmail recusou a conexão: ${unit.text}`));
      return;
    }
    const p = this.pending;
    if (!p) return;
    if (unit.text.startsWith(`${p.tag} `)) {
      this.pending = null;
      const rest = unit.text.slice(p.tag.length + 1);
      if (/^OK/i.test(rest)) p.resolve(p.untagged);
      else p.reject(Object.assign(new Error(rest.replace(/^(NO|BAD)\s*/i, '')), { imap: rest }));
    } else if (unit.text.startsWith('*')) {
      p.untagged.push(unit);
    }
  }

  cmd(command) {
    if (this.pending) return Promise.reject(new Error('IMAP ocupado.'));
    const tag = `A${++this.n}`;
    return new Promise((resolve, reject) => {
      this.pending = { tag, untagged: [], resolve, reject };
      this.sock.write(`${tag} ${command}\r\n`);
    });
  }

  async login(user, pass) {
    try {
      await this.cmd(`LOGIN ${quote(user)} ${quote(pass)}`);
    } catch (e) {
      throw new Error(/AUTHENTICATIONFAILED|Invalid credentials/i.test(e.message)
        ? 'O Gmail recusou o login. Confira o e-mail e a senha de app.'
        : `Não consegui entrar no Gmail: ${e.message}`);
    }
  }

  // Gmail's "All Mail" folder has the \All attribute; its name depends on the language.
  async allMailbox() {
    const lines = await this.cmd('LIST "" "*"');
    for (const u of lines) {
      if (!/\\All\b/i.test(u.text)) continue;
      if (u.literals.length) return { raw: u.literals[0].toString('latin1') };
      const m = u.text.match(/\s("(?:[^"\\]|\\.)*"|\S+)$/);
      if (m) return { raw: m[1].startsWith('"') ? m[1].slice(1, -1).replace(/\\(.)/g, '$1') : m[1] };
    }
    return { raw: 'INBOX' };
  }

  async examine(name) {
    await this.cmd(`EXAMINE ${quote(name)}`);
  }

  async searchGmail(query) {
    const lines = await this.cmd(`UID SEARCH X-GM-RAW ${quote(query)}`);
    const ids = [];
    for (const u of lines) {
      const m = u.text.match(/^\* SEARCH\s*(.*)$/i);
      if (m && m[1].trim()) ids.push(...m[1].trim().split(/\s+/).map(Number));
    }
    return ids;
  }

  // Returns [{ uid, gmId, raw }] without marking anything as read (BODY.PEEK).
  async fetch(uids) {
    if (!uids.length) return [];
    const lines = await this.cmd(`UID FETCH ${uids.join(',')} (UID X-GM-MSGID BODY.PEEK[])`);
    return lines.filter((u) => /FETCH/i.test(u.text) && u.literals.length).map((u) => ({
      uid: Number(u.text.match(/UID (\d+)/i)?.[1]),
      gmId: u.text.match(/X-GM-MSGID (\d+)/i)?.[1] || null,
      raw: u.literals[0],
    }));
  }

  async close() {
    try { await this.cmd('LOGOUT'); } catch { /* already closed */ }
    this.sock?.end();
  }
}
