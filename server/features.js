// Automations on top of the data: bills paid by the statement, card installments still
// to come, category limits, caixinhas moved by the statement and the income tax summary.
import { tx, getSetting } from './db.js';
import { now } from './clock.js';

const round2 = (n) => Math.round((n || 0) * 100) / 100;
const addMonth = (ym, n = 1) => {
  let [y, m] = ym.split('-').map(Number);
  m += n;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---------- 1. bills paid by the statement ----------
const CARD_BANKS = [
  ['Nubank', /nubank|nu pagamentos/],
  ['Santander', /santander|sx master/],
  ['Caixa', /caixa/],
];

function bankOf(text) {
  const t = norm(text);
  return CARD_BANKS.find(([, re]) => re.test(t))?.[0] || null;
}

// Links the money that left the account to the bill it paid. Returns the bills marked as paid.
export function matchBills(db, txIds) {
  if (!txIds.length) return [];
  const paid = [];
  const used = new Set();
  const txs = db.prepare(`SELECT * FROM transactions WHERE id IN (${txIds.map(() => '?').join(',')}) AND type = 'saida' AND amount < 0 ORDER BY date`).all(...txIds);
  for (const t of txs) {
    const value = -t.amount;
    const month = t.date.slice(0, 7);
    const bills = db.prepare(`SELECT * FROM bills WHERE paid = 0 AND (month = ? OR month = ? OR (due IS NOT NULL AND due BETWEEN date(?, '-10 days') AND date(?, '+15 days')))`)
      .all(month, addMonth(month), t.date, t.date).filter((b) => !used.has(b.id));
    const byDue = (a, b) => Math.abs(Date.parse(a.due || `${a.month}-15`) - Date.parse(t.date)) - Math.abs(Date.parse(b.due || `${b.month}-15`) - Date.parse(t.date));
    // Same value: the clearest sign. Prefer the bill of the same month, then the closest due date.
    let hit = bills.filter((b) => Math.abs(b.amount - value) <= 0.05).sort((a, b) => (a.month === month ? -1 : 0) - (b.month === month ? -1 : 0) || byDue(a, b))[0];
    let fromCard = false;
    if (!hit && t.category === 'Cartões de crédito') {
      // Card bill: amounts are estimates, so match by bank instead.
      const bank = bankOf(t.description) || (/pagamento de fatura/.test(norm(t.description)) ? t.account : null);
      hit = bank && bills.filter((b) => b.category === 'Cartão' && bankOf(b.description) === bank).sort(byDue)[0];
      fromCard = !!hit;
    }
    if (!hit) continue;
    used.add(hit.id);
    db.prepare('UPDATE bills SET paid = 1, tx_id = ?, amount = ? WHERE id = ?').run(t.id, fromCard ? round2(value) : hit.amount, hit.id);
    paid.push({ id: hit.id, description: hit.description, month: hit.month, amount: fromCard ? round2(value) : hit.amount });
  }
  return paid;
}

// When a payment is deleted (or its import undone) its bill goes back to unpaid,
// and an income goes back to "not received".
export function unlinkBills(db, txIds) {
  if (!txIds.length) return;
  const q = txIds.map(() => '?').join(',');
  db.prepare(`UPDATE bills SET paid = 0, tx_id = NULL WHERE tx_id IN (${q})`).run(...txIds);
  db.prepare(`UPDATE incomes SET received = 0, tx_id = NULL WHERE tx_id IN (${q})`).run(...txIds);
}

// ---------- Contas ↔ Extrato ----------
// Marking a bill as paid (or an income as received) puts it in the statement. If the
// statement already has that money, it is linked instead of added twice.
const BILL_CAT = { Cartão: 'Cartões de crédito', Apartamento: 'Moradia', Contabilidade: 'Contabilidade', Família: 'Família', Pai: 'Família', Educação: 'Educação', 'Gastos extras': 'Compras', 'Contas fixas': 'Outros gastos' };
const INCOME_CAT = { 'Salário PJ': 'Salário PJ', 'Salário CLT': 'Salário CLT' };

function dateFor(month, ref) {
  const today = now().date;
  if (today.startsWith(month)) return ref && ref.startsWith(month) && ref <= today ? ref : today;
  if (ref && ref.startsWith(month)) return ref;
  const last = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
  return month < today.slice(0, 7) ? `${month}-${last}` : `${month}-01`;
}

function findExisting(db, { type, value, month, bank, linkedCol }) {
  const sign = type === 'entrada' ? 1 : -1;
  const rows = db.prepare(`SELECT * FROM transactions WHERE type = ? AND date BETWEEN date(?, '-10 days') AND date(?, '+10 days')
      AND id NOT IN (SELECT tx_id FROM bills WHERE tx_id IS NOT NULL) AND id NOT IN (SELECT tx_id FROM incomes WHERE tx_id IS NOT NULL)
      ORDER BY date`).all(type, `${month}-01`, `${month}-28`);
  return rows.find((t) => Math.abs(t.amount - sign * value) <= 0.05)
    || (bank && rows.find((t) => t.category === 'Cartões de crédito' && (bankOf(t.description) || (/pagamento de fatura/.test(norm(t.description)) ? t.account : null)) === bank))
    || null;
}

function addProvisional(db, { date, description, amount, type, category }) {
  const r = db.prepare("INSERT INTO transactions (date, description, amount, type, category, account, origin, note) VALUES (?, ?, ?, ?, ?, ?, 'previsto', ?)")
    .run(date, description, round2(amount), type, category, getSetting(db, 'conta_padrao', 'Nubank'), 'Lançado pela tela Contas; troca sozinho pelo lançamento do banco quando você importar o extrato.');
  return Number(r.lastInsertRowid);
}

function dropLinked(db, txId) {
  if (!txId) return null;
  const t = db.prepare('SELECT origin FROM transactions WHERE id = ?').get(txId);
  if (t?.origin === 'previsto') { db.prepare('DELETE FROM transactions WHERE id = ?').run(txId); return 'removido'; }
  return 'desligado';
}

// before/after: the bill row before and after the change. Returns what happened in the statement.
export function syncBill(db, before, after) {
  return tx(db, () => {
    if (!after) return dropLinked(db, before?.tx_id); // bill deleted
    if (after.paid && !before?.paid) {
      if (after.tx_id) return null;
      const bank = after.category === 'Cartão' ? bankOf(after.description) : null;
      const found = findExisting(db, { type: 'saida', value: after.amount, month: after.month, bank });
      const id = found ? found.id : addProvisional(db, {
        date: dateFor(after.month, after.due), description: after.description, amount: -after.amount, type: 'saida', category: BILL_CAT[after.category] || 'Outros gastos',
      });
      db.prepare('UPDATE bills SET tx_id = ? WHERE id = ?').run(id, after.id);
      return found ? 'ligado' : 'lancado';
    }
    if (!after.paid && before?.paid) {
      const r = dropLinked(db, after.tx_id);
      db.prepare('UPDATE bills SET tx_id = NULL WHERE id = ?').run(after.id);
      return r;
    }
    if (after.paid && after.tx_id) {
      // Keep a provisional line in step with the bill's value and name.
      db.prepare("UPDATE transactions SET amount = ?, description = ? WHERE id = ? AND origin = 'previsto'").run(-round2(after.amount), after.description, after.tx_id);
    }
    return null;
  });
}

export function syncIncome(db, before, after) {
  return tx(db, () => {
    if (!after) return dropLinked(db, before?.tx_id);
    if (/alimenta/i.test(after.kind || '')) return null; // benefit card: never enters the account
    if (after.received && !before?.received) {
      if (after.tx_id || !after.amount) return null;
      const found = findExisting(db, { type: 'entrada', value: after.amount, month: after.month });
      const id = found ? found.id : addProvisional(db, {
        date: dateFor(after.month, after.expected), description: after.description, amount: after.amount, type: 'entrada', category: INCOME_CAT[after.kind] || 'Outros recebimentos',
      });
      db.prepare('UPDATE incomes SET tx_id = ? WHERE id = ?').run(id, after.id);
      return found ? 'ligado' : 'lancado';
    }
    if (!after.received && before?.received) {
      const r = dropLinked(db, after.tx_id);
      db.prepare('UPDATE incomes SET tx_id = NULL WHERE id = ?').run(after.id);
      return r;
    }
    if (after.received && after.tx_id) {
      db.prepare("UPDATE transactions SET amount = ?, description = ? WHERE id = ? AND origin = 'previsto'").run(round2(after.amount), after.description, after.tx_id);
    }
    return null;
  });
}

// Imported bank lines take the place of provisional ones with the same value (±12 days).
export function replaceProvisional(db, txIds) {
  let replaced = 0;
  for (const id of txIds) {
    const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!t) continue;
    const p = db.prepare(`SELECT * FROM transactions WHERE origin = 'previsto' AND type = ? AND abs(amount - ?) <= 0.05
      AND date BETWEEN date(?, '-12 days') AND date(?, '+12 days') ORDER BY abs(julianday(date) - julianday(?)) LIMIT 1`).get(t.type, t.amount, t.date, t.date, t.date);
    if (!p) continue;
    db.prepare('UPDATE bills SET tx_id = ? WHERE tx_id = ?').run(id, p.id);
    db.prepare('UPDATE incomes SET tx_id = ? WHERE tx_id = ?').run(id, p.id);
    db.prepare('DELETE FROM transactions WHERE id = ?').run(p.id);
    replaced++;
  }
  return replaced;
}

