// Contas: what you expect in the month (bills to pay and money to receive).
// Marking one as paid/received puts it in the Extrato, which is what actually happened.
import { api, meta } from '../api.js';
import {
  h, fill, money, monthSwitcher, monthLabel, toast, sheet, field, select, ICON, addMonths, parseMoneyInput,
  moneyInputValue, confirmDialog, shortDate, thisMonth,
} from '../util.js';

const RESULT = {
  bill: {
    lancado: 'Conta paga e lançada no Extrato',
    ligado: 'Conta paga. O pagamento já estava no Extrato e ficou ligado a ela',
    removido: 'Conta desmarcada e retirada do Extrato',
    desligado: 'Conta desmarcada. O lançamento do banco continua no Extrato',
  },
  income: {
    lancado: 'Recebido e lançado no Extrato',
    ligado: 'Recebido. A entrada já estava no Extrato e ficou ligada',
    removido: 'Desmarcado e retirado do Extrato',
    desligado: 'Desmarcado. O lançamento do banco continua no Extrato',
  },
};

const tellResult = (kind, r, fallback) => toast(RESULT[kind][r?.extrato] || fallback, 'ok');

// Where the item is in the Extrato, in words, with a way to get there.
function linkNote(item, done, go) {
  if (!done) return null;
  if (!item.tx_date) return h('p', { class: 'link-note' }, 'Marcada antes desta versão: não está ligada a um lançamento do Extrato.');
  const where = item.tx_origin === 'previsto'
    ? `No Extrato em ${shortDate(item.tx_date)}, lançado por aqui. Quando você importar o extrato do banco, ele é trocado pelo lançamento do banco.`
    : `No Extrato em ${shortDate(item.tx_date)}, ligado ao lançamento do banco.`;
  return h('p', { class: 'link-note' }, where, ' ',
    h('a', { href: '#/extrato', onclick: (e) => { e.preventDefault(); go({ month: item.tx_date.slice(0, 7) }, '#/extrato'); } }, 'Ver no Extrato'));
}

export async function editBill(b, month, onSaved, go) {
  const m = await meta();
  const desc = h('input', { value: b?.description || '', placeholder: 'Ex.: Conta de luz', required: true });
  const amount = h('input', { inputmode: 'decimal', value: b ? moneyInputValue(b.amount) : '', placeholder: '0,00' });
  const due = h('input', { type: 'date', value: b?.due || '' });
  const cat = select(m.billCategories, b?.category || 'Contas fixas');
  const paid = h('input', { type: 'checkbox', checked: !!b?.paid });
  const save = async (e) => {
    e.preventDefault();
    const body = { month: b?.month || month, description: desc.value, amount: parseMoneyInput(amount.value) || 0, due: due.value || null, category: cat.value, paid: paid.checked };
    try {
      const r = b ? await api.put(`bills/${b.id}`, body) : await api.post('bills', body);
      tellResult('bill', r, b ? 'Conta salva' : 'Conta adicionada');
      s.close(); onSaved();
    } catch (err) { toast(err.message, 'err'); }
  };
  const remove = async () => {
    if (!(await confirmDialog(`Excluir a conta "${b.description}" de ${monthLabel(b.month)}?${b.paid && b.tx_origin === 'previsto' ? ' O lançamento que ela criou no Extrato também sai.' : ''}`))) return;
    await api.del(`bills/${b.id}`); toast('Conta excluída', 'ok'); s.close(); onSaved();
  };
  const s = sheet(b ? 'Conta a pagar' : 'Nova conta a pagar', h('form', { class: 'form', onsubmit: save },
    b && go ? linkNote(b, b.paid, (p, hash) => { s.close(); go(p, hash); }) : null,
    field('Descrição', desc),
    h('div', { class: 'grid2' }, field('Valor', amount), field('Vencimento', due)),
    field('Categoria', cat),
    h('label', { class: 'check-line' }, paid, 'Já paguei (lança o pagamento no Extrato)'),
    h('div', { class: 'row-btns' },
      b ? h('button', { type: 'button', class: 'btn ghost danger-text', onclick: remove }, 'Excluir') : null,
      h('button', { type: 'submit', class: 'btn primary' }, b ? 'Salvar' : 'Adicionar'))));
}

