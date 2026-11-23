import { api, meta } from '../api.js';
import {
  h, fill, money, money0, signed, toast, sheet, field, select, ICON, monthLabel, monthShort, cap, shortDate,
  parseMoneyInput, moneyInputValue, confirmDialog, today, addMonths, thisMonth,
} from '../util.js';

const back = (title, href = '#/mais') => h('header', { class: 'top plain' },
  h('a', { class: 'icon-btn', href, 'aria-label': 'Voltar', html: ICON.left }), h('h1', {}, title));

export async function maisView(root) {
  const items = [
    ['#/metas', 'Caixinhas e metas', 'Quanto tem em cada caixinha e quando chega na meta'],
    ['#/patrimonio', 'Patrimônio', 'Contas, caixinhas, bens e dívidas'],
    ['#/cartoes', 'Faturas dos cartões', 'Em que você gastou em cada fatura'],
    ['#/ano', 'Mês a mês', 'Entrou, gastou e caixinhas em cada mês'],
    ['#/limites', 'Limites por categoria', 'Quanto pode gastar por mês em cada categoria'],
    ['#/ir', 'Imposto de Renda', 'Rendimentos, saúde, educação, bens e dívidas do ano'],
    ['#/backup', 'Backup', 'Baixar ou restaurar todos os dados'],
    ['#/ajustes', 'Ajustes', 'Seus nomes, para reconhecer transferências entre suas contas'],
  ];
  fill(root, 
    h('header', { class: 'top plain' }, h('h1', {}, 'Mais')),
    h('ul', { class: 'menu' }, items.map(([href, t, d]) => h('li', {}, h('a', { href },
      h('span', {}, h('strong', {}, t), h('small', {}, d)), h('span', { html: ICON.chevron }))))),
    h('button', {
      class: 'btn ghost wide', onclick: async () => { await api.post('logout'); location.hash = '#/'; location.reload(); },
    }, 'Sair'),
  );
}

// ---------- Caixinhas ----------
function etaText(g) {
  const falta = g.target - g.current;
  if (falta <= 0) return 'Meta alcançada';
  if (!g.monthly) return `Faltam ${money0(falta)}`;
  const n = Math.ceil(falta / g.monthly);
  return `Faltam ${money0(falta)}. Guardando ${money0(g.monthly)} por mês, chega em ${monthLabel(addMonths(thisMonth(), n)).toLowerCase()}.`;
}

function editGoal(g, onSaved) {
  const name = h('input', { value: g?.name || '', required: true });
  const current = h('input', { inputmode: 'decimal', value: g ? moneyInputValue(g.current) : '' });
  const target = h('input', { inputmode: 'decimal', value: g ? moneyInputValue(g.target) : '' });
  const monthly = h('input', { inputmode: 'decimal', value: g ? moneyInputValue(g.monthly) : '' });
  const save = async (e) => {
    e.preventDefault();
    const body = { name: name.value, current: parseMoneyInput(current.value) || 0, target: parseMoneyInput(target.value) || 0, monthly: parseMoneyInput(monthly.value) || 0 };
    try {
      if (g) await api.put(`goals/${g.id}`, body); else await api.post('goals', body);
      toast('Caixinha salva', 'ok'); s.close(); onSaved();
    } catch (err) { toast(err.message, 'err'); }
  };
  const remove = async () => {
    if (!(await confirmDialog(`Excluir a caixinha "${g.name}"?`))) return;
    await api.del(`goals/${g.id}`); toast('Caixinha excluída', 'ok'); s.close(); onSaved();
  };
  const s = sheet(g ? g.name : 'Nova caixinha', h('form', { class: 'form', onsubmit: save },
    field('Nome', name),
    field('Tem hoje', current, 'Confira o valor no app do banco e atualize aqui.'),
    h('div', { class: 'grid2' }, field('Meta', target), field('Guardar por mês', monthly)),
    h('div', { class: 'row-btns' },
      g ? h('button', { type: 'button', class: 'btn ghost danger-text', onclick: remove }, 'Excluir') : null,
      h('button', { type: 'submit', class: 'btn primary' }, 'Salvar'))));
}

