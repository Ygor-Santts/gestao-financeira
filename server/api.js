// REST API. Every route under /api except login needs the session cookie.
import { TYPES, DEFAULT_ACCOUNTS, DEFAULT_CARDS, getSetting, setSetting, tx } from './db.js';
import { preview, commit, undoImport } from './importer.js';
import { createReadStream, existsSync } from 'node:fs';
import { makeBackup, listBackups, backupPath } from './backup.js';
import { checkMail, mailConfigured, DEFAULT_SENDERS } from './mail/index.js';
import { now } from './clock.js';
import { matchBills, unlinkBills, applyGoal, createMonth, futureInstallments, budgetStatus, irReport, syncBill, syncIncome } from './features.js';

const round2 = (n) => Math.round((n || 0) * 100) / 100;
const MONTH = /^\d{4}-\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };

function monthRange(month) {
  if (!MONTH.test(month || '')) bad('Mês inválido.');
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [`${month}-01`, `${next}-01`];
}

const str = (v, max = 300) => (v == null ? null : String(v).trim().slice(0, max));
const money = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(/\./g, '').replace(',', '.')) : Number(v);
  if (!Number.isFinite(n)) bad('Valor inválido.');
  return round2(n);
};
const optDate = (v) => (v ? (DATE.test(v) ? v : bad('Data inválida.')) : null);

// ---------- summaries ----------
function totalsFor(db, from, to) {
  const rows = db.prepare('SELECT type, SUM(amount) AS s FROM transactions WHERE date >= ? AND date < ? GROUP BY type').all(from, to);
  const by = Object.fromEntries(rows.map((r) => [r.type, r.s || 0]));
  const entrou = round2(by.entrada || 0);
  const gastou = round2(-(by.saida || 0));
  return {
    entrou, gastou, sobrou: round2(entrou - gastou),
    caixinhas: round2(-(by.investimento || 0)), // + guardou / − tirou
    entreContas: round2(by.transferencia || 0),
  };
}

function overview(db, month) {
  const [from, to] = monthRange(month);
  const naConta = round2(db.prepare("SELECT SUM(value) s FROM assets WHERE kind = 'Conta'").get().s);
  const contas = db.prepare("SELECT id, name, account, value, updated FROM assets WHERE kind = 'Conta' ORDER BY value DESC").all();
  const goals = db.prepare('SELECT * FROM goals ORDER BY sort, id').all();
  const caixinhas = round2(goals.reduce((s, g) => s + g.current, 0));
  const outros = round2(db.prepare("SELECT SUM(value) s FROM assets WHERE kind <> 'Conta'").get().s);
  const bills = db.prepare('SELECT * FROM bills WHERE month = ? ORDER BY paid, due IS NULL, due, sort, id').all(month);
  const incomes = db.prepare('SELECT * FROM incomes WHERE month = ? ORDER BY received, expected IS NULL, expected, id').all(month);
  const faltaPagar = round2(bills.filter((b) => !b.paid).reduce((s, b) => s + b.amount, 0));
  const aReceber = round2(incomes.filter((i) => !i.received && !/alimenta/i.test(i.kind || '')).reduce((s, i) => s + i.amount, 0));
  const categorias = db.prepare(`SELECT t.category, -SUM(t.amount) AS total, COALESCE(c.color, '#a8a29e') AS color
      FROM transactions t LEFT JOIN categories c ON c.name = t.category
      WHERE t.type = 'saida' AND t.date >= ? AND t.date < ? GROUP BY t.category ORDER BY total DESC`).all(from, to)
    .map((c) => ({ ...c, total: round2(c.total) }));
  const pending = db.prepare("SELECT COUNT(*) n FROM transactions WHERE category = 'A confirmar' AND date >= ? AND date < ?").get(from, to).n;
  return {
    month,
    agora: { naConta, caixinhas, total: round2(naConta + caixinhas), contas },
    patrimonio: round2(naConta + caixinhas + outros),
    mes: totalsFor(db, from, to),
    previsao: { faltaPagar, aReceber, fimDoMes: round2(naConta - faltaPagar + aReceber) },
    goals, bills, incomes, categorias, aConfirmar: pending, limites: budgetStatus(db, month),
  };
}

