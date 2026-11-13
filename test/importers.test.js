// Parser and classification tests with made-up data (no real statements in the repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOfx, bankFromOfx } from '../server/importers/ofx.js';
import { parseCsv, parseMoney } from '../server/importers/csv.js';
import { parsePdfText } from '../server/importers/pdf.js';
import { classifyAccountLine } from '../server/importers/classify.js';
import { openDb } from '../server/db.js';
import { markDuplicates } from '../server/importer.js';

const OFX = `OFXHEADER:100
<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>NU PAGAMENTOS S.A.<FID>260</FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>0260<ACCTID>123</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260101<DTEND>20260131
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105000000[-3:BRT]<TRNAMT>-12.50<FITID>a1<MEMO>Compra no débito - PADARIA</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260106000000[-3:BRT]<TRNAMT>500.00<FITID>a2<MEMO>Resgate RDB</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>487.50<DTASOF>20260131</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

test('OFX: lines, bank and balance', () => {
  const o = parseOfx(OFX);
  assert.equal(bankFromOfx(o), 'Nubank');
  assert.equal(o.items.length, 2);
  assert.deepEqual(o.items[0], { date: '2026-01-05', amount: -12.5, description: 'Compra no débito - PADARIA', extId: 'a1' });
  assert.deepEqual(o.balance, { amount: 487.5, date: '2026-01-31' });
  assert.equal(o.isCard, false);
});

test('CSV: Nubank account and card', () => {
  const a = parseCsv('Data,Valor,Identificador,Descrição\n05/01/2026,-12.50,x1,Compra no débito - PADARIA\n');
  assert.equal(a.format, 'csv-nubank-conta');
  assert.deepEqual(a.items[0], { date: '2026-01-05', amount: -12.5, description: 'Compra no débito - PADARIA', extId: 'x1' });
  const c = parseCsv('date,title,amount\n2026-01-03,Spotify,23.90\n');
  assert.equal(c.isCard, true);
  assert.equal(c.items[0].amount, 23.9);
});

test('money in Brazilian format', () => {
  assert.equal(parseMoney('1.234,56'), 1234.56);
  assert.equal(parseMoney('-R$ 10,00'), -10);
  assert.equal(parseMoney('(5,00)'), -5);
});

test('PDF text: two-column card bill', () => {
  const text = `FATURA DO CARTÃO   Vencimento 10/03/2026
  3      14/02 LOJA A                                   01/03          83,34                 Saldo Anterior   0,00
         20/02 MERCADO B                                               26,24            3      27/02 POSTO C      33,94
         13/02 PAGAMENTO DE FATURA                                   -1.550,75`;
  const r = parsePdfText(text);
  assert.equal(r.invoice, '2026-03');
  assert.deepEqual(r.items.map((i) => [i.date, i.amount]), [['2026-02-14', 83.34], ['2026-02-20', 26.24], ['2026-02-27', 33.94]]);
});

test('classification keeps caixinhas and own transfers out of spending', () => {
  const ctx = { account: 'Nubank', owners: ['FULANO DE TAL'], company: ['EMPRESA X'] };
  assert.equal(classifyAccountLine({ description: 'Aplicação RDB', amount: -100 }, ctx).type, 'investimento');
  assert.equal(classifyAccountLine({ description: 'Pix enviado - FULANO DE TAL - CAIXA', amount: -50 }, ctx).type, 'transferencia');
  assert.deepEqual(classifyAccountLine({ description: 'Transferência recebida - EMPRESA X LTDA', amount: 5000 }, ctx), { type: 'entrada', category: 'Salário PJ' });
  assert.deepEqual(classifyAccountLine({ description: 'Pagamento de fatura', amount: -900 }, ctx), { type: 'saida', category: 'Cartões de crédito' });
  assert.equal(classifyAccountLine({ description: 'Compra no débito - IFOOD', amount: -30 }, ctx).category, 'Alimentação');
});

test('duplicates are found by bank id or by same day and value', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO transactions (date, description, amount, type, account, ext_id) VALUES ('2026-01-05','x',-12.5,'saida','Nubank',NULL)").run();
  db.prepare("INSERT INTO transactions (date, description, amount, type, account, ext_id) VALUES ('2026-01-06','y',500,'investimento','Nubank','a2')").run();
  const items = [
    { date: '2026-01-05', amount: -12.5, extId: 'a1' },
    { date: '2026-01-06', amount: 1, extId: 'a2' },
    { date: '2026-01-07', amount: -3, extId: 'a3' },
  ];
  markDuplicates(db, 'account', 'Nubank', items);
  assert.deepEqual(items.map((i) => i.duplicate), [true, true, false]);
});
