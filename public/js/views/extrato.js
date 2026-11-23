import { api, meta } from '../api.js';
import {
  h, fill, money, signed, monthSwitcher, dayLabel, today, toast, sheet, field, select, ICON, TYPE,
  parseMoneyInput, moneyInputValue, confirmDialog,
} from '../util.js';

const FILTERS = [
  ['', 'Tudo'], ['saida', 'Gastou'], ['entrada', 'Entrou'], ['investimento', 'Caixinhas'], ['transferencia', 'Entre contas'],
];

function categoriesFor(m, type) {
  const grp = type === 'entrada' ? ['entrada'] : type === 'saida' ? ['gasto'] : ['neutro', 'entrada', 'gasto'];
  return m.categories.filter((c) => grp.includes(c.grp)).map((c) => c.name);
}

// Create or edit a transaction. t = existing row or null.
export async function editTransaction(t, onSaved) {
  const m = await meta();
  let type = t?.type || 'saida';
  const amount = h('input', { inputmode: 'decimal', autocomplete: 'off', value: t ? moneyInputValue(t.amount) : '', placeholder: '0,00', 'aria-label': 'Valor' });
  const desc = h('input', { value: t?.description || '', placeholder: 'Ex.: Mercado' });
  const date = h('input', { type: 'date', value: t?.date || today() });
  const account = select(m.accounts, t?.account || 'Nubank');
  const note = h('textarea', { rows: 2, placeholder: 'Opcional' }, t?.note || '');
  const catBox = h('div');
  let cat;
  const renderCats = () => {
    const list = categoriesFor(m, type);
    const current = cat?.value || t?.category;
    cat = select(list.includes(current) ? list : [current, ...list].filter(Boolean), current || list[0]);
    catBox.replaceChildren(field('Categoria', cat));
  };
  const similar = h('input', { type: 'checkbox' });
  const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Tipo' },
    Object.entries(TYPE).map(([k, v]) => h('button', {
      type: 'button', role: 'radio', class: `seg ${v.cls}`, 'aria-checked': String(k === type),
      onclick: (e) => {
        type = k;
        seg.querySelectorAll('.seg').forEach((b) => b.setAttribute('aria-checked', String(b === e.currentTarget)));
        renderCats();
      },
    }, v.label)));
  renderCats();

  const save = async (e) => {
    e.preventDefault();
    let v = parseMoneyInput(amount.value);
    if (v == null || v === 0) { toast('Informe o valor.', 'err'); amount.focus(); return; }
    v = Math.abs(v);
    // Money out is negative; caixinha/transfer keep the direction they had (or out for new ones).
    const sign = type === 'entrada' ? 1 : type === 'saida' ? -1 : (t ? Math.sign(t.amount) || -1 : -1);
    const body = { type, amount: v * sign, description: desc.value, date: date.value, category: cat.value, account: account.value, note: note.value, applySimilar: similar.checked };
    try {
      if (t) await api.put(`transactions/${t.id}`, body); else await api.post('transactions', body);
      toast(t ? 'Lançamento salvo' : 'Lançamento adicionado', 'ok');
      s.close();
      onSaved();
    } catch (err) { toast(err.message, 'err'); }
  };
  const remove = async () => {
    if (!(await confirmDialog(`Excluir "${t.description}"?`))) return;
    await api.del(`transactions/${t.id}`);
    toast('Lançamento excluído', 'ok');
    s.close();
    onSaved();
  };
  const flip = t && (t.type === 'investimento' || t.type === 'transferencia')
    ? h('p', { class: 'field-hint' }, t.amount > 0 ? 'Este valor entrou na conta (veio da caixinha ou de outra conta sua).' : 'Este valor saiu da conta (foi para a caixinha ou outra conta sua).')
    : null;

  const s = sheet(t ? 'Editar lançamento' : 'Novo lançamento', h('form', { onsubmit: save, class: 'form' },
    seg,
    h('div', { class: 'amount-field' }, h('span', {}, 'R$'), amount),
    flip,
    field('Descrição', desc),
    h('div', { class: 'grid2' }, field('Data', date), field('Conta', account)),
    catBox,
    t ? h('label', { class: 'check-line' }, similar, 'Usar esta categoria nos outros iguais que estão sem categoria') : null,
    field('Observação', note),
    h('div', { class: 'row-btns' },
      t ? h('button', { type: 'button', class: 'btn ghost danger-text', onclick: remove }, 'Excluir') : null,
      h('button', { type: 'submit', class: 'btn primary' }, t ? 'Salvar' : 'Adicionar'))));
}