function year(db, y) {
  if (!/^\d{4}$/.test(y || '')) bad('Ano inválido.');
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const mm = `${y}-${String(m).padStart(2, '0')}`;
    const [from, to] = monthRange(mm);
    const count = db.prepare('SELECT COUNT(*) n FROM transactions WHERE date >= ? AND date < ?').get(from, to).n;
    months.push({ month: mm, vazio: count === 0, ...totalsFor(db, from, to) });
  }
  const sum = (k) => round2(months.reduce((s, m) => s + m[k], 0));
  return { year: y, months, total: { entrou: sum('entrou'), gastou: sum('gastou'), sobrou: sum('sobrou'), caixinhas: sum('caixinhas') } };
}

// ---------- generic CRUD ----------
const TABLES = {
  goals: {
    cols: { name: str, current: money, target: money, monthly: money, sort: (v) => Number(v) || 0 },
    required: ['name'], order: 'sort, id', touch: true,
  },
  bills: {
    cols: { month: (v) => (MONTH.test(v) ? v : bad('Mês inválido.')), description: str, category: str, amount: money, due: optDate, paid: (v) => (v ? 1 : 0), sort: (v) => Number(v) || 0 },
    required: ['month', 'description'], order: 'paid, due IS NULL, due, sort, id', filter: 'month',
  },
  incomes: {
    cols: { month: (v) => (MONTH.test(v) ? v : bad('Mês inválido.')), description: str, kind: str, amount: money, expected: optDate, received: (v) => (v ? 1 : 0), note: str },
    required: ['month', 'description'], order: 'received, expected IS NULL, expected, id', filter: 'month',
  },
  assets: {
    cols: { name: str, kind: str, account: str, value: money, updated: optDate },
    required: ['name'], order: "kind = 'Conta' DESC, value DESC",
  },
};