// Bills for a new month from the previous one. One-off "Gastos extras" are not repeated;
// card bills use the installments already committed when they are higher than last month.
export function createMonth(db, from, to) {
  return tx(db, () => {
    if (db.prepare('SELECT COUNT(*) n FROM bills WHERE month = ?').get(to).n) return { bills: 0, exists: true };
    const shift = (d) => {
      if (!d) return null;
      const day = Number(d.slice(8, 10));
      const last = new Date(Date.UTC(+to.slice(0, 4), +to.slice(5, 7), 0)).getUTCDate();
      return `${to}-${String(Math.min(day, last)).padStart(2, '0')}`;
    };
    const committed = Object.fromEntries(futureInstallments(db).filter((f) => f.invoice === to).map((f) => [f.card, f.total]));
    const bills = db.prepare("SELECT * FROM bills WHERE month = ? AND category <> 'Gastos extras' ORDER BY sort, id").all(from);
    const ins = db.prepare('INSERT INTO bills (month, description, category, amount, due, paid, sort) VALUES (?, ?, ?, ?, ?, 0, ?)');
    for (const b of bills) {
      let amount = b.amount;
      const bank = b.category === 'Cartão' ? bankOf(b.description) : null;
      if (bank && committed[bank] > amount) amount = committed[bank];
      ins.run(to, b.description, b.category, round2(amount), shift(b.due), b.sort);
    }
    if (!db.prepare('SELECT COUNT(*) n FROM incomes WHERE month = ?').get(to).n) {
      const insI = db.prepare('INSERT INTO incomes (month, description, kind, amount, expected, received) VALUES (?, ?, ?, ?, ?, 0)');
      for (const i of db.prepare('SELECT * FROM incomes WHERE month = ?').all(from)) insI.run(to, i.description, i.kind, i.amount, shift(i.expected));
    }
    return { bills: bills.length };
  });
}