export async function metasView(root, state, go) {
  const goals = await api.get('goals');
  const total = goals.reduce((s, g) => s + g.current, 0);
  fill(root, 
    back('Caixinhas e metas', '#/'),
    h('section', { class: 'have-card small' }, h('p', { class: 'have-label' }, 'Guardado nas caixinhas'), h('p', { class: 'have-total num' }, money(total)),
      h('p', { class: 'have-foot' }, 'Dinheiro guardado não é gasto: ele continua sendo seu.')),
    h('ul', { class: 'goals' }, goals.map((g) => {
      const p = g.target ? Math.min(100, (g.current / g.target) * 100) : 0;
      return h('li', {}, h('button', { class: 'goal-card', onclick: () => editGoal(g, () => go()) },
        h('div', { class: 'goal-top' }, h('strong', {}, g.name), h('span', { class: 'num have' }, money(g.current))),
        h('div', { class: 'meter', 'aria-hidden': 'true' }, h('div', { style: { width: `${p}%` } })),
        h('div', { class: 'goal-foot' }, h('span', {}, `${Math.round(p)}% de ${money0(g.target)}`), h('span', {}, 'Editar')),
        h('p', { class: 'muted' }, etaText(g))));
    })),
    h('button', { class: 'btn ghost wide', onclick: () => editGoal(null, () => go()) }, 'Nova caixinha'),
  );
}

// ---------- Patrimônio ----------
function editAsset(a, onSaved) {
  const name = h('input', { value: a?.name || '', required: true });
  const kind = select(['Conta', 'Bem', 'Investimento', 'Dívida', 'Outros'], a?.kind || 'Bem');
  const account = h('input', { value: a?.account || '', placeholder: 'Ex.: Nubank' });
  const value = h('input', { inputmode: 'decimal', value: a ? moneyInputValue(a.value) : '' });
  const save = async (e) => {
    e.preventDefault();
    let v = Math.abs(parseMoneyInput(value.value) || 0);
    if (kind.value === 'Dívida') v = -v;
    const body = { name: name.value, kind: kind.value, account: kind.value === 'Conta' ? account.value || null : null, value: v, updated: today() };
    try {
      if (a) await api.put(`assets/${a.id}`, body); else await api.post('assets', body);
      toast('Salvo', 'ok'); s.close(); onSaved();
    } catch (err) { toast(err.message, 'err'); }
  };
  const remove = async () => {
    if (!(await confirmDialog(`Excluir "${a.name}"?`))) return;
    await api.del(`assets/${a.id}`); toast('Excluído', 'ok'); s.close(); onSaved();
  };
  const s = sheet(a ? a.name : 'Adicionar ao patrimônio', h('form', { class: 'form', onsubmit: save },
    field('Nome', name),
    h('div', { class: 'grid2' }, field('Tipo', kind), field('Valor', value)),
    field('Banco (só para conta)', account, 'O saldo de uma conta também é atualizado quando você importa um OFX dela.'),
    h('div', { class: 'row-btns' },
      a ? h('button', { type: 'button', class: 'btn ghost danger-text', onclick: remove }, 'Excluir') : null,
      h('button', { type: 'submit', class: 'btn primary' }, 'Salvar'))));
}

