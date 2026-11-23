// Phone notifications: subscriptions per device and sending to all of them.
import { getSetting, setSetting } from '../db.js';
import { newVapidKeys, sendPush } from './webpush.js';

export function initPush(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, device TEXT,
    created_at TEXT DEFAULT (datetime('now')))`);
  let vapid = getSetting(db, 'vapid');
  if (!vapid) {
    vapid = newVapidKeys();
    setSetting(db, 'vapid', vapid);
  }
  const subject = `mailto:${process.env.GMAIL_EMAIL || 'financas@localhost'}`;

  function subscribe(sub, device) {
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
      throw Object.assign(new Error('Inscrição de aviso inválida.'), { status: 400 });
    }
    db.prepare(`INSERT INTO push_subs (endpoint, p256dh, auth, device) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device`)
      .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(device || '').slice(0, 120));
  }

  function unsubscribe(endpoint) {
    db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
  }

  const count = () => db.prepare('SELECT COUNT(*) n FROM push_subs').get().n;

  // message: { title, body, url, tag }
  async function notify(message) {
    const subs = db.prepare('SELECT * FROM push_subs').all();
    let sent = 0;
    for (const s of subs) {
      try {
        const r = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, message, vapid, subject);
        if (r.gone) unsubscribe(s.endpoint);
        else if (r.ok) sent++;
        else console.warn(`Aviso não entregue (${r.status}) para ${new URL(s.endpoint).host}`);
      } catch (e) {
        console.warn('Falha ao enviar aviso:', e.message);
      }
    }
    return sent;
  }

  return { publicKey: vapid.publicKey, subscribe, unsubscribe, notify, count };
}
