// Things the app does on its own, checked once a minute:
// 03:00 backup · every 30 min Gmail · 09:00 bill reminders · day 1 month summary.
import { getSetting, setSetting } from './db.js';
import { now, addDays, prevMonth } from './clock.js';
import { makeBackup } from './backup.js';
import { checkMail, mailConfigured } from './mail/index.js';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function billReminder(db, today) {
  const soon = addDays(today, 2);
  const month = today.slice(0, 7);
  const rows = db.prepare(`SELECT description, amount, due FROM bills
    WHERE paid = 0 AND due IS NOT NULL AND due <= ? AND (due >= ? OR month = ?) ORDER BY due`).all(soon, today, month);
  if (!rows.length) return null;
  const late = rows.filter((r) => r.due < today);
  const dueToday = rows.filter((r) => r.due === today);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  let title;
  if (late.length) title = `${plural(late.length, 'conta atrasada', 'contas atrasadas')}`;
  else if (dueToday.length) title = `${plural(dueToday.length, 'conta vence', 'contas vencem')} hoje`;
  else title = `${plural(rows.length, 'conta vence', 'contas vencem')} nos próximos 2 dias`;
  const when = (d) => (d < today ? 'atrasada' : d === today ? 'hoje' : d === addDays(today, 1) ? 'amanhã' : `dia ${d.slice(8, 10)}`);
  const body = rows.slice(0, 4).map((r) => `${r.description}: ${brl.format(r.amount)} (${when(r.due)})`).join('\n')
    + (rows.length > 4 ? `\n+ ${rows.length - 4} outras. Total ${brl.format(total)}` : '');
  return { title, body, url: '/#/contas', tag: `contas-${today}` };
}

export function monthSummary(db, month) {
  const from = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const rows = db.prepare('SELECT type, SUM(amount) s FROM transactions WHERE date >= ? AND date < ? GROUP BY type').all(from, to);
  const by = Object.fromEntries(rows.map((r) => [r.type, r.s || 0]));
  if (!rows.length) return null;
  const entrou = by.entrada || 0, gastou = -(by.saida || 0), caixinhas = -(by.investimento || 0);
  const nome = MONTHS[m - 1];
  const diff = entrou - gastou;
  const title = diff >= 0 ? `${nome[0].toUpperCase() + nome.slice(1)} fechou com sobra de ${brl.format(diff)}` : `${nome[0].toUpperCase() + nome.slice(1)} fechou gastando ${brl.format(-diff)} a mais do que entrou`;
  const body = `Entrou ${brl.format(entrou)}, gastou ${brl.format(gastou)}. `
    + (caixinhas >= 0 ? `Guardou ${brl.format(caixinhas)} nas caixinhas.` : `Tirou ${brl.format(-caixinhas)} das caixinhas.`);
  return { title, body, url: '/#/ano', tag: `mes-${month}` };
}

export function startJobs(db, push, { intervalMs = 60_000 } = {}) {
  let running = false;
  const once = (key, value) => {
    if (getSetting(db, key) === value) return false;
    setSetting(db, key, value);
    return true;
  };

  async function tick() {
    if (running) return;
    running = true;
    const t = now();
    try {
      if (t.hour >= 3 && once('job_backup', t.date)) {
        try { makeBackup(db); } catch (e) { console.error('Backup automático falhou:', e.message); setSetting(db, 'job_backup', null); }
      }
      if (mailConfigured()) {
        const last = getSetting(db, 'job_mail_at', 0);
        if (Date.now() - last >= 30 * 60_000) {
          setSetting(db, 'job_mail_at', Date.now());
          try {
            const r = await checkMail(db);
            for (const a of r.added || []) {
              await push.notify({
                title: 'Extrato novo para conferir',
                body: `${a.filename}: ${plural(a.novos, 'lançamento novo', 'lançamentos novos')}${a.account ? ` (${a.account})` : ''}.`,
                url: '/#/importar', tag: `inbox-${a.id}`,
              });
            }
          } catch (e) { console.warn('Gmail:', e.message); }
        }
      }
      if (t.hour >= 9 && once('job_reminder', t.date)) {
        const msg = billReminder(db, t.date);
        if (msg) await push.notify(msg);
      }
      if (t.day === 1 && t.hour >= 9 && once('job_month', t.month)) {
        const msg = monthSummary(db, prevMonth(t.month));
        if (msg) await push.notify(msg);
      }
    } finally {
      running = false;
    }
  }

  setTimeout(tick, 5_000);
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}