export async function patrimonioView(root, state, go) {
  const [assets, goals] = await Promise.all([api.get('assets'), api.get('goals')]);
  const total = assets.reduce((s, a) => s + a.value, 0) + goals.reduce((s, g) => s + g.current, 0);
  const groups = [
    ['Contas', assets.filter((a) => a.kind === 'Conta')],
    ['Bens e investimentos', assets.filter((a) => ['Bem', 'Investimento', 'Outros'].includes(a.kind))],
    ['Dívidas', assets.filter((a) => a.kind === 'Dívida')],
  ];
  const row = (a) => h('li', {}, h('button', { onclick: () => editAsset(a, () => go()) },
    h('span', {}, h('span', {}, a.name), a.updated ? h('small', {}, `atualizado em ${shortDate(a.updated)}`) : null),
    h('span', { class: `num ${a.value < 0 ? 'out' : ''}` }, money(a.value))));
  fill(root, 
    back('Patrimônio', '#/'),
    h('section', { class: 'have-card small' }, h('p', { class: 'have-label' }, 'Patrimônio líquido'), h('p', { class: 'have-total num' }, money(total)),
      h('p', { class: 'have-foot' }, 'Tudo o que você tem, menos o que deve.')),
    ...groups.map(([t, list]) => list.length ? h('section', { class: 'block' }, h('h2', {}, t), h('ul', { class: 'plain-list' }, list.map(row))) : null),
    h('section', { class: 'block' }, h('div', { class: 'block-head' }, h('h2', {}, 'Caixinhas'), h('a', { href: '#/metas' }, 'Editar')),
      h('ul', { class: 'plain-list' }, goals.map((g) => h('li', {}, h('a', { href: '#/metas' }, h('span', {}, g.name), h('span', { class: 'num have' }, money(g.current))))))),
    h('button', { class: 'btn ghost wide', onclick: () => editAsset(null, () => go()) }, 'Adicionar item'),
  );
}

// ---------- Cartões ----------
async function editCardItem(it, onSaved) {
  const m = await meta();
  const cats = m.categories.filter((c) => c.grp === 'gasto' || c.name === 'Estornos e reembolsos').map((c) => c.name);
  const cat = select(cats.includes(it.category) ? cats : [it.category, ...cats], it.category);
  const save = async (e) => {
    e.preventDefault();
    await api.put(`cards/${it.id}`, { category: cat.value });
    toast('Categoria salva', 'ok'); s.close(); onSaved();
  };
  const remove = async () => {
    if (!(await confirmDialog(`Excluir "${it.description}" da fatura?`))) return;
    await api.del(`cards/${it.id}`); toast('Item excluído', 'ok'); s.close(); onSaved();
  };
  const s = sheet(it.description, h('form', { class: 'form', onsubmit: save },
    h('p', { class: 'muted' }, `${it.card}, compra em ${shortDate(it.date)}: ${money(it.amount)}`),
    field('Categoria', cat),
    h('div', { class: 'row-btns' },
      h('button', { type: 'button', class: 'btn ghost danger-text', onclick: remove }, 'Excluir'),
      h('button', { type: 'submit', class: 'btn primary' }, 'Salvar'))));
}

