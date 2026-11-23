// Bills paid by the statement, installments, limits, caixinhas and IR summary (made-up data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { commit, undoImport } from '../server/importer.js';
import { parseInstallment, futureInstallments, createMonth, budgetStatus, irReport, matchBills } from '../server/features.js';

function setup() {
  const db = openDb(':memory:');
  const bill = db.prepare('INSERT INTO bills (month, description, category, amount, due, paid) VALUES (?, ?, ?, ?, ?, 0)');
  bill.run('2026-12', 'Cartão Caixa', 'Cartão', 1668.04, '2026-12-16');
  bill.run('2026-12', 'Contabilidade 2', 'Contabilidade', 320, null);
  bill.run('2026-12', 'Celular (TIM)', 'Contas fixas', 128.43, '2026-12-09');
  bill.run('2026-12', 'Geladeira', 'Gastos extras', 999, null);
  db.prepare("INSERT INTO goals (id, name, current, target) VALUES (1, 'Reserva de emergência', 1000, 20000), (2, 'Caixinhas turbo', 500, 15000)").run();
  return db;
}

const line = (date, description, amount, type, category, extra = {}) => ({ date, description, amount, type, category, include: true, ...extra });

test('a payment in the statement marks its bill as paid; undoing the import reopens it', () => {
  const db = setup();
  const r = commit(db, {
    kind: 'account', account: 'Caixa', format: 'ofx', items: [
      line('2026-12-15', 'PAG FATURA CARTOES CAIXA', -1702.10, 'saida', 'Cartões de crédito'),
      line('2026-12-05', 'Pix enviado - Social Contabilidade', -320, 'saida', 'Contabilidade'),
      line('2026-12-06', 'Mercado', -320.5, 'saida', 'Alimentação'),
    ],
  });
  assert.deepEqual(r.paidBills.map((b) => b.description).sort(), ['Cartão Caixa', 'Contabilidade 2']);
  const card = db.prepare("SELECT paid, amount FROM bills WHERE description = 'Cartão Caixa'").get();
  assert.deepEqual({ ...card }, { paid: 1, amount: 1702.1 }); // estimate replaced by the real value
  assert.equal(db.prepare("SELECT paid FROM bills WHERE description LIKE 'Celular%'").get().paid, 0);
  undoImport(db, r.importId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bills WHERE paid = 1').get().n, 0);
});

test('caixinhas move with applications and withdrawals, and back on undo', () => {
  const db = setup();
  const r = commit(db, {
    kind: 'account', account: 'Nubank', format: 'ofx', items: [
      line('2026-12-10', 'Aplicação RDB', -300, 'investimento', 'Caixinhas', { goalId: 1 }),
      line('2026-12-11', 'Resgate RDB', 100, 'investimento', 'Caixinhas', { goalId: 2 }),
    ],
  });
  const g = () => db.prepare('SELECT id, current FROM goals ORDER BY id').all().map((x) => x.current);
  assert.deepEqual(g(), [1300, 400]);
  undoImport(db, r.importId);
  assert.deepEqual(g(), [1000, 500]);
});

test('installments: parsing and the months still to come', () => {
  assert.deepEqual(parseInstallment('REI DO CAPACETE 03/06'), { k: 3, n: 6, base: 'REI DO CAPACETE' });
  assert.deepEqual(parseInstallment('Loja X - Parcela 2/3'), { k: 2, n: 3, base: 'Loja X' });
  assert.equal(parseInstallment('Mercado'), null);
  assert.equal(parseInstallment('Loja 3/2'), null);
  const db = setup();
  const ins = db.prepare('INSERT INTO card_items (card, invoice, date, description, amount, category) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('Caixa', '2026-11', '2026-08-07', 'REI DO CAPACETE 04/06', 266.33, 'Veículo');
  ins.run('Caixa', '2026-11', '2026-10-01', 'TENIS 01/02', 100, 'Compras');
  ins.run('Caixa', '2026-11', '2026-10-02', 'Mercado', 50, 'Alimentação');
  ins.run('Caixa', '2026-10', '2026-08-07', 'REI DO CAPACETE 03/06', 266.33, 'Veículo'); // older bill: ignored
  const f = futureInstallments(db);
  assert.deepEqual(f.map((x) => [x.invoice, x.total]), [['2026-12', 366.33], ['2027-01', 266.33]]);
  assert.equal(f[0].items.find((i) => i.description === 'REI DO CAPACETE').parcela, '5/6');

  // The new month's card bill uses the committed installments when higher.
  db.exec("DELETE FROM bills; INSERT INTO bills (month, description, category, amount, due, paid) VALUES ('2026-11', 'Cartão Caixa', 'Cartão', 200, '2026-11-16', 1), ('2026-11', 'Geladeira', 'Gastos extras', 999, NULL, 1)");
  assert.equal(createMonth(db, '2026-11', '2026-12').bills, 1);
  const dec = db.prepare("SELECT description, amount, due, paid FROM bills WHERE month = '2026-12'").all().map((b) => ({ ...b }));
  assert.deepEqual(dec, [{ description: 'Cartão Caixa', amount: 366.33, due: '2026-12-16', paid: 0 }]);
  assert.equal(createMonth(db, '2026-11', '2026-12').exists, true);
});

test('limits count account spending and card purchases of the month', () => {
  const db = setup();
  db.prepare("INSERT INTO budgets (category, monthly) VALUES ('Alimentação', 800)").run();
  db.prepare("INSERT INTO transactions (date, description, amount, type, category) VALUES ('2026-12-05', 'Padaria', -100, 'saida', 'Alimentação')").run();
  db.prepare("INSERT INTO card_items (card, invoice, date, description, amount, category) VALUES ('Nubank', '2026-12', '2026-11-20', 'iFood', 560, 'Alimentação')").run();
  const [b] = budgetStatus(db, '2026-12');
  assert.equal(b.used, 660);
  assert.ok(Math.abs(b.pct - 0.825) < 1e-9);
});

test('income tax summary: income by category, health from account and card, assets and debts', () => {
  const db = setup();
  const t = db.prepare('INSERT INTO transactions (date, description, amount, type, category) VALUES (?, ?, ?, ?, ?)');
  t.run('2026-03-15', 'Salário', 8150, 'entrada', 'Salário PJ');
  t.run('2026-03-30', 'Salário', 2960, 'entrada', 'Salário CLT');
  t.run('2026-04-02', 'Clínica', -250, 'saida', 'Saúde');
  t.run('2025-12-31', 'Fora do ano', 999, 'entrada', 'Salário PJ');
  db.prepare("INSERT INTO card_items (card, invoice, date, description, amount, category) VALUES ('Nubank', '2026-05', '2026-04-20', 'Drogaria', 80, 'Saúde')").run();
  db.prepare("INSERT INTO assets (name, kind, value) VALUES ('Apartamento', 'Bem', 300000), ('Financiamento', 'Dívida', -142019.99)").run();
  const r = irReport(db, '2026');
  assert.deepEqual(r.rendimentos.map((x) => [x.category, x.total]), [['Salário PJ', 8150], ['Salário CLT', 2960]]);
  assert.equal(r.saude.total, 330);
  assert.equal(r.saude.itens.length, 2);
  assert.deepEqual(r.dividas, [{ name: 'Financiamento', value: 142019.99, updated: null }]);
  assert.ok(r.bens.some((b) => b.name === 'Caixinha: Reserva de emergência' && b.value === 1000));
});

test('the same bill is never matched twice', () => {
  const db = setup();
  const ins = db.prepare("INSERT INTO transactions (date, description, amount, type, category) VALUES ('2026-12-05', 'Pix', -320, 'saida', 'Contabilidade')");
  const a = Number(ins.run().lastInsertRowid), b = Number(ins.run().lastInsertRowid);
  assert.equal(matchBills(db, [a, b]).length, 1);
});

import { syncBill, syncIncome } from '../server/features.js';

test('Contas ↔ Extrato: received/paid adds a line, unmarking removes it, the bank line replaces it', () => {
  const db = setup();
  const inc = Number(db.prepare("INSERT INTO incomes (month, description, kind, amount, expected, received) VALUES ('2026-12', 'Salário PJ', 'Salário PJ', 8150, '2026-12-15', 0)").run().lastInsertRowid);
  const get = () => db.prepare('SELECT * FROM incomes WHERE id = ?').get(inc);
  const txs = () => db.prepare("SELECT date, amount, type, category, origin FROM transactions ORDER BY id").all().map((t) => ({ ...t }));

  let before = get();
  db.prepare('UPDATE incomes SET received = 1 WHERE id = ?').run(inc);
  assert.equal(syncIncome(db, before, get()), 'lancado');
  assert.deepEqual(txs(), [{ date: '2026-12-15', amount: 8150, type: 'entrada', category: 'Salário PJ', origin: 'previsto' }]);

  before = get();
  db.prepare('UPDATE incomes SET received = 0 WHERE id = ?').run(inc);
  assert.equal(syncIncome(db, before, get()), 'removido');
  assert.equal(txs().length, 0);

  // Mark again, then import the bank statement: the bank line takes its place, still linked.
  before = get();
  db.prepare('UPDATE incomes SET received = 1 WHERE id = ?').run(inc);
  syncIncome(db, before, get());
  const r = commit(db, { kind: 'account', account: 'Nubank', format: 'ofx', items: [line('2026-12-12', 'Transferência recebida - EMPRESA', 8150, 'entrada', 'Salário PJ', { extId: 'b1' })] });
  assert.equal(r.replaced, 1);
  const all = txs();
  assert.equal(all.length, 1);
  assert.equal(all[0].origin, null);
  assert.equal(get().received, 1);
  assert.equal(db.prepare('SELECT ext_id FROM transactions WHERE id = ?').get(get().tx_id).ext_id, 'b1');

  // A bill whose payment is already in the statement is linked, not added twice.
  const bill = db.prepare("SELECT * FROM bills WHERE description = 'Contabilidade 2'").get();
  db.prepare("INSERT INTO transactions (date, description, amount, type, category) VALUES ('2026-12-04', 'Pix contabilidade', -320, 'saida', 'Contabilidade')").run();
  db.prepare('UPDATE bills SET paid = 1 WHERE id = ?').run(bill.id);
  assert.equal(syncBill(db, bill, db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id)), 'ligado');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM transactions WHERE type = 'saida'").get().n, 1);
  // Unmarking a bill linked to a real bank line keeps the bank line.
  const b2 = db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id);
  db.prepare('UPDATE bills SET paid = 0 WHERE id = ?').run(bill.id);
  assert.equal(syncBill(db, b2, db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id)), 'desligado');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM transactions WHERE type = 'saida'").get().n, 1);

  // Benefit card income never enters the account.
  const va = db.prepare("INSERT INTO incomes (month, description, kind, amount, received) VALUES ('2026-12', 'Vale alimentação', 'Alimentação', 682, 1)").run();
  assert.equal(syncIncome(db, { received: 0 }, db.prepare('SELECT * FROM incomes WHERE id = ?').get(va.lastInsertRowid)), null);
});
