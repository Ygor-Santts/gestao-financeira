import { api } from '../api.js';
import { h, fill, money, money0, monthSwitcher, monthName, monthShort, toast, ICON, cap } from '../util.js';
import { editBill } from './contas.js';

// One plain sentence that says how the month went, keeping spending, caixinhas
// and transfers apart (transfers between own accounts never count as spending).
function verdict(mes) {
  const { entrou, gastou, caixinhas } = mes;
  if (!entrou && !gastou && !caixinhas) return 'Nada lançado neste mês ainda. Importe um extrato para começar.';
  const parts = [];
  const diff = entrou - gastou;
  if (diff >= 0) parts.push(`Entrou ${money0(entrou)} e você gastou ${money0(gastou)}: sobraram ${money0(diff)}.`);
  else parts.push(`Você gastou ${money0(-diff)} a mais do que entrou.`);
  if (caixinhas > 0) parts.push(`Guardou ${money0(caixinhas)} nas caixinhas.`);
  if (caixinhas < 0) parts.push(diff < 0 && -caixinhas >= -diff * 0.8
    ? `Isso foi coberto com ${money0(-caixinhas)} tirados das caixinhas.`
    : `Tirou ${money0(-caixinhas)} das caixinhas.`);
  return parts.join(' ');
}

function ribbon(mes) {
  const max = Math.max(mes.entrou, mes.gastou, 1);
  const pct = (v) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  const row = (cls, label, value) => h('div', { class: `rib-row ${cls}` },
    h('div', { class: 'rib-top' }, h('span', {}, label), h('strong', { class: 'num' }, money(value))),
    h('div', { class: 'rib-track' }, h('div', { class: 'rib-fill', style: { width: pct(value) } })));
  return h('div', { class: 'ribbon' },
    row('in', 'Entrou', mes.entrou),
    row('out', 'Gastou de verdade', mes.gastou),
    h('div', { class: `rib-have ${mes.caixinhas < 0 ? 'neg' : ''}` },
      h('span', {}, mes.caixinhas < 0 ? 'Tirou das caixinhas' : 'Guardou nas caixinhas'),
      h('strong', { class: 'num' }, money(Math.abs(mes.caixinhas)))),
    mes.entreContas ? h('p', { class: 'rib-note' }, `${money(Math.abs(mes.entreContas))} só mudaram de uma conta sua para outra e não contam como gasto.`) : null);
}

function yearChart(year, month) {
  const months = year.months;
  const max = Math.max(...months.map((m) => Math.max(m.entrou, m.gastou)), 1);
  const W = 336, H = 120, bw = 9, gap = W / 12;
  const svg = [`<svg viewBox="0 0 ${W} ${H + 18}" class="year-svg" role="img" aria-label="Entrou e gastou em cada mês de ${year.year}">`];
  months.forEach((m, i) => {
    const x = i * gap + gap / 2;
    const hi = (m.entrou / max) * H, ho = (m.gastou / max) * H;
    const cur = m.month === month;
    svg.push(`<rect x="${x - bw - 1}" y="${H - hi}" width="${bw}" height="${hi}" rx="2" class="b-in${cur ? ' cur' : ''}"><title>${cap(monthShort(m.month))}: entrou ${money(m.entrou)}</title></rect>`);
    svg.push(`<rect x="${x + 1}" y="${H - ho}" width="${bw}" height="${ho}" rx="2" class="b-out${cur ? ' cur' : ''}"><title>${cap(monthShort(m.month))}: gastou ${money(m.gastou)}</title></rect>`);
    svg.push(`<text x="${x}" y="${H + 14}" text-anchor="middle" class="${cur ? 'cur' : ''}">${monthShort(m.month)}</text>`);
  });
  svg.push('</svg>');
  return h('div', { html: svg.join('') });
}

