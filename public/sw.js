// Service worker: keeps the app shell available offline and receives files
// shared from other apps (Android share sheet → "Finanças").
const VERSION = 'v5';
const SHELL = [
  '/', '/styles.css', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png',
  '/js/app.js', '/js/api.js', '/js/util.js',
  '/js/views/home.js', '/js/views/extrato.js', '/js/views/importar.js', '/js/views/contas.js', '/js/views/mais.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(`shell-${VERSION}`).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== `shell-${VERSION}`).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  // A statement shared from the bank app: keep it and open the import screen.
  if (url.pathname === '/share' && e.request.method === 'POST') {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const file = form.get('file');
      if (file) {
        const c = await caches.open('share');
        await c.put('/shared-file', new Response(file, { headers: { 'x-filename': encodeURIComponent(file.name || 'arquivo') } }));
      }
      return Response.redirect('/#/importar?compartilhado=1', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  // Network first so a new version shows up right away; cache when offline.
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(`shell-${VERSION}`).then((c) => c.put(e.request.mode === 'navigate' ? '/' : e.request, copy));
    }
    return res;
  }).catch(async () => (await caches.match(e.request.mode === 'navigate' ? '/' : e.request)) || Response.error()));
});

// Notifications sent by the app (bills due, new statement, month summary).
self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch { msg = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title || 'Finanças', {
    body: msg.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: msg.tag,
    data: { url: msg.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) { await w.focus(); return w.navigate(url); }
    }
    return self.clients.openWindow(url);
  })());
});
