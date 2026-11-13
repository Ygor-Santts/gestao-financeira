// Thin fetch wrapper. A 401 sends the person back to the login screen.
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function call(method, path, body, headers = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (body instanceof Blob || body instanceof ArrayBuffer) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  let res;
  try {
    res = await fetch(`/api/${path}`, opts);
  } catch {
    throw new Error('Sem conexão com o servidor. Confira a internet e tente de novo.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') { onUnauthorized(); throw new Error(data.error || 'Entre com sua senha.'); }
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

export const api = {
  get: (p) => call('GET', p),
  post: (p, b) => call('POST', p, b ?? {}),
  put: (p, b) => call('PUT', p, b),
  del: (p) => call('DELETE', p),
  upload: (p, file) => call('POST', p, file, { 'x-filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' }),
};

// Categories, accounts and cards change rarely: load once per session.
let metaCache = null;
export async function meta(force = false) {
  if (!metaCache || force) metaCache = await api.get('meta');
  return metaCache;
}