function crud(db, table, method, id, body, query) {
  const t = TABLES[table];
  if (method === 'GET') {
    if ((table === 'bills' || table === 'incomes') && query.get('month')) {
      // With the statement line each one is linked to (date, and whether it is the bank's own line)
      return db.prepare(`SELECT x.*, tr.date AS tx_date, tr.origin AS tx_origin, tr.amount AS tx_amount
        FROM ${table} x LEFT JOIN transactions tr ON tr.id = x.tx_id WHERE x.month = ? ORDER BY ${t.order.split(', ').map((c) => `x.${c.replace(/^(\w+)/, '$1')}`).join(', ')}`).all(query.get('month'));
    }
    if (t.filter && query.get(t.filter)) {
      return db.prepare(`SELECT * FROM ${table} WHERE ${t.filter} = ? ORDER BY ${t.order}`).all(query.get(t.filter));
    }
    return db.prepare(`SELECT * FROM ${table} ORDER BY ${t.order}`).all();
  }
  if (method === 'DELETE') {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    return { ok: true };
  }
  const vals = {};
  for (const [k, fn] of Object.entries(t.cols)) if (body[k] !== undefined) vals[k] = fn(body[k]);
  if (method === 'POST') {
    for (const r of t.required) if (vals[r] == null || vals[r] === '') bad(`Preencha: ${r}.`);
    const keys = Object.keys(vals);
    const r = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => vals[k]));
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(r.lastInsertRowid);
  }
  if (method === 'PUT') {
    const keys = Object.keys(vals);
    if (keys.length) {
      const extra = t.touch ? ", updated_at = datetime('now')" : '';
      db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}${extra} WHERE id = ?`).run(...keys.map((k) => vals[k]), id);
    }
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  }
  throw new HttpError(405, 'Método não permitido.');
}

// ---------- transactions ----------
const goalFor = (type, goalId) => (type === 'investimento' && goalId ? Number(goalId) || null : null);
function txValues(body, partial) {
  const v = {};
  if (body.date !== undefined) v.date = DATE.test(body.date) ? body.date : bad('Data inválida.');
  if (body.description !== undefined) v.description = str(body.description) || bad('Descrição vazia.');
  if (body.amount !== undefined) v.amount = money(body.amount);
  if (body.type !== undefined) v.type = TYPES.includes(body.type) ? body.type : bad('Tipo inválido.');
  if (body.category !== undefined) v.category = str(body.category, 80) || 'A confirmar';
  if (body.account !== undefined) v.account = str(body.account, 60) || 'Nubank';
  if (body.note !== undefined) v.note = str(body.note, 1000);
  if (!partial) for (const k of ['date', 'description', 'amount', 'type']) if (v[k] == null) bad(`Preencha: ${k}.`);
  return v;
}

function listTransactions(db, q) {
  const where = [], args = [];
  if (q.get('month')) { const [a, b] = monthRange(q.get('month')); where.push('t.date >= ? AND t.date < ?'); args.push(a, b); }
  if (q.get('type')) { where.push('t.type = ?'); args.push(q.get('type')); }
  if (q.get('category')) { where.push('t.category = ?'); args.push(q.get('category')); }
  if (q.get('account')) { where.push('t.account = ?'); args.push(q.get('account')); }
  if (q.get('q')) { where.push('(t.description LIKE ? OR t.note LIKE ?)'); args.push(`%${q.get('q')}%`, `%${q.get('q')}%`); }
  const limit = Math.min(Number(q.get('limit')) || 500, 3000);
  // link_*: the bill or expected income (tela Contas) this line paid or received
  return db.prepare(`SELECT t.*, b.id AS bill_id, b.description AS bill_desc, b.month AS bill_month,
      i.id AS income_id, i.description AS income_desc, i.month AS income_month
    FROM transactions t LEFT JOIN bills b ON b.tx_id = t.id LEFT JOIN incomes i ON i.tx_id = t.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.date DESC, t.id DESC LIMIT ${limit}`).all(...args);
}

// ---------- cards ----------
function cards(db, q) {
  const invoices = db.prepare(`SELECT card, invoice, SUM(amount) AS total, COUNT(*) AS n FROM card_items
    GROUP BY card, invoice ORDER BY invoice DESC, card`).all().map((r) => ({ ...r, total: round2(r.total) }));
  const invoice = q.get('invoice') || invoices[0]?.invoice || null;
  const card = q.get('card') || null;
  const where = ['invoice = ?'], args = [invoice];
  if (card) { where.push('card = ?'); args.push(card); }
  const items = invoice ? db.prepare(`SELECT * FROM card_items WHERE ${where.join(' AND ')} ORDER BY date DESC, id DESC`).all(...args) : [];
  const categorias = {};
  for (const i of items) categorias[i.category] = round2((categorias[i.category] || 0) + i.amount);
  return {
    invoice, card, invoices, items,
    categorias: Object.entries(categorias).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total),
  };
}

// ---------- backup ----------
export function backup(db) {
  const all = (t) => db.prepare(`SELECT * FROM ${t}`).all();
  return {
    app: 'financas', version: 1, exported: new Date().toISOString(),
    settings: { owner_names: getSetting(db, 'owner_names', []), company_names: getSetting(db, 'company_names', []), acct_map: getSetting(db, 'acct_map', {}) },
    categories: all('categories'),
    transactions: all('transactions'), cards: all('card_items'), goals: all('goals'),
    bills: all('bills'), incomes: all('incomes'), assets: all('assets'), budgets: all('budgets'),
  };
}

function restore(db, data) {
  if (!data || data.app !== 'financas') bad('Arquivo de backup inválido.');
  return tx(db, () => {
    for (const t of ['transactions', 'card_items', 'goals', 'bills', 'incomes', 'assets', 'budgets']) db.exec(`DELETE FROM ${t}`);
    const n = {};
    const run = (sql, rows, map) => {
      const st = db.prepare(sql);
      for (const r of rows || []) st.run(...map(r));
      return (rows || []).length;
    };
    for (const c of data.categories || []) {
      db.prepare('INSERT INTO categories (name, grp, color) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET grp = excluded.grp, color = excluded.color').run(c.name, c.grp, c.color);
    }
    // Ids are kept so links (caixinha of a transaction, transaction that paid a bill) survive.
    n.transactions = run('INSERT INTO transactions (id, date, description, amount, type, category, account, ext_id, note, goal_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      data.transactions, (r) => [r.id ?? null, r.date, r.description, round2(r.amount), r.type, r.category || 'A confirmar', r.account || 'Nubank', r.ext_id || r.extId || null, r.note || null, r.goal_id ?? null]);
    n.cards = run('INSERT INTO card_items (card, invoice, date, description, amount, category, ext_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      data.cards, (r) => [r.card, r.invoice, r.date, r.description, round2(r.amount), r.category || 'A confirmar', r.ext_id || r.extId || null]);
    n.goals = run('INSERT INTO goals (id, name, current, target, monthly, sort) VALUES (?, ?, ?, ?, ?, ?)',
      data.goals, (r) => [r.id ?? null, r.name, r.current || 0, r.target || 0, r.monthly || 0, r.sort || 0]);
    n.bills = run('INSERT INTO bills (month, description, category, amount, due, paid, sort, tx_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      data.bills, (r) => [r.month, r.description, r.category || 'Contas fixas', r.amount || 0, r.due || null, r.paid ? 1 : 0, r.sort || 0, r.tx_id ?? null]);
    run('INSERT OR REPLACE INTO budgets (category, monthly) VALUES (?, ?)', data.budgets, (r) => [r.category, r.monthly]);
    n.incomes = run('INSERT INTO incomes (month, description, kind, amount, expected, received, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      data.incomes, (r) => [r.month, r.description, r.kind || null, r.amount || 0, r.expected || null, r.received ? 1 : 0, r.note || null]);
    n.assets = run('INSERT INTO assets (name, kind, account, value, updated) VALUES (?, ?, ?, ?, ?)',
      data.assets, (r) => [r.name, r.kind || 'Bem', r.account || null, r.value || 0, r.updated || null]);
    if (data.settings) for (const [k, v] of Object.entries(data.settings)) setSetting(db, k, v);
    return n;
  });
}

function nextMonth(db, from, to) {
  if (!MONTH.test(from) || !MONTH.test(to)) bad('Mês inválido.');
  const r = createMonth(db, from, to);
  if (r.exists) bad(`Já existem contas em ${to}.`);
  return r;
}

// ---------- router ----------
export function makeApi(db, auth, { push } = {}) {
  return async function handle(req, res, url, readBody, send) {
    const path = url.pathname.replace(/\/+$/, '');
    const m = req.method;
    const secure = req.headers['x-forwarded-proto'] === 'https';

    if (path === '/api/login' && m === 'POST') {
      const body = JSON.parse((await readBody(10_000)).toString() || '{}');
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
      const r = auth.checkPassword(ip, body.password);
      if (!r.ok) return send(401, { error: r.wait ? `Muitas tentativas. Espere ${r.wait}s.` : r.error || 'Senha incorreta.' });
      res.setHeader('Set-Cookie', auth.cookieFor(auth.newToken(), secure));
      return send(200, { ok: true });
    }
    if (path === '/api/logout' && m === 'POST') {
      res.setHeader('Set-Cookie', auth.cookieFor(null, secure));
      return send(200, { ok: true });
    }
    if (path === '/api/health') return send(200, { ok: true });
    if (!auth.session(req)) return send(401, { error: 'Entre com sua senha.' });

    const json = async () => JSON.parse((await readBody(30 * 1024 * 1024)).toString() || '{}');
    const q = url.searchParams;
    const seg = path.split('/').slice(2); // after /api
    const id = seg[1] && /^\d+$/.test(seg[1]) ? Number(seg[1]) : null;

    try {
      switch (seg[0]) {
        case 'me': return send(200, { ok: true });
        case 'meta': {
          const used = (col, table) => db.prepare(`SELECT DISTINCT ${col} AS v FROM ${table}`).all().map((r) => r.v);
          return send(200, {
            types: TYPES,
            categories: db.prepare('SELECT * FROM categories ORDER BY grp, name').all(),
            accounts: [...new Set([...DEFAULT_ACCOUNTS, ...used('account', 'transactions')])],
            cards: [...new Set([...DEFAULT_CARDS, ...used('card', 'card_items')])],
            billCategories: [...new Set(['Cartão', 'Apartamento', 'Contabilidade', 'Família', 'Educação', 'Contas fixas', 'Gastos extras', ...used('category', 'bills')])],
          });
        }
        case 'overview': return send(200, overview(db, q.get('month')));
        case 'year': return send(200, year(db, q.get('year')));
        case 'transactions': {
          if (m === 'GET') return send(200, listTransactions(db, q));
          if (m === 'POST') {
            const body = await json();
            const v = txValues(body, false);
            const goal = goalFor(v.type, body.goalId);
            const row = tx(db, () => {
              const r = db.prepare('INSERT INTO transactions (date, description, amount, type, category, account, note, goal_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .run(v.date, v.description, v.amount, v.type, v.category || 'A confirmar', v.account || 'Nubank', v.note || null, goal);
              const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(r.lastInsertRowid);
              applyGoal(db, t);
              return { ...t, paidBills: matchBills(db, [t.id]) };
            });
            return send(200, row);
          }
          if (!id) bad('Lançamento inválido.');
          if (m === 'PUT') {
            const body = await json();
            const v = txValues(body, true);
            const before = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
            if (!before) return send(404, { error: 'Lançamento não encontrado.' });
            if (body.goalId !== undefined || v.type) v.goal_id = goalFor(v.type || before.type, body.goalId !== undefined ? body.goalId : before.goal_id);
            const keys = Object.keys(v);
            tx(db, () => {
              applyGoal(db, before, -1); // undo the old effect on the caixinha, then apply the new one
              if (keys.length) db.prepare(`UPDATE transactions SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map((k) => v[k]), id);
              applyGoal(db, db.prepare('SELECT * FROM transactions WHERE id = ?').get(id));
            });
            // "Apply to similar": same description, still uncategorized
            if (body.applySimilar && v.category) {
              const t = db.prepare('SELECT description FROM transactions WHERE id = ?').get(id);
              db.prepare("UPDATE transactions SET category = ?, type = COALESCE(?, type) WHERE description = ? AND category = 'A confirmar'").run(v.category, v.type || null, t.description);
            }
            return send(200, db.prepare('SELECT * FROM transactions WHERE id = ?').get(id));
          }
          if (m === 'DELETE') {
            tx(db, () => {
              const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
              applyGoal(db, t, -1);
              unlinkBills(db, [id]); // its bill/income goes back to unpaid/not received
              db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
            });
            return send(200, { ok: true });
          }
          break;
        }
        case 'cards': {
          if (m === 'GET' && seg[1] === 'future') return send(200, futureInstallments(db));
          if (m === 'GET') return send(200, cards(db, q));
          if (m === 'POST') {
            const b = await json();
            if (!MONTH.test(b.invoice || '')) bad('Mês da fatura inválido.');
            const r = db.prepare('INSERT INTO card_items (card, invoice, date, description, amount, category) VALUES (?, ?, ?, ?, ?, ?)')
              .run(str(b.card, 40) || bad('Escolha o cartão.'), b.invoice, optDate(b.date) || bad('Data inválida.'), str(b.description) || bad('Descrição vazia.'), money(b.amount), str(b.category, 80) || 'A confirmar');
            return send(200, db.prepare('SELECT * FROM card_items WHERE id = ?').get(r.lastInsertRowid));
          }
          if (!id) bad('Item inválido.');
          if (m === 'PUT') {
            const b = await json();
            const v = {};
            if (b.category !== undefined) v.category = str(b.category, 80);
            if (b.description !== undefined) v.description = str(b.description);
            if (b.amount !== undefined) v.amount = money(b.amount);
            if (b.date !== undefined) v.date = optDate(b.date);
            if (b.invoice !== undefined) v.invoice = MONTH.test(b.invoice) ? b.invoice : bad('Mês inválido.');
            const keys = Object.keys(v);
            if (keys.length) db.prepare(`UPDATE card_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => v[k]), id);
            return send(200, db.prepare('SELECT * FROM card_items WHERE id = ?').get(id));
          }
          if (m === 'DELETE') { db.prepare('DELETE FROM card_items WHERE id = ?').run(id); return send(200, { ok: true }); }
          break;
        }
        case 'goals': case 'bills': case 'incomes': case 'assets': {
          if (seg[0] === 'bills' && seg[1] === 'next-month' && m === 'POST') {
            const b = await json();
            return send(200, nextMonth(db, b.from, b.to));
          }
          if ((m === 'PUT' || m === 'DELETE') && !id) bad('Item inválido.');
          // Bills and incomes keep the statement in step: paid/received ⇒ a line in Extrato.
          const sync = { bills: syncBill, incomes: syncIncome }[seg[0]];
          if (!sync || m === 'GET') return send(200, crud(db, seg[0], m, id, m === 'GET' || m === 'DELETE' ? {} : await json(), q));
          const before = id ? db.prepare(`SELECT * FROM ${seg[0]} WHERE id = ?`).get(id) : null;
          const out = crud(db, seg[0], m, id, m === 'DELETE' ? {} : await json(), q);
          const after = m === 'DELETE' ? null : db.prepare(`SELECT * FROM ${seg[0]} WHERE id = ?`).get(out.id);
          const extrato = sync(db, before, after);
          return send(200, { ...(after ? db.prepare(`SELECT * FROM ${seg[0]} WHERE id = ?`).get(out.id) : out), extrato });
        }
        case 'categories': {
          if (m === 'POST') {
            const b = await json();
            const name = str(b.name, 60) || bad('Nome vazio.');
            db.prepare('INSERT OR IGNORE INTO categories (name, grp, color) VALUES (?, ?, ?)').run(name, ['entrada', 'gasto', 'neutro'].includes(b.grp) ? b.grp : 'gasto', /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#a8a29e');
            return send(200, { ok: true });
          }
          break;
        }
        case 'import': {
          if (seg[1] === 'preview' && m === 'POST') {
            const buf = await readBody(15 * 1024 * 1024);
            const name = decodeURIComponent(req.headers['x-filename'] || 'arquivo');
            return send(200, await preview(db, buf, name));
          }
          if (seg[1] === 'commit' && m === 'POST') {
            const b = await json();
            const r = commit(db, b);
            if (b.inboxId) db.prepare("UPDATE inbox SET status = 'importado' WHERE id = ?").run(Number(b.inboxId));
            return send(200, r);
          }
          break;
        }
        case 'imports': {
          if (m === 'GET') return send(200, db.prepare('SELECT * FROM imports ORDER BY id DESC LIMIT 50').all());
          if (m === 'DELETE' && id) return send(200, undoImport(db, id));
          break;
        }
        case 'backup': {
          if (m === 'GET') {
            res.setHeader('Content-Disposition', `attachment; filename="financas-backup-${new Date().toISOString().slice(0, 10)}.json"`);
            return send(200, backup(db));
          }
          if (seg[1] === 'restore' && m === 'POST') return send(200, restore(db, await json()));
          break;
        }
        case 'budgets': {
          if (m === 'GET') return send(200, budgetStatus(db, MONTH.test(q.get('month') || '') ? q.get('month') : now().month));
          if (m === 'PUT') {
            const b = await json();
            const cat = str(b.category, 80) || bad('Escolha a categoria.');
            const v = money(b.monthly || 0);
            if (v > 0) db.prepare('INSERT INTO budgets (category, monthly) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET monthly = excluded.monthly').run(cat, v);
            else db.prepare('DELETE FROM budgets WHERE category = ?').run(cat);
            return send(200, { ok: true });
          }
          break;
        }
        case 'ir': {
          if (m === 'GET') {
            const y = q.get('year') || String(new Date().getFullYear());
            if (!/^\d{4}$/.test(y)) bad('Ano inválido.');
            return send(200, irReport(db, y));
          }
          break;
        }
        case 'settings': {
          if (m === 'GET') {
            return send(200, {
              owner_names: getSetting(db, 'owner_names', []), company_names: getSetting(db, 'company_names', []),
              mail_senders: getSetting(db, 'mail_senders', DEFAULT_SENDERS),
              pdf_passwords: getSetting(db, 'pdf_passwords', []).length, // only how many, never the passwords
            });
          }
          if (m === 'PUT') {
            const b = await json();
            const list = (v, max = 100) => v.map((x) => str(x, max)).filter(Boolean);
            for (const k of ['owner_names', 'company_names', 'mail_senders']) if (Array.isArray(b[k])) setSetting(db, k, list(b[k]));
            if (Array.isArray(b.pdf_passwords_add)) {
              const cur = getSetting(db, 'pdf_passwords', []);
              setSetting(db, 'pdf_passwords', [...new Set([...cur, ...list(b.pdf_passwords_add, 64)])]);
            }
            if (b.pdf_passwords_clear) setSetting(db, 'pdf_passwords', []);
            return send(200, { ok: true });
          }
          break;
        }
        case 'backups': {
          if (m === 'GET' && !seg[1]) return send(200, { files: listBackups(), last: getSetting(db, 'job_backup') });
          if (m === 'POST' && seg[1] === 'now') return send(200, makeBackup(db));
          if (m === 'GET' && seg[1]) {
            const file = backupPath(decodeURIComponent(seg[1]));
            if (!file || !existsSync(file)) return send(404, { error: 'Backup não encontrado.' });
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="${seg[1]}"`);
            res.setHeader('Cache-Control', 'no-store');
            createReadStream(file).pipe(res);
            return undefined;
          }
          break;
        }
        case 'inbox': {
          if (m === 'GET' && !seg[1]) {
            const items = db.prepare(`SELECT id, sender, subject, received, filename, status, summary, created_at FROM inbox
              ORDER BY status = 'novo' DESC, COALESCE(received, created_at) DESC LIMIT 40`).all()
              .map((r) => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null }));
            return send(200, { configured: mailConfigured(), status: getSetting(db, 'mail_status'), items });
          }
          if (!id) bad('Item inválido.');
          const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(id);
          if (!row) return send(404, { error: 'Não encontrado.' });
          if (m === 'POST' && seg[2] === 'preview') {
            const p = await preview(db, Buffer.from(row.data), row.filename);
            return send(200, { ...p, inboxId: id });
          }
          if (m === 'POST' && seg[2] === 'discard') {
            db.prepare("UPDATE inbox SET status = 'descartado' WHERE id = ?").run(id);
            return send(200, { ok: true });
          }
          break;
        }
        case 'mail': {
          if (m === 'POST' && seg[1] === 'check') {
            if (!mailConfigured()) bad('Gmail não configurado. Veja o README (GMAIL_EMAIL e GMAIL_SENHA_APP no .env).');
            try {
              const r = await checkMail(db);
              return send(200, { added: r.added.length });
            } catch (e) { bad(e.message); }
          }
          break;
        }
        case 'push': {
          if (!push) bad('Avisos indisponíveis.');
          if (m === 'GET' && seg[1] === 'key') return send(200, { publicKey: push.publicKey, devices: push.count() });
          if (m === 'POST' && seg[1] === 'subscribe') { const b = await json(); push.subscribe(b.subscription, b.device); return send(200, { ok: true, devices: push.count() }); }
          if (m === 'POST' && seg[1] === 'unsubscribe') { const b = await json(); push.unsubscribe(String(b.endpoint || '')); return send(200, { ok: true, devices: push.count() }); }
          if (m === 'POST' && seg[1] === 'test') {
            const n = await push.notify({ title: 'Avisos ligados', body: 'É assim que os avisos de contas e extratos vão chegar.', url: '/#/', tag: 'teste' });
            return send(200, { sent: n });
          }
          break;
        }
        default: break;
      }
      return send(404, { error: 'Não encontrado.' });
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      if (e instanceof SyntaxError) return send(400, { error: 'JSON inválido.' });
      if (e.status === 400 || /Não |Este PDF|Formato|CSV|Escolha/.test(e.message)) return send(400, { error: e.message });
      console.error(e);
      return send(500, { error: 'Erro interno.' });
    }
  };
}
