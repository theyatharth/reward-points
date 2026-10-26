// api.js: the console's only way to talk to the server. Two modes, told apart by the page the server sent:
//   * password console: a session cookie plus the CSRF token on writes;
//   * embedded in the Shopify admin (<meta name="rw-auth" content="shopify">): no cookie, every call carries a fresh
//     App Bridge session token (shopify.idToken()) as a Bearer token. The server takes the shop from that token.
// Reports a lost session or a pending password change to the app so it can show the right screen.

let csrf = '';
let handlers = { lost: () => {}, mustChange: () => {} };

export const embedded = document.querySelector('meta[name="rw-auth"]')?.content === 'shopify';
export const setCsrf = (token) => { csrf = token || ''; };
export const onAuthEvents = (h) => { handlers = { ...handlers, ...h }; };

/** Headers that prove who is asking; null when the page is not running inside the Shopify admin. */
async function credentials(method) {
  if (!embedded) return method === 'GET' ? {} : { 'X-CSRF-Token': csrf };
  try {
    return { Authorization: `Bearer ${await window.shopify.idToken()}` };
  } catch {
    return null;
  }
}

async function send(method, path, body) {
  const auth = await credentials(method);
  if (!auth) return null;
  return fetch(`api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...auth },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

async function call(method, path, body) {
  let res = await send(method, path, body);
  if (!res) return { ok: false, status: 401, data: { error: 'NOT_EMBEDDED' } };
  // An expired token comes back with this header: ask App Bridge for a new one and try once more.
  if (embedded && res.status === 401 && res.headers.get('X-Shopify-Retry-Invalid-Session-Request')) res = (await send(method, path, body)) ?? res;
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
