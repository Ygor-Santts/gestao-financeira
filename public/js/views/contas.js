import { api, meta } from '../api.js';
import {
  h, fill, money, monthSwitcher, monthLabel, toast, sheet, field, select, ICON, addMonths, parseMoneyInput,
  moneyInputValue, confirmDialog, shortDate,
} from '../util.js';

export async function editBill(b, month, onSaved) {
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
      if (b) await api.put(`bills/${b.id}`, body); else await api.post('bills', body);
      toast(b ? 'Conta salva' : 'Conta adicionada', 'ok');
      s.close(); onSaved();
    } catch (err) { toast(err.message, 'err'); }
  };
  const remove = async () => {
    if (!(await confirmDialog(`Excluir a conta "${b.description}" de ${monthLabel(b.month)}?`))) return;
    await api.del(`bills/${b.id}`); toast('Conta excluída', 'ok'); s.close(); onSaved();
  };
  const s = sheet(b ? 'Editar conta' : 'Nova conta', h('form', { class: 'form', onsubmit: save },
    field('Descrição', desc),
    h('div', { class: 'grid2' }, field('Valor', amount), field('Vencimento', due)),
    field('Categoria', cat),
    h('label', { class: 'check-line' }, paid, 'Já paguei'),
    h('div', { class: 'row-btns' },
      b ? h('button', { type: 'button', class: 'btn ghost danger-text', onclick: remove }, 'Excluir') : null,
      h('button', { type: 'submit', class: 'btn primary' }, b ? 'Salvar' : 'Adicionar'))));
}

async function editIncome(i, month, onSaved) {
  const desc = h('input', { value: i?.description || '', placeholder: 'Ex.: Salário PJ', required: true });
  const amount = h('input', { inputmode: 'decimal', value: i ? moneyInputValue(i.amount) : '', placeholder: '0,00' });
  const expected = h('input', { type: 'date', value: i?.expected || '' });
  const kind = select(['Salário PJ', 'Salário CLT', 'Alimentação', 'Outros'], i?.kind || 'Outros');
  const received = h('input', { type: 'checkbox', checked: !!i?.received });
  const save = async (e) => {
    e.preventDefault();
    const body = { month: i?.month || month, description: desc.value, amount: parseMoneyInput(amount.value) || 0, expected: expected.value || null, kind: kind.value, received: received.checked };
    try {
      if (i) await api.put(`incomes/${i.id}`, body); else await api.post('incomes', body);
      toast('Entrada salva', 'ok'); s.close(); onSaved();
    } catch (err) { toast(err.message, 'err'); }
  };
  const remove = async () => {
    if (!(await confirmDialog(`Excluir "${i.description}"?`))) return;
    await api.del(`incomes/${i.id}`); toast('Entrada excluída', 'ok'); s.close(); onSaved();
  };
  const s = sheet(i ? 'Editar entrada prevista' : 'Nova entrada prevista', h('form', { class: 'form', onsubmit: save },
    field('Descrição', desc),
    h('div', { class: 'grid2' }, field('Valor', amount), field('Data prevista', expected)),
    field('Tipo', kind, kind.value === 'Alimentação' ? 'Vale alimentação fica no cartão de benefício e não entra na previsão da conta.' : null),
    h('label', { class: 'check-line' }, received, 'Já recebi'),
    h('div', { class: 'row-btns' },
      i ? h('button', { type: 'button', class: 'btn ghost danger-text', onclick: remove }, 'Excluir') : null,
      h('button', { type: 'submit', class: 'btn primary' }, i ? 'Salvar' : 'Adicionar'))));
}