export async function homeView(root, state, go) {
  const month = state.month;
  const [o, y] = await Promise.all([api.get(`overview?month=${month}`), api.get(`year?year=${month.slice(0, 4)}`)]);
  const pend = o.bills.filter((b) => !b.paid);

  const toggleBill = async (b) => {
    const r = await api.put(`bills/${b.id}`, { paid: !b.paid });
    toast(r.extrato === 'ligado' ? 'Conta paga. O pagamento já estava no Extrato' : b.paid ? 'Conta desmarcada' : 'Conta paga e lançada no Extrato', 'ok');
    go();
  };

  fill(root, 
    h('header', { class: 'top' }, h('h1', { class: 'sr-only' }, 'Início'), monthSwitcher(month, (m) => go({ month: m }))),

    h('section', { class: 'have-card', 'aria-label': 'O que você tem hoje' },
      h('p', { class: 'have-label' }, 'Você tem hoje'),
      h('p', { class: 'have-total num' }, money(o.agora.total)),
      h('div', { class: 'have-split' },
        h('a', { href: '#/patrimonio' }, h('span', {}, 'Na conta'), h('strong', { class: 'num' }, money(o.agora.naConta))),
        h('a', { href: '#/metas' }, h('span', {}, 'Nas caixinhas'), h('strong', { class: 'num' }, money(o.agora.caixinhas))))),

    h('section', { class: 'block' },
      h('h2', {}, cap(monthName(month))),
      h('p', { class: 'verdict' }, verdict(o.mes)),
      ribbon(o.mes),
      o.aConfirmar ? h('a', { class: 'notice', href: `#/extrato?cat=${encodeURIComponent('A confirmar')}` },
        `${o.aConfirmar} ${o.aConfirmar === 1 ? 'lançamento precisa' : 'lançamentos precisam'} de categoria`, h('span', { html: ICON.chevron })) : null),

    (o.bills.length || o.incomes.length) ? h('section', { class: 'block' },
      h('div', { class: 'block-head' }, h('h2', {}, 'Até o fim do mês'), h('a', { href: '#/contas' }, 'Ver contas')),
      h('dl', { class: 'forecast' },
        h('div', {}, h('dt', {}, 'Falta pagar'), h('dd', { class: 'num out' }, money(o.previsao.faltaPagar))),
        h('div', {}, h('dt', {}, 'Ainda vai entrar'), h('dd', { class: 'num in' }, money(o.previsao.aReceber))),
        h('div', {}, h('dt', {}, 'Na conta no fim'), h('dd', { class: 'num have' }, money(o.previsao.fimDoMes)))),
      pend.length ? h('ul', { class: 'checklist' }, pend.slice(0, 5).map((b) => h('li', {},
        h('button', { class: 'check', 'aria-label': `Marcar ${b.description} como paga`, onclick: () => toggleBill(b) }),
        h('button', { class: 'check-text', onclick: () => editBill(b, month, () => go(), go) },
          h('span', {}, b.description), b.due ? h('small', {}, `vence ${b.due.slice(8, 10)}/${b.due.slice(5, 7)}`) : null),
        h('span', { class: 'num' }, money(b.amount))))) : h('p', { class: 'muted' }, 'Todas as contas do mês estão pagas.')) : null,

    o.goals.length ? h('section', { class: 'block' },
      h('div', { class: 'block-head' }, h('h2', {}, 'Caixinhas'), h('a', { href: '#/metas' }, 'Atualizar')),
      o.goals.map((g) => {
        const p = g.target ? Math.min(100, (g.current / g.target) * 100) : 0;
        return h('div', { class: 'goal' },
          h('div', { class: 'goal-top' }, h('span', {}, g.name), h('span', { class: 'num' }, `${money0(g.current)} de ${money0(g.target)}`)),
          h('div', { class: 'meter', role: 'progressbar', 'aria-valuenow': Math.round(p), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': g.name },
            h('div', { style: { width: `${p}%` } })));
      })) : null,

    o.categorias.length ? h('section', { class: 'block' },
      h('div', { class: 'block-head' }, h('h2', {}, 'Para onde foi o dinheiro'), h('a', { href: '#/limites' }, o.limites.length ? 'Limites' : 'Criar limites')),
      h('ul', { class: 'cats' }, o.categorias.slice(0, 7).map((c) => {
        const lim = o.limites.find((l) => l.category === c.category);
        // With a limit the bar shows how much of it was used; without, the size next to the biggest category.
        const width = lim ? Math.min(100, lim.pct * 100) : (c.total / o.categorias[0].total) * 100;
        return h('li', {}, h('a', { href: `#/extrato?cat=${encodeURIComponent(c.category)}` },
          h('span', { class: 'cat-dot', style: { background: c.color } }),
          h('span', { class: 'cat-name' }, c.category, lim ? h('small', { class: lim.pct >= 1 ? 'over' : lim.pct >= 0.8 ? 'near' : '' }, `${money0(lim.used)} de ${money0(lim.monthly)} do limite, contando o cartão`) : null),
          h('span', { class: 'num' }, money(c.total)),
          h('span', { class: `cat-bar ${lim ? (lim.pct >= 1 ? 'over' : 'lim') : ''}`, style: { width: `${width}%`, background: lim ? null : c.color } })));
      }))) : null,

    h('section', { class: 'block' },
      h('div', { class: 'block-head' }, h('h2', {}, `Ano de ${y.year}`), h('a', { href: '#/ano' }, 'Mês a mês')),
      h('div', { class: 'legend' }, h('span', { class: 'in' }, 'Entrou'), h('span', { class: 'out' }, 'Gastou')),
      yearChart(y, month),
      h('dl', { class: 'forecast compact' },
        h('div', {}, h('dt', {}, 'Entrou'), h('dd', { class: 'num in' }, money0(y.total.entrou))),
        h('div', {}, h('dt', {}, 'Gastou'), h('dd', { class: 'num out' }, money0(y.total.gastou))),
        h('div', {}, h('dt', {}, 'Caixinhas'), h('dd', { class: 'num have' }, (y.total.caixinhas < 0 ? '−' : '+') + money0(Math.abs(y.total.caixinhas)))))),
  );
}