export async function extratoView(root, state, go) {
  const q = state.query;
  const month = state.month;
  const type = q.get('type') || '';
  const cat = q.get('cat') || '';
  const search = q.get('q') || '';
  const params = new URLSearchParams({ month });
  if (type) params.set('type', type);
  if (cat) params.set('category', cat);
  if (search) params.set('q', search);
  const rows = await api.get(`transactions?${params}`);

  const setQuery = (k, v) => {
    const n = new URLSearchParams(q);
    if (v) n.set(k, v); else n.delete(k);
    location.hash = `#/extrato${n.toString() ? `?${n}` : ''}`;
  };

  // Totals of what is on screen, kept apart by kind
  const sum = (t) => rows.filter((r) => r.type === t).reduce((s, r) => s + r.amount, 0);
  const groups = new Map();
  for (const r of rows) { if (!groups.has(r.date)) groups.set(r.date, []); groups.get(r.date).push(r); }

  let timer;
  const searchInput = h('input', {
    type: 'search', value: search, placeholder: 'Buscar no mês', 'aria-label': 'Buscar lançamentos',
    oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => setQuery('q', e.target.value.trim()), 350); },
  });

  fill(root, 
    h('header', { class: 'top' }, h('h1', { class: 'sr-only' }, 'Extrato'), monthSwitcher(month, (m) => go({ month: m }))),
    h('div', { class: 'search' }, h('span', { html: ICON.search }), searchInput),
    h('div', { class: 'chips', role: 'tablist', 'aria-label': 'Filtrar por tipo' },
      FILTERS.map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(k === type), class: `chip ${k ? TYPE[k].cls : ''}`, onclick: () => setQuery('type', k) }, l)),
      cat ? h('button', { class: 'chip active-cat', onclick: () => setQuery('cat', '') }, cat, h('span', { html: ICON.close })) : null),
    h('dl', { class: 'totals' },
      h('div', {}, h('dt', {}, 'Entrou'), h('dd', { class: 'num in' }, money(sum('entrada')))),
      h('div', {}, h('dt', {}, 'Gastou'), h('dd', { class: 'num out' }, money(-sum('saida')))),
      h('div', {}, h('dt', {}, 'Caixinhas'), h('dd', { class: 'num have' }, signed(-sum('investimento'))))),
    rows.length ? h('div', { class: 'tx-list' }, [...groups].map(([d, items]) => h('section', { class: 'day' },
      h('h3', { class: 'day-head' }, dayLabel(d)),
      h('ul', {}, items.map((r) => h('li', {},
        h('button', { class: `tx ${TYPE[r.type].cls}`, onclick: () => editTransaction(r, () => go()) },
          h('span', { class: 'tx-mark', 'aria-hidden': 'true' }),
          h('span', { class: 'tx-main' },
            h('span', { class: 'tx-desc' }, r.description),
            h('span', { class: 'tx-sub' }, h('span', { class: r.category === 'A confirmar' ? 'warn' : '' }, r.category), h('span', {}, r.account))),
          h('span', { class: 'tx-amt num' }, signed(r.amount), h('small', {}, TYPE[r.type].verb)))))))))
      : h('div', { class: 'empty' },
        h('p', {}, search || type || cat ? 'Nenhum lançamento com esse filtro.' : 'Nenhum lançamento neste mês.'),
        h('a', { class: 'btn primary', href: '#/importar' }, 'Importar extrato')),
    h('button', { class: 'fab', 'aria-label': 'Adicionar lançamento', onclick: () => editTransaction(null, () => go()), html: ICON.plus }),
  );
}