export async function contasView(root, state, go) {
  const month = state.month;
  const [bills, incomes, nextBills, future] = await Promise.all([
    api.get(`bills?month=${month}`), api.get(`incomes?month=${month}`), api.get(`bills?month=${addMonths(month, 1)}`), api.get('cards/future'),
  ]);
  // Installments already committed on each card bill of this month
  const parcelas = Object.fromEntries(future.filter((f) => f.invoice === month).map((f) => [f.card, f.total]));
  const cardOf = (d) => ['Nubank', 'Santander', 'Caixa'].find((c) => d.toLowerCase().includes(c.toLowerCase()));
  const billNote = (b) => {
    const parts = [b.category];
    if (b.due) parts.push(`vence ${shortDate(b.due)}`);
    if (b.paid && b.tx_id) parts.push('baixa pelo extrato');
    const c = b.category === 'Cartão' && !b.paid ? cardOf(b.description) : null;
    if (c && parcelas[c]) parts.push(`${money(parcelas[c])} já em parcelas`);
    return parts.join(', ');
  };
  const total = bills.reduce((s, b) => s + b.amount, 0);
  const paid = bills.filter((b) => b.paid).reduce((s, b) => s + b.amount, 0);

  const toggle = async (path, item, key) => {
    await api.put(`${path}/${item.id}`, { [key]: !item[key] });
    go();
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
    h('header', { class: 'top' }, h('h1', { class: 'sr-only' }, 'Contas do mês'), monthSwitcher(month, (m) => go({ month: m }))),
    h('dl', { class: 'totals' },
      h('div', {}, h('dt', {}, 'Contas'), h('dd', { class: 'num' }, money(total))),
      h('div', {}, h('dt', {}, 'Já pago'), h('dd', { class: 'num' }, money(paid))),
      h('div', {}, h('dt', {}, 'Falta pagar'), h('dd', { class: 'num out' }, money(total - paid)))),
    bills.length ? h('div', { class: 'meter wide', role: 'progressbar', 'aria-label': 'Quanto já foi pago', 'aria-valuenow': Math.round(total ? (paid / total) * 100 : 0), 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('div', { style: { width: `${total ? (paid / total) * 100 : 0}%` } })) : null,

    h('section', { class: 'block' },
      h('div', { class: 'block-head' }, h('h2', {}, 'Contas a pagar'), h('button', { class: 'link', onclick: () => editBill(null, month, () => go()) }, 'Adicionar')),
      bills.length ? h('ul', { class: 'checklist' }, bills.map((b) => h('li', { class: b.paid ? 'done' : '' },
        h('button', { class: `check ${b.paid ? 'on' : ''}`, 'aria-pressed': String(!!b.paid), 'aria-label': `${b.description}: ${b.paid ? 'paga' : 'não paga'}`, onclick: () => toggle('bills', b, 'paid'), html: b.paid ? ICON.check : '' }),
        h('button', { class: 'check-text', onclick: () => editBill(b, month, () => go()) },
          h('span', {}, b.description),
          h('small', {}, billNote(b))),
        h('span', { class: 'num' }, money(b.amount)))))
        : h('div', { class: 'empty' }, h('p', {}, `Nenhuma conta em ${monthLabel(month)}.`),
          h('button', { class: 'btn primary', onclick: () => editBill(null, month, () => go()) }, 'Adicionar conta'))),

    h('section', { class: 'block' },
      h('div', { class: 'block-head' }, h('h2', {}, 'Vai entrar'), h('button', { class: 'link', onclick: () => editIncome(null, month, () => go()) }, 'Adicionar')),
      incomes.length ? h('ul', { class: 'checklist' }, incomes.map((i) => h('li', { class: i.received ? 'done' : '' },
        h('button', { class: `check in ${i.received ? 'on' : ''}`, 'aria-pressed': String(!!i.received), 'aria-label': `${i.description}: ${i.received ? 'recebido' : 'não recebido'}`, onclick: () => toggle('incomes', i, 'received'), html: i.received ? ICON.check : '' }),
        h('button', { class: 'check-text', onclick: () => editIncome(i, month, () => go()) },
          h('span', {}, i.description),
          h('small', {}, [i.expected ? `previsto ${shortDate(i.expected)}` : null, i.note].filter(Boolean).join(', ') || i.kind)),
        h('span', { class: 'num in' }, i.amount ? money(i.amount) : 'a definir')))) : h('p', { class: 'muted' }, 'Nenhuma entrada prevista.')),

    bills.length && !nextBills.length ? h('section', { class: 'block' },
      h('button', { class: 'btn ghost wide', onclick: copyNext }, `Criar contas de ${monthLabel(addMonths(month, 1))} com base neste mês`),
      h('p', { class: 'field-hint' }, 'Copia as contas fixas e as entradas previstas, todas como não pagas (gastos extras ficam de fora). No dia 1 o app faz isso sozinho.')) : null,
  );
}