export async function cartoesView(root, state, go) {
  const q = state.query;
  const params = new URLSearchParams();
  if (q.get('invoice')) params.set('invoice', q.get('invoice'));
  if (q.get('card')) params.set('card', q.get('card'));
  const [d, future] = await Promise.all([api.get(`cards?${params}`), api.get('cards/future')]);
  const futureByMonth = [...new Set(future.map((f) => f.invoice))].map((inv) => ({ invoice: inv, cards: future.filter((f) => f.invoice === inv) }));
  const invoiceMonths = [...new Set(d.invoices.map((i) => i.invoice))];
  const ofInvoice = d.invoices.filter((i) => i.invoice === d.invoice);
  const set = (k, v) => { const n = new URLSearchParams(q); if (v) n.set(k, v); else n.delete(k); if (k === 'invoice') n.delete('card'); location.hash = `#/cartoes?${n}`; };
  const total = d.items.reduce((s, i) => s + i.amount, 0);
  fill(root, 
    back('Faturas dos cartões'),
    invoiceMonths.length ? h('div', { class: 'chips scroll' }, invoiceMonths.slice(0, 18).map((m) => h('button', { class: 'chip', 'aria-selected': String(m === d.invoice), onclick: () => set('invoice', m) }, `${cap(monthShort(m))} ${m.slice(2, 4)}`))) : null,
    d.invoice ? h('section', { class: 'block' },
      h('h2', {}, `Faturas de ${monthLabel(d.invoice).toLowerCase()}`),
      h('div', { class: 'chips' },
        h('button', { class: 'chip', 'aria-selected': String(!d.card), onclick: () => set('card', '') }, `Todos ${money0(ofInvoice.reduce((s, i) => s + i.total, 0))}`),
        ofInvoice.map((i) => h('button', { class: 'chip', 'aria-selected': String(d.card === i.card), onclick: () => set('card', i.card) }, `${i.card} ${money0(i.total)}`))),
      h('ul', { class: 'cats' }, d.categorias.map((c) => h('li', {}, h('div', { class: 'cat-row' },
        h('span', { class: 'cat-name' }, c.category), h('span', { class: 'num' }, money(c.total)),
        h('span', { class: 'cat-bar', style: { width: `${d.categorias[0].total > 0 ? Math.max(0, (c.total / d.categorias[0].total) * 100) : 0}%` } })))))) : null,
    futureByMonth.length ? h('section', { class: 'block' },
      h('h2', {}, 'Parcelas que ainda vão vir'),
      h('p', { class: 'muted' }, 'Compras parceladas que já estão nas próximas faturas, antes de qualquer compra nova.'),
      h('ul', { class: 'future' }, futureByMonth.slice(0, 8).map((fm) => h('li', {}, h('details', {},
        h('summary', {}, h('span', {}, monthLabel(fm.invoice)), h('span', { class: 'num out' }, money(fm.cards.reduce((s, c) => s + c.total, 0)))),
        h('ul', {}, fm.cards.flatMap((c) => c.items.map((i) => h('li', {}, h('span', {}, `${c.card}: ${i.description} (${i.parcela})`), h('span', { class: 'num' }, money(i.amount))))))))))) : null,
    d.items.length ? h('section', { class: 'block' }, h('div', { class: 'block-head' }, h('h2', {}, 'Compras'), h('span', { class: 'num muted' }, money(total))),
      h('ul', { class: 'plain-list' }, d.items.map((it) => h('li', {}, h('button', { onclick: () => editCardItem(it, () => go()) },
        h('span', {}, h('span', {}, it.description), h('small', { class: it.category === 'A confirmar' ? 'warn' : '' }, `${shortDate(it.date)}, ${it.category}${d.card ? '' : `, ${it.card}`}`)),
        h('span', { class: `num ${it.amount < 0 ? 'in' : ''}` }, money(it.amount)))))))
      : h('div', { class: 'empty' }, h('p', {}, 'Nenhuma fatura importada ainda.'), h('a', { class: 'btn primary', href: '#/importar' }, 'Importar fatura')),
  );
}

