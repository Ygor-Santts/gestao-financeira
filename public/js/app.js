import { api, setUnauthorizedHandler } from './api.js';
import { h, ICON, thisMonth, toast } from './util.js';
import { homeView } from './views/home.js';
import { extratoView } from './views/extrato.js';
import { importarView } from './views/importar.js';
import { contasView } from './views/contas.js';
import { maisView, metasView, patrimonioView, cartoesView, anoView, backupView, ajustesView, limitesView, irView } from './views/mais.js';

const ROUTES = {
  '': [homeView, 'inicio'], extrato: [extratoView, 'extrato'], importar: [importarView, 'importar'], contas: [contasView, 'contas'],
  mais: [maisView, 'mais'], metas: [metasView, 'mais'], patrimonio: [patrimonioView, 'mais'], cartoes: [cartoesView, 'mais'],
  ano: [anoView, 'mais'], backup: [backupView, 'mais'], ajustes: [ajustesView, 'mais'], limites: [limitesView, 'mais'], ir: [irView, 'mais'],
};

const NAV = [
  ['inicio', '#/', 'Início', ICON.home], ['extrato', '#/extrato', 'Extrato', ICON.list],
  ['importar', '#/importar', 'Importar', ICON.upload], ['contas', '#/contas', 'Contas', ICON.bills], ['mais', '#/mais', 'Mais', ICON.more],
];

const state = {
  month: (() => { try { return sessionStorage.getItem('month') || thisMonth(); } catch { return thisMonth(); } })(),
  query: new URLSearchParams(),
};

const main = h('main', { id: 'main', tabindex: '-1' });
const nav = h('nav', { class: 'tabbar', 'aria-label': 'Principal' }, NAV.map(([k, href, label, icon]) =>
  h('a', { href, 'data-k': k, class: k === 'importar' ? 'tab-import' : '' }, h('span', { class: 'tab-ico', html: icon }), h('span', {}, label))));

let rendering = 0;
async function render() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const [view, tab] = ROUTES[path] || ROUTES[''];
  state.query = new URLSearchParams(qs || '');
  nav.querySelectorAll('a').forEach((a) => (a.dataset.k === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  const id = ++rendering;
  main.setAttribute('aria-busy', 'true');
  const box = h('div', { class: 'view' });
  try {
    await view(box, state, go);
    if (id !== rendering) return;
    main.replaceChildren(box);
  } catch (e) {
    if (id !== rendering) return;
    main.replaceChildren(h('div', { class: 'empty' }, h('p', {}, e.message), h('button', { class: 'btn ghost', onclick: render }, 'Tentar de novo')));
  } finally {
    main.removeAttribute('aria-busy');
  }
}

// Re-render the current screen, optionally changing the month or the route.
function go(patch = {}, hash) {
  if (patch.month) {
    state.month = patch.month;
    try { sessionStorage.setItem('month', patch.month); } catch { /* private mode */ }
  }
  if (hash && location.hash !== hash) { location.hash = hash; return; }
  render();
}

function loginView() {
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true, 'aria-label': 'Senha' });
  const err = h('p', { class: 'login-err', 'aria-live': 'assertive' });
  const form = h('form', {
    class: 'login', onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      try {
        await api.post('login', { password: pass.value });
        start();
      } catch (ex) { err.textContent = ex.message; pass.select(); }
    },
  },
  h('div', { class: 'login-mark', 'aria-hidden': 'true' }, h('span', { class: 'in' }), h('span', { class: 'out' }), h('span', { class: 'have' })),
  h('h1', {}, 'Finanças'),
  h('p', { class: 'muted' }, 'O que entrou, o que você gastou e o que está guardado.'),
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Senha'), pass),
  err,
  h('button', { class: 'btn primary big', type: 'submit' }, 'Entrar'));
  document.body.replaceChildren(form);
  pass.focus();
}

let started = false;
async function start() {
  document.body.replaceChildren(h('a', { class: 'skip', href: '#main', onclick: (e) => { e.preventDefault(); main.focus(); } }, 'Pular para o conteúdo'), main, nav);
  if (!started) {
    started = true;
    window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  }
  render();
}

setUnauthorizedHandler(() => loginView());

api.get('me').then(start).catch(() => loginView());

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'activated' && navigator.serviceWorker.controller) toast('App atualizado. Ele já está usando a versão nova.');
      });
    });
  }).catch(() => {});
}