// ---------- 2. card installments ----------
// "LOJA 03/06", "Loja - Parcela 3/6", "PARC 03 DE 06"
export function parseInstallment(desc) {
  const m = String(desc).match(/(?:parcela|parc\.?)?\s*\b(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\b(?!\s*\/)/i);
  if (!m) return null;
  const k = Number(m[1]), n = Number(m[2]);
  if (n < 2 || n > 48 || k < 1 || k > n) return null;
  return { k, n, base: String(desc).replace(m[0], '').replace(/\s*-\s*$/, '').replace(/\s{2,}/g, ' ').trim() };
}

// Installments that will still show up in the next bills, per card and month.
// Only months after the last bill already imported for that card count.
export function futureInstallments(db) {
  const last = Object.fromEntries(db.prepare('SELECT card, MAX(invoice) inv FROM card_items GROUP BY card').all().map((r) => [r.card, r.inv]));
  const out = new Map();
  for (const it of db.prepare('SELECT card, invoice, description, amount, category FROM card_items WHERE amount > 0').all()) {
    if (it.invoice !== last[it.card]) continue; // the newest bill of each card has the latest installment numbers
    const p = parseInstallment(it.description);
    if (!p || p.k >= p.n) continue;
    for (let j = 1; j <= p.n - p.k; j++) {
      const invoice = addMonth(it.invoice, j);
      const key = `${it.card}|${invoice}`;
      const e = out.get(key) || { card: it.card, invoice, total: 0, items: [] };
      e.total = round2(e.total + it.amount);
      e.items.push({ description: p.base || it.description, amount: it.amount, parcela: `${p.k + j}/${p.n}`, category: it.category });
      out.set(key, e);
    }
  }
  return [...out.values()].sort((a, b) => (a.invoice === b.invoice ? a.card.localeCompare(b.card) : a.invoice < b.invoice ? -1 : 1));
}

// ---------- 3. category limits ----------
export function budgetStatus(db, month) {
  const [y, m] = month.split('-').map(Number);
  const from = `${month}-01`;
  const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const spent = Object.fromEntries(db.prepare(`SELECT category, -SUM(amount) s FROM transactions
    WHERE type = 'saida' AND date >= ? AND date < ? GROUP BY category`).all(from, to).map((r) => [r.category, r.s]));
  // Card purchases of the bill due this month count in their own categories, so a limit
  // for Alimentação also sees what was bought on the card.
  const card = Object.fromEntries(db.prepare('SELECT category, SUM(amount) s FROM card_items WHERE invoice = ? GROUP BY category').all(month).map((r) => [r.category, r.s]));
  return db.prepare('SELECT * FROM budgets ORDER BY category').all().map((b) => {
    const used = round2((spent[b.category] || 0) + (card[b.category] || 0));
    return { category: b.category, monthly: b.monthly, used, pct: b.monthly ? used / b.monthly : 0 };
  });
}

// ---------- 4. caixinhas moved by the statement ----------
// An application (money leaving the account, negative) adds to the caixinha; a withdrawal subtracts.
const goalDelta = (t) => (t && t.type === 'investimento' && t.goal_id ? -t.amount : 0);

export function applyGoal(db, t, sign = 1) {
  const d = goalDelta(t);
  if (d) db.prepare("UPDATE goals SET current = round(current + ?, 2), updated_at = datetime('now') WHERE id = ?").run(sign * d, t.goal_id);
}

// ---------- 5. income tax summary ----------
export function irReport(db, year) {
  const from = `${year}-01-01`, to = `${Number(year) + 1}-01-01`;
  const rendimentos = db.prepare(`SELECT category, SUM(amount) total, COUNT(*) n FROM transactions
    WHERE type = 'entrada' AND date >= ? AND date < ? GROUP BY category ORDER BY total DESC`).all(from, to)
    .map((r) => ({ ...r, total: round2(r.total) }));
  const porMes = db.prepare(`SELECT substr(date, 1, 7) month, category, SUM(amount) total FROM transactions
    WHERE type = 'entrada' AND date >= ? AND date < ? GROUP BY 1, 2 ORDER BY 1`).all(from, to).map((r) => ({ ...r, total: round2(r.total) }));
  const deducao = (cat) => {
    const conta = db.prepare(`SELECT date, description, -amount amount, 'conta' origem FROM transactions
      WHERE type = 'saida' AND category = ? AND date >= ? AND date < ?`).all(cat, from, to);
    const cartao = db.prepare(`SELECT date, description, amount, 'cartão ' || card origem FROM card_items
      WHERE category = ? AND date >= ? AND date < ? AND amount > 0`).all(cat, from, to);
    const itens = [...conta, ...cartao].map((i) => ({ ...i, amount: round2(i.amount) })).sort((a, b) => (a.date < b.date ? -1 : 1));
    return { total: round2(itens.reduce((s, i) => s + i.amount, 0)), itens };
  };
  const assets = db.prepare('SELECT name, kind, value, updated FROM assets ORDER BY value DESC').all();
  const goals = db.prepare('SELECT name, current FROM goals ORDER BY sort, id').all();
  return {
    year: String(year),
    rendimentos, porMes,
    saude: deducao('Saúde'),
    educacao: deducao('Educação'),
    bens: [...assets.filter((a) => a.kind !== 'Dívida').map((a) => ({ name: a.name, value: a.value, updated: a.updated })),
      ...goals.map((g) => ({ name: `Caixinha: ${g.name}`, value: g.current, updated: null }))],
    dividas: assets.filter((a) => a.kind === 'Dívida').map((a) => ({ name: a.name, value: -a.value, updated: a.updated })),
  };
}
