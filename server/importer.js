// Statement import: read the file, suggest type/category, flag lines already in the
// database, then save what the person confirmed.
import { decodeText, looksLikeOfx, parseOfx, bankFromOfx } from './importers/ofx.js';
import { parseCsv } from './importers/csv.js';
import { pdfToText, parsePdfText } from './importers/pdf.js';
import { buildHistory, classifyAccountLine, classifyCardLine } from './importers/classify.js';
import { getSetting, setSetting, tx } from './db.js';
import { matchBills, unlinkBills, applyGoal, replaceProvisional } from './features.js';

const round2 = (n) => Math.round(n * 100) / 100;

async function readFile(buf, filename, passwords = []) {
  const name = (filename || '').toLowerCase();
  const head = buf.subarray(0, 5).toString('latin1');
  if (name.endsWith('.pdf') || head === '%PDF-') {
    return parsePdfText(await pdfToText(buf, passwords));
  }
  const text = decodeText(buf);
  if (name.endsWith('.ofx') || looksLikeOfx(text)) {
    const o = parseOfx(text);
    return { ...o, bank: bankFromOfx(o) };
  }
  if (name.endsWith('.csv') || text.includes(',') || text.includes(';')) return parseCsv(text);
  throw new Error('Formato não reconhecido. Envie OFX, CSV ou PDF.');
}

function invoiceGuess(parsed, filename) {
  if (parsed.invoice) return parsed.invoice;
  const f = (filename || '').match(/(20\d{2})-(\d{2})-\d{2}/);
  if (f) return `${f[1]}-${f[2]}`;
  if (parsed.end) return parsed.end.slice(0, 7);
  const last = parsed.items.map((i) => i.date).sort().pop();
  if (!last) return null;
  const [y, m] = last.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

export async function preview(db, buf, filename) {
  const parsed = await readFile(buf, filename, getSetting(db, 'pdf_passwords', []));
  const acctMap = getSetting(db, 'acct_map', {});
  let account = parsed.bank || null;
  if (parsed.acctId && acctMap[parsed.acctId]) account = acctMap[parsed.acctId];
  if (!parsed.isCard && /nu.?empresas|^nu_pj/i.test(filename || '')) account = 'Nu Empresas';
  const kind = parsed.isCard ? 'card' : 'account';
  const owners = getSetting(db, 'owner_names', []);
  const company = getSetting(db, 'company_names', []);

  let items;
  if (kind === 'account') {
    const history = buildHistory(db.prepare("SELECT description, type, category FROM transactions WHERE date >= date('now','-400 days')").all());
    items = parsed.items.map((i) => ({ ...i, amount: round2(i.amount), ...classifyAccountLine(i, { account, owners, company, history }) }));
  } else {
    const history = buildHistory(db.prepare("SELECT description, NULL AS type, category FROM card_items WHERE date >= date('now','-400 days')").all());
    // On card OFX/CSV a purchase is a debit; store purchases as positive values.
    const flip = parsed.format === 'ofx';
    items = parsed.items
      .map((i) => ({ ...i, amount: round2(flip ? -i.amount : i.amount) }))
      .filter((i) => !/pagamento recebido|pagamento de fatura|pagamento em/i.test(i.description))
      .map((i) => ({ ...i, ...classifyCardLine(i, { history }) }));
  }
  if (kind === 'account') suggestGoals(db, items);
  markDuplicates(db, kind, account, items);
  return {
    filename, kind, format: parsed.format, account, acctId: parsed.acctId || null,
    invoice: kind === 'card' ? invoiceGuess(parsed, filename) : null,
    balance: parsed.balance || null,
    period: { start: parsed.start || items.map((i) => i.date).sort()[0] || null, end: parsed.end || items.map((i) => i.date).sort().pop() || null },
    items,
  };
}

// Which caixinha an application/withdrawal belongs to: a caixinha named in the
// description, else the one used last time for the same description, else the last used.
function suggestGoals(db, items) {
  const goals = db.prepare('SELECT id, name FROM goals ORDER BY sort, id').all();
  if (!goals.length) return;
  const lastAny = db.prepare('SELECT goal_id FROM transactions WHERE goal_id IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1').get()?.goal_id;
  const bySame = db.prepare('SELECT goal_id FROM transactions WHERE goal_id IS NOT NULL AND description = ? ORDER BY date DESC LIMIT 1');
  const n = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const i of items) {
    if (i.type !== 'investimento' || i.category === 'Cripto') continue;
    const named = goals.find((g) => n(i.description).includes(n(g.name)));
    i.goalId = named?.id ?? bySame.get(i.description)?.goal_id ?? lastAny ?? goals[0].id;
  }
}

