import { api, meta } from '../api.js';
import { h, fill, money, signed, shortDate, toast, select, field, TYPE, monthLabel, confirmDialog } from '../util.js';

const HELP = [
  ['Nubank (conta e Nu Empresas)', 'No app: Extrato › ícone de compartilhar › escolha o período › OFX ou CSV. Também vale o anexo do e-mail do Nubank.'],
  ['Nubank (cartão)', 'O e-mail da fatura traz o OFX. No app: Cartão › Faturas › Exportar.'],
  ['Caixa e Santander', 'No internet banking, exporte o extrato em OFX. Faturas do cartão em PDF também funcionam.'],
];

let pending = null; // preview kept while the person reviews it

export async function importarView(root, state, go) {
  const m = await meta();
  const [history, inbox, goals] = await Promise.all([api.get('imports'), api.get('inbox'), api.get('goals')]);

  const input = h('input', { type: 'file', accept: '.ofx,.csv,.pdf,.txt,.bin,application/pdf,text/csv', class: 'sr-only', id: 'file' });
  const status = h('p', { class: 'muted', 'aria-live': 'polite' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    status.textContent = `Lendo ${file.name}…`;
    try {
      pending = await api.upload('import/preview', file);
      pending.items.forEach((i) => { i.include = !i.duplicate; });
      go();
    } catch (e) {
      status.textContent = e.message;
      toast(e.message, 'err');
    }
    input.value = '';
  });

  // A file shared from another app waits in the service worker's cache.
  if (!pending && state.query.get('compartilhado') && 'caches' in window) {
    const c = await caches.open('share');
    const res = await c.match('/shared-file');
    if (res) {
      await c.delete('/shared-file');
      const name = decodeURIComponent(res.headers.get('x-filename') || 'arquivo');
      const file = new File([await res.blob()], name);
      try {
        pending = await api.upload('import/preview', file);
        pending.items.forEach((i) => { i.include = !i.duplicate; });
      } catch (e) { toast(e.message, 'err'); }
    }
  }
  if (pending) return reviewView(root, m, go, goals);

  fill(root, 
    h('header', { class: 'top plain' }, h('h1', {}, 'Importar extrato')),
    h('section', { class: 'drop' },
      h('label', { for: 'file', class: 'btn primary big' }, 'Escolher arquivo'),
      input,
      h('p', { class: 'muted' }, 'OFX, CSV ou PDF do Nubank, Nu Empresas, Caixa e Santander. O que já estiver lançado é reconhecido e fica de fora.'),
      status),
    inboxSection(inbox, go),
    h('section', { class: 'block' },
      h('h2', {}, 'Como exportar'),
      h('dl', { class: 'help' }, HELP.map(([t, d]) => h('div', {}, h('dt', {}, t), h('dd', {}, d))))),
    history.length ? h('section', { class: 'block' },
      h('h2', {}, 'Importados'),
      h('ul', { class: 'imports' }, history.map((i) => h('li', {},
        h('span', { class: 'imp-main' }, h('span', {}, i.filename || 'Arquivo'), h('small', {}, `${i.account}, ${i.count} ${i.count === 1 ? 'lançamento' : 'lançamentos'}, ${shortDate(i.created_at.slice(0, 10))}`)),
        h('button', {
          class: 'btn ghost small', onclick: async () => {
            if (!(await confirmDialog(`Desfazer a importação de "${i.filename}"? Os ${i.count} lançamentos que ela trouxe serão apagados.`, 'Desfazer'))) return;
            const r = await api.del(`imports/${i.id}`);
            toast(`${r.removed} lançamentos removidos`, 'ok');
            go();
          },
        }, 'Desfazer'))))) : null,
  );
}

