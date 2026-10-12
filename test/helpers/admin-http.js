// test/helpers/admin-http.js
//
// An admin console under test: the real router on an ephemeral port, an admin with a changed password, and a small
// "browser" that keeps the session cookie and CSRF token. Used by the per-view admin API tests.

import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { prisma } from '../../web/lib/prisma.js';
import { hashPassword } from '../../web/lib/passwords.js';
import { createAdminRouter } from '../../web/admin/router.js';

export async function startConsole() {
  const app = express();
  app.set('trust proxy', true);
  app.use('/admin', createAdminRouter({ basePath: '/reward-points-dev' }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/admin`;
  return { url, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Creates an admin of `shop` and returns a logged-in browser. mustChange = false: the console is open. */
export async function adminBrowser(url, shop, { mustChange = false } = {}) {
  const password = `Correct-horse-${crypto.randomUUID()}`;
  const email = `staff-${crypto.randomUUID()}@example.test`;
  const admin = await prisma.adminUser.create({ data: { shop, email, passwordHash: await hashPassword(password), mustChangePassword: mustChange } });
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const b = { cookie: '', csrf: '', admin, email, password };
  b.req = async (method, path, body, headers = {}) => {
    const res = await fetch(`${url}/api/${path}`, {
      method,
      headers: { 'X-Forwarded-For': ip, ...(b.cookie ? { Cookie: b.cookie } : {}), ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': b.csrf } : {}), ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const mine = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('rw_admin='));
    if (mine) b.cookie = mine.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (json?.csrfToken) b.csrf = json.csrfToken;
    return { status: res.status, json, text };
  };
  b.get = (path) => b.req('GET', path);
  b.post = (path, body, headers) => b.req('POST', path, body, headers);
  const login = await b.req('POST', 'login', { email, password });
  if (login.status !== 200) throw new Error(`test admin could not log in: ${login.status}`);
  return b;
}

/** Every key at any depth of a JSON value. */
export function allKeys(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((x) => allKeys(x, out));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, x]) => { out.add(k); allKeys(x, out); });
  return out;
}