export function markDuplicates(db, kind, account, items) {
  const table = kind === 'card' ? 'card_items' : 'transactions';
  const col = kind === 'card' ? 'card' : 'account';
  if (!account) { items.forEach((i) => { i.duplicate = false; }); return; }
  const dates = items.map((i) => i.date).sort();
  if (!dates.length) return;
  // Lines typed in Contas ("previsto") are not duplicates: the bank line replaces them.
  const notProvisional = kind === 'card' ? '' : "AND (origin IS NULL OR origin <> 'previsto')";
  const existing = db.prepare(`SELECT id, date, amount, ext_id FROM ${table} WHERE ${col} = ? ${notProvisional} AND date BETWEEN date(?, '-3 days') AND date(?, '+3 days')`)
    .all(account, dates[0], dates[dates.length - 1]);
  const byExt = new Set(existing.filter((e) => e.ext_id).map((e) => e.ext_id));
  const used = new Set();
  for (const i of items) {
    if (i.extId && byExt.has(i.extId)) { i.duplicate = true; continue; }
    // Same account, same value, same day (±1 for card lines): very likely already there
    const hit = existing.find((e) => !used.has(e.id) && Math.abs(e.amount - i.amount) < 0.005 &&
      Math.abs(Date.parse(e.date) - Date.parse(i.date)) <= (kind === 'card' ? 86400000 : 0));
    if (hit) { used.add(hit.id); i.duplicate = true; } else i.duplicate = false;
  }
}

export function commit(db, body) {
  const { kind, account, acctId, invoice, filename, format, balance } = body;
  const items = (body.items || []).filter((i) => i.include !== false);
  if (!account) throw new Error(kind === 'card' ? 'Escolha o cartão.' : 'Escolha a conta.');
  if (kind === 'card' && !/^\d{4}-\d{2}$/.test(invoice || '')) throw new Error('Escolha o mês da fatura.');
  return tx(db, () => {
    const imp = db.prepare('INSERT INTO imports (filename, source, kind, account, count) VALUES (?, ?, ?, ?, ?)')
      .run(filename || null, format || null, kind, account, items.length);
    const importId = Number(imp.lastInsertRowid);
    let added = 0, skipped = 0, paidBills = [], replaced = 0;
    const newIds = [];
    if (kind === 'card') {
      const ins = db.prepare('INSERT OR IGNORE INTO card_items (card, invoice, date, description, amount, category, ext_id, import_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const i of items) {
        const r = ins.run(account, invoice, i.date, i.description, round2(+i.amount), i.category || 'A confirmar', i.extId || null, importId);
        r.changes ? added++ : skipped++;
      }
    } else {
      const ins = db.prepare('INSERT OR IGNORE INTO transactions (date, description, amount, type, category, account, ext_id, import_id, goal_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const validGoal = new Set(db.prepare('SELECT id FROM goals').all().map((g) => g.id));
      for (const i of items) {
        const goal = i.type === 'investimento' && validGoal.has(Number(i.goalId)) ? Number(i.goalId) : null;
        const r = ins.run(i.date, i.description, round2(+i.amount), i.type, i.category || 'A confirmar', account, i.extId || null, importId, goal);
        if (r.changes) {
          added++;
          const id = Number(r.lastInsertRowid);
          newIds.push(id);
          if (goal) applyGoal(db, { type: i.type, amount: round2(+i.amount), goal_id: goal });
        } else skipped++;
      }
      replaced = replaceProvisional(db, newIds);
      paidBills = matchBills(db, newIds);
      if (balance && balance.amount != null) updateBalance(db, account, balance.amount, balance.date);
    }
    if (acctId) {
      const map = getSetting(db, 'acct_map', {});
      map[acctId] = account;
      setSetting(db, 'acct_map', map);
    }
    if (added) db.prepare('UPDATE imports SET count = ? WHERE id = ?').run(added, importId);
    else db.prepare('DELETE FROM imports WHERE id = ?').run(importId); // nothing new: keep the history clean
    return { importId, added, skipped, paidBills, replaced };
  });
}

export function updateBalance(db, account, amount, date) {
  const row = db.prepare("SELECT id, updated FROM assets WHERE kind = 'Conta' AND account = ?").get(account);
  if (!row) {
    db.prepare("INSERT INTO assets (name, kind, account, value, updated) VALUES (?, 'Conta', ?, ?, ?)")
      .run(`${account} – conta corrente`, account, amount, date);
  } else if (!row.updated || !date || date >= row.updated) {
    db.prepare('UPDATE assets SET value = ?, updated = ? WHERE id = ?').run(amount, date, row.id);
  }
}

export function undoImport(db, id) {
  return tx(db, () => {
    const rows = db.prepare('SELECT * FROM transactions WHERE import_id = ?').all(id);
    for (const t of rows) applyGoal(db, t, -1);
    unlinkBills(db, rows.map((t) => t.id));
    const a = db.prepare('DELETE FROM transactions WHERE import_id = ?').run(id).changes;
    const b = db.prepare('DELETE FROM card_items WHERE import_id = ?').run(id).changes;
    db.prepare('DELETE FROM imports WHERE id = ?').run(id);
    return { removed: a + b };
  });
}