function reviewView(root, m, go, goals = []) {
  const p = pending;
  const isCard = p.kind === 'card';
  const owners = isCard ? m.cards : m.accounts;
  const accSel = select([['', 'Escolha…'], ...owners], p.account || '', { 'aria-label': isCard ? 'Cartão' : 'Conta' });
  accSel.addEventListener('change', () => { p.account = accSel.value; });
  const inv = h('input', { type: 'month', value: p.invoice || '' });
  inv.addEventListener('change', () => { p.invoice = inv.value; });

  const counter = h('span');
  const commitBtn = h('button', { class: 'btn primary big' });
  const refresh = () => {
    const n = p.items.filter((i) => i.include).length;
    counter.textContent = `${n} de ${p.items.length} selecionados`;
    commitBtn.textContent = n ? `Importar ${n} ${n === 1 ? 'lançamento' : 'lançamentos'}` : 'Nada selecionado';
    commitBtn.disabled = !n;
  };

  const catList = (type) => {
    if (isCard) return m.categories.filter((c) => c.grp === 'gasto' || c.name === 'Estornos e reembolsos').map((c) => c.name);
    const grp = type === 'entrada' ? ['entrada'] : type === 'saida' ? ['gasto'] : ['neutro', 'entrada', 'gasto'];
    return m.categories.filter((c) => grp.includes(c.grp)).map((c) => c.name);
  };

  const rowFor = (it) => {
    const cb = h('input', { type: 'checkbox', checked: it.include, 'aria-label': `Importar ${it.description}` });
    cb.addEventListener('change', () => { it.include = cb.checked; li.classList.toggle('off', !cb.checked); refresh(); });
    const cats = catList(it.type);
    const cat = select(cats.includes(it.category) ? cats : [it.category, ...cats], it.category, { 'aria-label': 'Categoria', class: it.category === 'A confirmar' ? 'warn' : '' });
    cat.addEventListener('change', () => { it.category = cat.value; cat.classList.toggle('warn', cat.value === 'A confirmar'); });
    let typeSel = null;
    // Caixinha for applications and withdrawals: its balance moves when you import.
    const goalBox = h('span', { class: 'goal-sel' });
    const renderGoal = () => {
      if (isCard || it.type !== 'investimento' || !goals.length || it.category === 'Cripto') { goalBox.replaceChildren(); it.goalId = null; return; }
      const gs = select([['', 'Sem caixinha'], ...goals.map((g) => [String(g.id), g.name])], it.goalId ? String(it.goalId) : '', { 'aria-label': 'Caixinha', class: 'type-sel have' });
      gs.addEventListener('change', () => { it.goalId = gs.value ? Number(gs.value) : null; });
      goalBox.replaceChildren(gs);
    };
    if (!isCard) {
      const opts = Object.entries(TYPE).filter(([k]) => !(k === 'entrada' && it.amount < 0) && !(k === 'saida' && it.amount > 0)).map(([k, v]) => [k, v.label]);
      typeSel = select(opts, it.type, { 'aria-label': 'Tipo', class: `type-sel ${TYPE[it.type].cls}` });
      typeSel.addEventListener('change', () => {
        it.type = typeSel.value;
        typeSel.className = `type-sel ${TYPE[it.type].cls}`;
        const list = catList(it.type);
        if (!list.includes(it.category)) it.category = list[0];
        cat.replaceChildren(...list.map((c) => h('option', { value: c, selected: c === it.category }, c)));
        if (it.type === 'investimento' && !it.goalId && goals[0]) it.goalId = goals[0].id;
        renderGoal();
      });
    }
    renderGoal();
    const li = h('li', { class: `rev ${it.include ? '' : 'off'}` },
      h('label', { class: 'rev-check' }, cb),
      h('div', { class: 'rev-main' },
        h('div', { class: 'rev-top' }, h('span', { class: 'rev-desc' }, it.description), h('span', { class: `num ${isCard ? 'out' : TYPE[it.type].cls}` }, isCard ? money(it.amount) : signed(it.amount))),
        h('div', { class: 'rev-meta' }, h('span', {}, shortDate(it.date)), it.duplicate ? h('span', { class: 'dup' }, 'Já lançado') : null),
        h('div', { class: 'rev-sel' }, typeSel, cat, goalBox)));
    return li;
  };

  commitBtn.addEventListener('click', async () => {
    if (!p.account) { toast(isCard ? 'Escolha o cartão.' : 'Escolha a conta.', 'err'); accSel.focus(); return; }
    commitBtn.disabled = true;
    try {
      const r = await api.post('import/commit', p);
      pending = null;
      const paid = r.paidBills?.length ? `. ${r.paidBills.length === 1 ? `Conta "${r.paidBills[0].description}" marcada como paga` : `${r.paidBills.length} contas marcadas como pagas`}` : '';
      toast(`${r.added} ${r.added === 1 ? 'lançamento importado' : 'lançamentos importados'}${r.skipped ? `, ${r.skipped} já existiam` : ''}${paid}`, 'ok');
      location.hash = isCard ? `#/cartoes?invoice=${p.invoice}&card=${encodeURIComponent(p.account)}` : '#/extrato';
    } catch (e) { toast(e.message, 'err'); commitBtn.disabled = false; }
  });

  const dups = p.items.filter((i) => i.duplicate).length;
  const total = p.items.filter((i) => !i.duplicate).reduce((s, i) => s + i.amount, 0);
  refresh();
  fill(root, 
    h('header', { class: 'top plain' }, h('h1', {}, 'Conferir antes de importar')),
    h('section', { class: 'block review-head' },
      h('p', { class: 'file-name' }, p.filename),
      h('p', { class: 'muted' }, isCard ? 'Fatura de cartão' : 'Extrato de conta', p.period?.start ? `, de ${shortDate(p.period.start)} a ${shortDate(p.period.end)}` : ''),
      h('div', { class: 'grid2' },
        field(isCard ? 'Cartão' : 'Conta', accSel),
        isCard ? field('Fatura de', inv, p.invoice ? monthLabel(p.invoice) : null) : null),
      !isCard && p.balance?.amount != null ? h('p', { class: 'field-hint' }, `Saldo no extrato: ${money(p.balance.amount)} em ${shortDate(p.balance.date)}. O saldo da conta será atualizado.`) : null,
      dups ? h('p', { class: 'notice soft' }, `${dups} ${dups === 1 ? 'lançamento já está' : 'lançamentos já estão'} no app e ${dups === 1 ? 'veio desmarcado' : 'vieram desmarcados'}.`) : null,
      isCard ? h('p', { class: 'muted' }, `Total das compras novas: ${money(total)}. O pagamento da fatura conta como gasto quando sai da conta; aqui os itens servem para ver em que você gastou.`) : null),
    h('div', { class: 'review-bar' }, counter,
      h('button', { class: 'link', onclick: () => { const all = p.items.some((i) => !i.include); p.items.forEach((i) => { i.include = all; }); go(); } }, 'Marcar/desmarcar todos')),
    h('ul', { class: 'review' }, p.items.map(rowFor)),
    h('div', { class: 'sticky-actions' },
      h('button', { class: 'btn ghost', onclick: () => { pending = null; go(); } }, 'Cancelar'),
      commitBtn),
  );
}