// ---------- Mês a mês ----------
export async function anoView(root, state, go) {
  const y = state.query.get('ano') || state.month.slice(0, 4);
  const d = await api.get(`year?year=${y}`);
  const months = d.months.filter((m) => !m.vazio);
  fill(root, 
    back(`Mês a mês`),
    h('div', { class: 'month-switch' },
      h('a', { class: 'icon-btn', href: `#/ano?ano=${+y - 1}`, 'aria-label': 'Ano anterior', html: ICON.left }),
      h('span', { class: 'month-label' }, y),
      h('a', { class: 'icon-btn', href: `#/ano?ano=${+y + 1}`, 'aria-label': 'Próximo ano', html: ICON.right })),
    h('dl', { class: 'totals' },
      h('div', {}, h('dt', {}, 'Entrou'), h('dd', { class: 'num in' }, money0(d.total.entrou))),
      h('div', {}, h('dt', {}, 'Gastou'), h('dd', { class: 'num out' }, money0(d.total.gastou))),
      h('div', {}, h('dt', {}, 'Caixinhas'), h('dd', { class: 'num have' }, signed(d.total.caixinhas).replace(/,\d\d$/, '')))),
    months.length ? h('ul', { class: 'year-list' }, months.slice().reverse().map((m) => h('li', {},
      h('a', { href: `#/extrato`, onclick: () => go({ month: m.month }, '#/extrato') },
        h('strong', {}, cap(monthLabel(m.month).split(' ')[0])),
        h('dl', {},
          h('div', {}, h('dt', {}, 'Entrou'), h('dd', { class: 'num in' }, money0(m.entrou))),
          h('div', {}, h('dt', {}, 'Gastou'), h('dd', { class: 'num out' }, money0(m.gastou))),
          h('div', {}, h('dt', {}, 'Sobrou'), h('dd', { class: `num ${m.sobrou < 0 ? 'out' : ''}` }, money0(m.sobrou))),
          h('div', {}, h('dt', {}, 'Caixinhas'), h('dd', { class: 'num have' }, signed(m.caixinhas).replace(/,\d\d$/, ''))))))))
      : h('p', { class: 'empty' }, `Nada lançado em ${y}.`),
  );
}

// ---------- Backup ----------
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

export async function backupView(root, state, go) {
  const auto = await api.get('backups');
  const input = h('input', { type: 'file', accept: '.json,application/json', class: 'sr-only', id: 'restore' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch { toast('Este arquivo não é um backup válido.', 'err'); return; }
    const n = (data.transactions || []).length;
    if (!(await confirmDialog(`Restaurar "${f.name}"? Os dados atuais do app serão substituídos pelos ${n} lançamentos do backup.`, 'Restaurar'))) { input.value = ''; return; }
    try {
      const r = await api.post('backup/restore', data);
      toast(`Backup restaurado: ${r.transactions} lançamentos e ${r.cards} compras de cartão`, 'ok');
      location.hash = '#/';
    } catch (e) { toast(e.message, 'err'); }
  });
  const days = [...new Set(auto.files.map((f) => f.day))];
  fill(root,
    back('Backup'),
    h('section', { class: 'block' },
      h('div', { class: 'block-head' }, h('h2', {}, 'Backups automáticos'),
        h('button', { class: 'link', onclick: async () => { await api.post('backups/now'); toast('Backup feito', 'ok'); go(); } }, 'Fazer agora')),
      h('p', { class: 'muted' }, 'Todo dia às 3h o app guarda uma cópia na pasta backups do projeto, no notebook. Ficam os últimos 30 dias.'),
      days.length ? h('ul', { class: 'plain-list' }, days.slice(0, 10).map((d) => {
        const files = auto.files.filter((f) => f.day === d);
        const json = files.find((f) => f.kind === 'json');
        return h('li', {}, h('a', { href: `/api/backups/${json ? json.name : files[0].name}`, download: true },
          h('span', {}, h('span', {}, shortDate(d) + '/' + d.slice(0, 4)), h('small', {}, json ? `${kb(json.size)}, pode restaurar aqui` : 'cópia do banco')),
          h('span', { class: 'muted' }, 'Baixar')));
      })) : h('p', { class: 'muted' }, 'Ainda não houve backup automático.')),
    h('section', { class: 'block' },
      h('h2', {}, 'Baixar backup agora'),
      h('p', { class: 'muted' }, 'Um arquivo com todos os lançamentos, faturas, contas, caixinhas e patrimônio.'),
      h('a', { class: 'btn primary', href: '/api/backup', download: true }, 'Baixar backup')),
    h('section', { class: 'block' },
      h('h2', {}, 'Restaurar'),
      h('p', { class: 'muted' }, 'Substitui tudo o que está no app pelo conteúdo do arquivo.'),
      h('label', { class: 'btn ghost', for: 'restore' }, 'Escolher arquivo de backup'), input),
  );
}

