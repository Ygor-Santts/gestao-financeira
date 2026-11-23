// Fetches statements from Gmail: e-mails from the configured senders (and the ones
// you send to yourself) that carry OFX, CSV or PDF. They wait in the import screen
// until you check and confirm them.
import { Imap } from './imap.js';
import { parseMail } from './mime.js';
import { getSetting, setSetting } from '../db.js';
import { preview } from '../importer.js';

export const DEFAULT_SENDERS = ['todomundo@nubank.com.br', 'me'];
const EXT = /\.(ofx|csv|pdf)$/i;
const PREFER = { ofx: 0, csv: 1, pdf: 2 };

export function initMail(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY, gm_id TEXT NOT NULL, sender TEXT, subject TEXT, received TEXT,
    filename TEXT NOT NULL, data BLOB NOT NULL, status TEXT NOT NULL DEFAULT 'novo',
    summary TEXT, created_at TEXT DEFAULT (datetime('now')),
    UNIQUE (gm_id, filename))`);
  db.exec('CREATE TABLE IF NOT EXISTS mail_seen (gm_id TEXT PRIMARY KEY, seen_at TEXT DEFAULT (datetime(\'now\')))');
}

export const mailConfigured = () => !!(process.env.GMAIL_EMAIL && process.env.GMAIL_SENHA_APP);

export function buildQuery(senders, days = 45) {
  const from = senders.map((s) => (s === 'me' ? '(from:me to:me)' : `from:${s}`)).join(' OR ');
  return `has:attachment newer_than:${days}d {filename:ofx filename:csv filename:pdf} (${from})`;
}

// One attachment per e-mail: OFX is the most precise, then CSV, then PDF.
export function pickAttachment(atts) {
  return atts
    .filter((a) => EXT.test(a.filename) || /pdf|ofx/.test(a.contentType))
    .sort((a, b) => (PREFER[ext(a)] ?? 9) - (PREFER[ext(b)] ?? 9))[0] || null;
}
const ext = (a) => (a.filename.match(EXT)?.[1] || (/pdf/.test(a.contentType) ? 'pdf' : '')).toLowerCase();

export async function checkMail(db, { imapFactory } = {}) {
  if (!mailConfigured() && !imapFactory) return { skipped: true };
  const senders = getSetting(db, 'mail_senders', DEFAULT_SENDERS);
  const imap = imapFactory ? imapFactory() : new Imap();
  const added = [];
  try {
    await imap.open();
    await imap.login(process.env.GMAIL_EMAIL, String(process.env.GMAIL_SENHA_APP || '').replace(/\s+/g, ''));
    const box = await imap.allMailbox();
    await imap.examine(box.raw);
    const uids = await imap.searchGmail(buildQuery(senders));
    // Fetch in small groups so a mailbox with many matches does not use much memory.
    const seen = db.prepare('SELECT 1 FROM mail_seen WHERE gm_id = ?');
    const toFetch = uids.slice(-60);
    for (let i = 0; i < toFetch.length; i += 10) {
      const msgs = await imap.fetch(toFetch.slice(i, i + 10));
      for (const m of msgs) {
        const id = m.gmId || `uid-${m.uid}`;
        if (seen.get(id)) continue;
        const mail = parseMail(m.raw);
        const att = pickAttachment(mail.attachments);
        if (att) {
          let summary = null;
          try {
            const p = await preview(db, att.data, att.filename);
            const fresh = p.items.filter((it) => !it.duplicate);
            summary = { kind: p.kind, account: p.account, total: p.items.length, novos: fresh.length, invoice: p.invoice };
          } catch (e) {
            summary = { error: e.message };
          }
          const status = summary.error ? 'erro' : summary.novos === 0 ? 'sem novidades' : 'novo';
          const r = db.prepare(`INSERT OR IGNORE INTO inbox (gm_id, sender, subject, received, filename, data, status, summary)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, mail.from, mail.subject, mail.date ? mail.date.toISOString() : null,
            att.filename, att.data, status, JSON.stringify(summary));
          if (r.changes && status === 'novo') added.push({ id: Number(r.lastInsertRowid), filename: att.filename, ...summary });
        }
        db.prepare('INSERT OR IGNORE INTO mail_seen (gm_id) VALUES (?)').run(id);
      }
    }
    setSetting(db, 'mail_status', { at: new Date().toISOString(), ok: true, found: uids.length, added: added.length });
    return { added };
  } catch (e) {
    setSetting(db, 'mail_status', { at: new Date().toISOString(), ok: false, error: e.message });
    throw e;
  } finally {
    imap.close().catch(() => {});
  }
}
