// Small DOM and formatting helpers shared by every screen.

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brl0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
export const money = (v) => brl.format(v || 0);
export const money0 = (v) => brl0.format(v || 0);
export const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + brl.format(Math.abs(v || 0));

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEK = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const monthName = (ym) => MONTHS[+ym.slice(5, 7) - 1];
export const monthLabel = (ym) => `${cap(monthName(ym))} ${ym.slice(0, 4)}`;
export const monthShort = (ym) => MONTHS_SHORT[+ym.slice(5, 7) - 1];
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const thisMonth = () => today().slice(0, 7);
export const addMonths = (ym, n) => {
  let y = +ym.slice(0, 4), m = +ym.slice(5, 7) + n;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
};
export const dayLabel = (iso) => {
  const d = new Date(`${iso}T12:00:00`);
  const t = today();
  if (iso === t) return 'Hoje';
  const y = new Date(`${t}T12:00:00`); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Ontem';
  return `${cap(WEEK[d.getDay()])}, ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
};
export const shortDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');

export const TYPE = {
  entrada: { label: 'Entrou', cls: 'in', verb: 'Entrou' },
  saida: { label: 'Gastou', cls: 'out', verb: 'Gastou' },
  investimento: { label: 'Caixinha', cls: 'have', verb: 'Caixinha' },
  transferencia: { label: 'Entre minhas contas', cls: 'move', verb: 'Entre contas' },
};

// h('div', { class: 'x', onclick }, 'text', child) — text is always escaped.
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v; // only for our own static SVG
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Replace a container's content. Accepts nested arrays and skips null/false,
// so screens can write conditional blocks inline.
export function fill(root, ...children) {
  root.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return root;
}

export function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
}

// Bottom sheet. Returns { close }. content: Node; onClose optional.
export function sheet(title, content, { onClose } = {}) {
  const prev = document.activeElement;
  const close = () => {
    wrap.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => { wrap.remove(); prev?.focus?.(); }, 220);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
    h('div', { class: 'sheet-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Fechar', onclick: close, html: ICON.close })),
    h('div', { class: 'sheet-body' }, content));
  const wrap = h('div', { class: 'sheet-wrap', onclick: (e) => { if (e.target === wrap) close(); } }, panel);
  document.body.append(wrap);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => { wrap.classList.add('open'); panel.querySelector('input,select,textarea,button:not(.icon-btn)')?.focus({ preventScroll: true }); });
  return { close };
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function select(options, value, attrs = {}) {
  return h('select', attrs, options.map((o) => {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    return h('option', { value: v, selected: v === value }, l);
  }));
}

// Money input that accepts "1.234,56", "1234.56" or "1234,5"
export function parseMoneyInput(s) {
  let v = String(s || '').trim().replace(/R\$|\s/g, '');
  if (!v) return null;
  if (/,\d{0,2}$/.test(v)) v = v.replace(/\./g, '').replace(',', '.');
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
export const moneyInputValue = (n) => (n == null ? '' : String(Math.abs(n).toFixed(2)).replace('.', ','));

export function confirmDialog(text, okLabel = 'Excluir') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); s.close(); } };
    const s = sheet('Tem certeza?', h('div', {},
      h('p', { class: 'muted' }, text),
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn ghost', onclick: () => finish(false) }, 'Cancelar'),
        h('button', { class: 'btn danger', onclick: () => finish(true) }, okLabel))),
    { onClose: () => { if (!done) { done = true; resolve(false); } } });
  });
}

export const ICON = {
  close: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0l-5 5m5-5l5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bills: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>',
  left: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  right: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// Month switcher used at the top of several screens.
export function monthSwitcher(month, onChange) {
  return h('div', { class: 'month-switch' },
    h('button', { class: 'icon-btn', 'aria-label': 'Mês anterior', onclick: () => onChange(addMonths(month, -1)), html: ICON.left }),
    h('span', { class: 'month-label', 'aria-live': 'polite' }, monthLabel(month)),
    h('button', { class: 'icon-btn', 'aria-label': 'Próximo mês', onclick: () => onChange(addMonths(month, 1)), html: ICON.right }));
}