async function editIncome(i, month, onSaved, go) {
  const desc = h('input', { value: i?.description || '', placeholder: 'Ex.: Salário PJ', required: true });
  const amount = h('input', { inputmode: 'decimal', value: i ? moneyInputValue(i.amount) : '', placeholder: '0,00' });
  const expected = h('input', { type: 'date', value: i?.expected || '' });
  const kind = select(['Salário PJ', 'Salário CLT', 'Alimentação', 'Outros'], i?.kind || 'Outros');
  const received = h('input', { type: 'checkbox', checked: !!i?.received });
  const save = async (e) => {
    e.preventDefault();
    const body = { month: i?.month || month, description: desc.value, amount: parseMoneyInput(amount.value) || 0, expected: expected.value || null, kind: kind.value, received: received.checked };
    try {
      const r = i ? await api.put(`incomes/${i.id}`, body) : await api.post('incomes', body);
      tellResult('income', r, 'Entrada salva');
      s.close(); onSaved();
    } catch (err) { toast(err.message, 'err'); }
  };
  const remove = async () => {
    if (!(await confirmDialog(`Excluir "${i.description}"?${i.received && i.tx_origin === 'previsto' ? ' O lançamento que ela criou no Extrato também sai.' : ''}`))) return;
    await api.del(`incomes/${i.id}`); toast('Entrada excluída', 'ok'); s.close(); onSaved();
  };
  const s = sheet(i ? 'Valor a receber' : 'Novo valor a receber', h('form', { class: 'form', onsubmit: save },
    i && go && !/alimenta/i.test(i.kind || '') ? linkNote(i, i.received, (p, hash) => { s.close(); go(p, hash); }) : null,
    field('Descrição', desc),
    h('div', { class: 'grid2' }, field('Valor', amount), field('Data prevista', expected)),
    field('Tipo', kind, 'Vale alimentação fica no cartão de benefício: não entra na conta nem no Extrato.'),
    h('label', { class: 'check-line' }, received, 'Já recebi (lança a entrada no Extrato)'),
    h('div', { class: 'row-btns' },
      i ? h('button', { type: 'button', class: 'btn ghost danger-text', onclick: remove }, 'Excluir') : null,
      h('button', { type: 'submit', class: 'btn primary' }, i ? 'Salvar' : 'Adicionar'))));
}