// ---------- Ajustes ----------
const b64ToBytes = (b64) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function pushSection(go) {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const info = await api.get('push/key');
  if (!supported) {
    return h('section', { class: 'block' }, h('h2', {}, 'Avisos no celular'),
      h('p', { class: 'muted' }, /iPhone|iPad/.test(navigator.userAgent)
        ? 'No iPhone, os avisos só funcionam com o app instalado: Compartilhar › Adicionar à Tela de Início, e abra por lá.'
        : 'Este navegador não recebe avisos. Use o app instalado no celular, pelo endereço https.'));
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  const on = !!sub && Notification.permission === 'granted';
  const enable = async () => {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Os avisos foram bloqueados. Libere nas configurações do navegador.', 'err'); return; }
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(info.publicKey) });
      await api.post('push/subscribe', { subscription: s.toJSON(), device: navigator.userAgent.slice(0, 120) });
      await api.post('push/test');
      toast('Avisos ligados neste aparelho', 'ok');
      go();
    } catch (e) { toast(e.message || 'Não deu para ligar os avisos.', 'err'); }
  };
  const disable = async () => {
    await api.post('push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
    toast('Avisos desligados neste aparelho', 'ok');
    go();
  };
  return h('section', { class: 'block' },
    h('h2', {}, 'Avisos no celular'),
    h('p', { class: 'muted' }, 'Contas que vencem em até 2 dias (às 9h), extrato novo que chegou por e-mail e o resumo do mês no dia 1.'),
    on ? h('div', { class: 'row-btns' },
      h('button', { class: 'btn ghost', onclick: disable }, 'Desligar'),
      h('button', { class: 'btn primary', onclick: async () => { const r = await api.post('push/test'); toast(r.sent ? 'Aviso de teste enviado' : 'Não consegui entregar o aviso', r.sent ? 'ok' : 'err'); } }, 'Enviar teste'))
      : h('button', { class: 'btn primary', onclick: enable }, 'Ligar avisos neste aparelho'),
    h('p', { class: 'field-hint' }, on ? `Ligado neste aparelho. Aparelhos com aviso: ${info.devices}.` : `Aparelhos com aviso: ${info.devices}.`));
}

export async function ajustesView(root, state, go) {
  const s = await api.get('settings');
  const owners = h('textarea', { rows: 3 }, s.owner_names.join('\n'));
  const company = h('textarea', { rows: 2 }, s.company_names.join('\n'));
  const senders = h('textarea', { rows: 3 }, s.mail_senders.join('\n'));
  const pdfPass = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Ex.: os 5 primeiros dígitos do CPF' });
  const split = (t) => t.value.split('\n').map((x) => x.trim()).filter(Boolean);
  fill(root,
    back('Ajustes'),
    await pushSection(go),
    h('form', {
      class: 'form block', onsubmit: async (e) => {
        e.preventDefault();
        await api.put('settings', { owner_names: split(owners), company_names: split(company), mail_senders: split(senders) });
        toast('Ajustes salvos', 'ok');
      },
    },
    h('h2', {}, 'Reconhecer lançamentos'),
    field('Seu nome como aparece nos extratos', owners, 'Um por linha. Pix entre contas com esse nome contam como "Entre minhas contas", não como gasto.'),
    field('Sua empresa', company, 'Um por linha. O que a empresa manda para sua conta pessoal entra como Salário PJ.'),
    field('Remetentes no Gmail', senders, 'Um por linha. "me" pega os e-mails que você manda para você mesmo com o arquivo anexo.'),
    h('button', { class: 'btn primary', type: 'submit' }, 'Salvar ajustes')),
    h('form', {
      class: 'form block', onsubmit: async (e) => {
        e.preventDefault();
        if (!pdfPass.value) return;
        await api.put('settings', { pdf_passwords_add: [pdfPass.value] });
        toast('Senha de PDF salva', 'ok');
        go();
      },
    },
    h('h2', {}, 'Senhas de PDF'),
    h('p', { class: 'muted' }, `Faturas em PDF às vezes vêm com senha. O app tenta cada senha salva. Salvas: ${s.pdf_passwords}.`),
    field('Nova senha', pdfPass),
    h('div', { class: 'row-btns' },
      s.pdf_passwords ? h('button', { type: 'button', class: 'btn ghost danger-text', onclick: async () => { await api.put('settings', { pdf_passwords_clear: true }); toast('Senhas apagadas', 'ok'); go(); } }, 'Apagar todas') : null,
      h('button', { class: 'btn primary', type: 'submit' }, 'Salvar senha'))),
  );
}

