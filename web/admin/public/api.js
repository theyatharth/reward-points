// api.js: the console's only way to talk to the server. Sends the CSRF token on writes; reports a lost
// session or a pending password change to the app so it can show the right screen.

let csrf = '';
let handlers = { lost: () => {}, mustChange: () => {} };

export const setCsrf = (token) => { csrf = token || ''; };
export const onAuthEvents = (h) => { handlers = { ...handlers, ...h }; };

async function call(method, path, body) {
  const res = await fetch(`api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401 && path !== 'login') handlers.lost();
  if (res.status === 403 && data && data.error === 'PASSWORD_CHANGE_REQUIRED') handlers.mustChange();
  return { ok: res.ok && data?.ok !== false, status: res.status, data: data || {} };
}

export const api = {
  get: (path) => call('GET', path),
  post: (path, body) => call('POST', path, body),
};

export const newKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);