export async function contasView(root, state, go) {
  const month = state.month;
  const cur = thisMonth();
  const past = month < cur;
  const [bills, incomes, nextBills, future, o] = await Promise.all([
    api.get(`bills?month=${month}`), api.get(`incomes?month=${month}`), api.get(`bills?month=${addMonths(month, 1)}`),
    api.get('cards/future'), api.get(`overview?month=${month}`),
  ]);
  const parcelas = Object.fromEntries(future.filter((f) => f.invoice === month).map((f) => [f.card, f.total]));
  const cardOf = (d) => ['Nubank', 'Santander', 'Caixa'].find((c) => d.toLowerCase().includes(c.toLowerCase()));
  const inAccount = incomes.filter((i) => !/alimenta/i.test(i.kind || ''));
  const sum = (list) => list.reduce((s, x) => s + x.amount, 0);
  const aPagar = sum(bills.filter((b) => !b.paid));
  const aReceber = sum(inAccount.filter((i) => !i.received));
  const reload = () => go();

  const toggle = async (kind, item) => {
    const path = kind === 'bill' ? 'bills' : 'incomes';
    const key = kind === 'bill' ? 'paid' : 'received';
    try {
      const r = await api.put(`${path}/${item.id}`, { [key]: !item[key] });
      tellResult(kind, r, item[key] ? 'Desmarcado' : 'Marcado');
      go();
    } catch (e) { toast(e.message, 'err'); }
  };

  const sub = (kind, x, done) => {
    if (done && x.tx_date) return h('small', { class: 'linked' }, `${kind === 'bill' ? 'Paga' : 'Recebido'} em ${shortDate(x.tx_date)}, está no Extrato`);
    const parts = [];
    if (kind === 'bill') {
      if (x.due) parts.push(`vence ${shortDate(x.due)}`);
      const c = x.category === 'Cartão' && !done ? cardOf(x.description) : null;
      if (c && parcelas[c]) parts.push(`${money(parcelas[c])} já em parcelas`);
      if (!parts.length) parts.push(x.category);
    } else {
      if (/alimenta/i.test(x.kind || '')) parts.push('cartão de benefício, não entra na conta');
      else if (x.expected) parts.push(`previsto para ${shortDate(x.expected)}`);
      if (x.note) parts.push(x.note);
    }
    return h('small', {}, parts.join(', '));
  };

  const row = (kind, x) => {
    const done = kind === 'bill' ? !!x.paid : !!x.received;
    const benefit = kind === 'income' && /alimenta/i.test(x.kind || '');
    const label = kind === 'bill' ? (done ? 'Paga' : 'Marcar paga') : (done ? 'Recebido' : 'Marcar recebido');
    return h('li', { class: done ? 'done' : '' },
      h('button', { class: 'plan-open', onclick: () => (kind === 'bill' ? editBill : editIncome)(x, month, reload, go) },
        h('strong', {}, x.description),
        h('span', { class: 'plan-sub' }, h('span', { class: `num ${kind === 'income' && !benefit ? 'in' : ''}` }, x.amount ? money(x.amount) : 'valor a definir'), sub(kind, x, done))),
      h('button', {
        class: `status-btn ${done ? `done ${kind === 'income' ? 'in' : ''}` : ''}`, 'aria-pressed': String(done),
        'aria-label': `${x.description}: ${done ? label.toLowerCase() : 'ainda não'}. Toque para ${done ? 'desmarcar' : 'marcar'}`,
        onclick: () => toggle(kind, x),
      }, done ? h('span', { html: ICON.check }) : null, label));
  };

  const copyNext = async () => {
    const to = addMonths(month, 1);
    try {
      const r = await api.post('bills/next-month', { from: month, to });
      toast(`${r.bills} contas criadas em ${monthLabel(to)}`, 'ok');
      go({ month: to });
    } catch (e) { toast(e.message, 'err'); }
  };

  fill(root,
    h('header', { class: 'top' }, h('h1', { class: 'sr-only' }, 'Contas do mês'), monthSwitcher(month, (mm) => go({ month: mm }))),
    h('p', { class: 'plan-intro' }, 'O que você espera pagar e receber no mês. Ao marcar como paga ou recebida, vai para o Extrato.'),
    bills.length || incomes.length ? h('dl', { class: 'plan-summary' },
      past
        ? [h('div', {}, h('dt', {}, 'Contas pagas'), h('dd', { class: 'num' }, `${money(sum(bills.filter((b) => b.paid)))} de ${money(sum(bills))}`)),
          h('div', {}, h('dt', {}, 'Recebido'), h('dd', { class: 'num in' }, `${money(sum(inAccount.filter((i) => i.received)))} de ${money(sum(inAccount))}`))]
        : [h('div', {}, h('dt', {}, 'Falta pagar'), h('dd', { class: 'num out' }, money(aPagar))),
          h('div', {}, h('dt', {}, 'Falta receber'), h('dd', { class: 'num in' }, money(aReceber))),
          month === cur ? h('div', { class: 'main' }, h('dt', {}, 'Na conta no fim do mês'), h('dd', { class: 'num have' }, money(o.previsao.fimDoMes))) : null]) : null,

    h('section', { class: 'block' },
      h('div', { class: 'block-head' }, h('h2', {}, past ? 'Contas do mês' : 'Para pagar'), h('button', { class: 'link', onclick: () => editBill(null, month, reload, go) }, 'Adicionar')),
      bills.length ? h('ul', { class: 'plan-list' }, bills.map((b) => row('bill', b)))
        : h('div', { class: 'empty' }, h('p', {}, `Nenhuma conta em ${monthLabel(month)}.`),
          h('button', { class: 'btn primary', onclick: () => editBill(null, month, reload, go) }, 'Adicionar conta'))),

    h('section', { class: 'block' },
      h('div', { class: 'block-head' }, h('h2', {}, past ? 'Entradas do mês' : 'Para receber'), h('button', { class: 'link', onclick: () => editIncome(null, month, reload, go) }, 'Adicionar')),
      incomes.length ? h('ul', { class: 'plan-list' }, incomes.map((i) => row('income', i))) : h('p', { class: 'muted' }, 'Nenhuma entrada prevista.')),

    bills.length && !nextBills.length ? h('section', { class: 'block' },
      h('button', { class: 'btn ghost wide', onclick: copyNext }, `Criar contas de ${monthLabel(addMonths(month, 1))} com base neste mês`),
      h('p', { class: 'field-hint' }, 'Copia as contas fixas e as entradas previstas, todas em aberto (gastos extras ficam de fora). No dia 1 o app faz isso sozinho.')) : null,
  );
}