// ---------- Limites ----------
export async function limitesView(root, state, go) {
  const month = state.month;
  const [m, status, o] = await Promise.all([meta(), api.get(`budgets?month=${month}`), api.get(`overview?month=${month}`)]);
  const spent = Object.fromEntries(o.categorias.map((c) => [c.category, c.total]));
  const byCat = Object.fromEntries(status.map((b) => [b.category, b]));
  const cats = m.categories.filter((c) => c.grp === 'gasto' && !['A confirmar', 'Cartões de crédito'].includes(c.name)).map((c) => c.name)
    .sort((a, b) => (byCat[b] ? 1 : 0) - (byCat[a] ? 1 : 0) || (spent[b] || 0) - (spent[a] || 0));
  const row = (cat) => {
    const b = byCat[cat];
    const used = b ? b.used : spent[cat] || 0;
    const input = h('input', { inputmode: 'decimal', placeholder: 'Sem limite', value: b ? moneyInputValue(b.monthly) : '', 'aria-label': `Limite de ${cat}` });
    input.addEventListener('change', async () => {
      const v = parseMoneyInput(input.value) || 0;
      await api.put('budgets', { category: cat, monthly: v });
      toast(v ? `Limite de ${cat}: ${money0(v)} por mês` : `Limite de ${cat} removido`, 'ok');
      go();
    });
    return h('div', { class: 'limit-row' },
      h('div', {}, h('strong', {}, cat), h('small', {}, b ? `${money(used)} usados (${Math.round(b.pct * 100)}%)` : `${money(used)} neste mês`)),
      input,
      b ? h('div', { class: `meter ${b.pct >= 1 ? 'over' : 'lim'}`, 'aria-hidden': 'true' }, h('div', { style: { width: `${Math.min(100, b.pct * 100)}%` } })) : null);
  };
  fill(root,
    back('Limites por categoria', '#/mais'),
    h('p', { class: 'muted' }, `Uso em ${monthLabel(month).toLowerCase()}: o que saiu da conta mais as compras no cartão da fatura do mês. Você recebe um aviso no celular ao chegar em 80% e ao passar de 100%.`),
    h('section', { class: 'block' }, cats.map(row)),
  );
}

// ---------- Imposto de Renda ----------
function downloadCsv(name, rows) {
  const esc = (v) => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = '\ufeff' + rows.map((r) => r.map((v) => (typeof v === 'number' ? v.toFixed(2).replace('.', ',') : esc(v ?? ''))).join(';')).join('\r\n');
  const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: name });
  document.body.append(a); a.click(); a.remove();
}