const STATUS = { novo: 'Para conferir', importado: 'Importado', 'sem novidades': 'Nada novo', descartado: 'Descartado', erro: 'Não deu para ler' };

function mailStatusText(inbox) {
  if (!inbox.configured) return 'Gmail ainda não ligado. Veja no README como colocar o e-mail e a senha de app no arquivo .env do notebook.';
  const st = inbox.status;
  if (!st) return 'O app confere o Gmail a cada 30 minutos.';
  const at = new Date(st.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return st.ok ? `Gmail conferido em ${at}. O app confere a cada 30 minutos.` : `Última tentativa em ${at} falhou: ${st.error}`;
}

function inboxSection(inbox, go) {
  const fresh = inbox.items.filter((i) => i.status === 'novo');
  const others = inbox.items.filter((i) => i.status !== 'novo').slice(0, 6);
  const checkBtn = h('button', {
    class: 'link', onclick: async () => {
      checkBtn.disabled = true; checkBtn.textContent = 'Buscando…';
      try {
        const r = await api.post('mail/check');
        toast(r.added ? `${r.added} ${r.added === 1 ? 'extrato novo' : 'extratos novos'}` : 'Nenhum extrato novo no Gmail', 'ok');
        go();
      } catch (e) { toast(e.message, 'err'); checkBtn.disabled = false; checkBtn.textContent = 'Buscar agora'; }
    },
  }, 'Buscar agora');
  const open = async (it) => {
    try {
      pending = await api.post(`inbox/${it.id}/preview`);
      pending.items.forEach((i) => { i.include = !i.duplicate; });
      go();
    } catch (e) { toast(e.message, 'err'); }
  };
  const discard = async (it) => {
    await api.post(`inbox/${it.id}/discard`);
    toast('Extrato descartado', 'ok');
    go();
  };
  const row = (it) => {
    const s = it.summary || {};
    const detail = s.error ? s.error
      : [s.account, s.kind === 'card' ? 'fatura' : 'extrato', it.status === 'novo' ? `${s.novos} de ${s.total} novos` : STATUS[it.status]].filter(Boolean).join(', ');
    return h('li', { class: it.status === 'novo' ? 'fresh' : '' },
      h('span', { class: 'imp-main' }, h('span', {}, it.filename), h('small', {}, detail)),
      it.status === 'novo' || it.status === 'erro'
        ? h('span', { class: 'inbox-btns' },
          it.status === 'novo' ? h('button', { class: 'btn primary small', onclick: () => open(it) }, 'Conferir') : null,
          h('button', { class: 'btn ghost small', onclick: () => discard(it) }, 'Descartar'))
        : h('button', { class: 'btn ghost small', onclick: () => open(it) }, 'Abrir'));
  };
  return h('section', { class: 'block' },
    h('div', { class: 'block-head' }, h('h2', {}, 'Chegaram por e-mail'), inbox.configured ? checkBtn : null),
    h('p', { class: 'field-hint' }, mailStatusText(inbox)),
    fresh.length || others.length ? h('ul', { class: 'imports inbox' }, fresh.map(row), others.map(row)) : null);
}