export async function irView(root, state) {
  const y = state.query.get('ano') || String(+state.month.slice(0, 4));
  const d = await api.get(`ir?year=${y}`);
  const totalRend = d.rendimentos.reduce((s, r) => s + r.total, 0);
  const lista = (dd) => dd.itens.length
    ? h('ul', { class: 'plain-list' }, dd.itens.map((i) => h('li', {}, h('div', { class: 'plain-row' },
      h('span', {}, h('span', {}, i.description), h('small', {}, `${shortDate(i.date)}, ${i.origem}`)), h('span', { class: 'num' }, money(i.amount))))))
    : h('p', { class: 'muted' }, 'Nada lançado nesta categoria.');
  const csv = () => downloadCsv(`imposto-de-renda-${y}.csv`, [
    ['Resumo para o Imposto de Renda', `ano ${y}`], [],
    ['Rendimentos', 'Total'], ...d.rendimentos.map((r) => [r.category, r.total]), [],
    ['Rendimentos por mês', 'Categoria', 'Total'], ...d.porMes.map((r) => [r.month, r.category, r.total]), [],
    ['Saúde: data', 'Descrição', 'Origem', 'Valor'], ...d.saude.itens.map((i) => [i.date, i.description, i.origem, i.amount]), ['Total', '', '', d.saude.total], [],
    ['Educação: data', 'Descrição', 'Origem', 'Valor'], ...d.educacao.itens.map((i) => [i.date, i.description, i.origem, i.amount]), ['Total', '', '', d.educacao.total], [],
    ['Bens e direitos', 'Valor atual'], ...d.bens.map((b) => [b.name, b.value]), [],
    ['Dívidas', 'Saldo devedor'], ...d.dividas.map((b) => [b.name, b.value]),
  ]);
  fill(root,
    back('Imposto de Renda', '#/mais'),
    h('div', { class: 'month-switch' },
      h('a', { class: 'icon-btn', href: `#/ir?ano=${+y - 1}`, 'aria-label': 'Ano anterior', html: ICON.left }),
      h('span', { class: 'month-label' }, `Ano de ${y}`),
      h('a', { class: 'icon-btn', href: `#/ir?ano=${+y + 1}`, 'aria-label': 'Próximo ano', html: ICON.right })),
    h('p', { class: 'note-box' }, `Isto organiza o que está no app para a declaração de ${+y + 1}. Confira com os informes do banco, do empregador e da contabilidade: o que a empresa te pagou pode ser pró-labore ou lucro, e cada um entra num lugar diferente.`),
    h('section', { class: 'block' },
      h('h2', {}, 'Rendimentos'),
      h('ul', { class: 'plain-list' }, d.rendimentos.map((r) => h('li', {}, h('div', { class: 'plain-row' }, h('span', {}, h('span', {}, r.category), h('small', {}, `${r.n} ${r.n === 1 ? 'entrada' : 'entradas'}`)), h('span', { class: 'num in' }, money(r.total)))))),
      h('p', { class: 'ir-total' }, h('span', {}, 'Total recebido'), h('span', { class: 'num in' }, money(totalRend)))),
    h('section', { class: 'block' }, h('div', { class: 'block-head' }, h('h2', {}, 'Saúde (dedutível)'), h('span', { class: 'num' }, money(d.saude.total))),
      h('p', { class: 'field-hint' }, 'Guarde os recibos com CPF/CNPJ de quem atendeu. Farmácia só conta se for parte de internação.'), lista(d.saude)),
    h('section', { class: 'block' }, h('div', { class: 'block-head' }, h('h2', {}, 'Educação (dedutível até o limite)'), h('span', { class: 'num' }, money(d.educacao.total))), lista(d.educacao)),
    h('section', { class: 'block' }, h('h2', {}, 'Bens e direitos'),
      h('ul', { class: 'plain-list' }, d.bens.map((b) => h('li', {}, h('div', { class: 'plain-row' }, h('span', {}, b.name), h('span', { class: 'num have' }, money(b.value)))))),
      h('p', { class: 'field-hint' }, 'Valores de hoje. Na declaração vale o saldo em 31/12 e, para bens, o valor de compra.')),
    d.dividas.length ? h('section', { class: 'block' }, h('h2', {}, 'Dívidas'),
      h('ul', { class: 'plain-list' }, d.dividas.map((b) => h('li', {}, h('div', { class: 'plain-row' }, h('span', {}, b.name), h('span', { class: 'num out' }, money(b.value))))))) : null,
    h('button', { class: 'btn primary wide', onclick: csv }, 'Baixar planilha (CSV)'),
  );
}
