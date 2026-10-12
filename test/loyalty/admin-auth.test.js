// test/loyalty/admin-auth.test.js
//
// The admin console's login and session handling (web/admin/auth.js, router.js) over real HTTP:
// argon2 login, httpOnly / Secure / SameSite=Strict cookie scoped to the admin path, hashed session tokens,
// forced password change, CSRF (token + Origin), login rate limit, idle and absolute session expiry,
// logout, security headers on the static files. Each test uses a fresh shop, admin and client IP.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { prisma } from '../../web/lib/prisma.js';
import { hashPassword } from '../../web/lib/passwords.js';
import { createAdminRouter } from '../../web/admin/router.js';
import { setFixedTime, restoreClock } from '../../web/loyalty/adapters/clock.js';

const BASE = '/reward-points-dev';
const ONE_TIME = 'one-time-Password-123';
const MIN = 60 * 1000;

describe('Admin console: login, sessions, CSRF', () => {
  let server;
  let url;
  let shop;
  let ip;
  let savedShop;

  before(async () => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
    savedShop = process.env.ADMIN_SHOP;
    const app = express();
    app.set('trust proxy', true);
    app.use('/admin', createAdminRouter({ basePath: BASE }));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/admin`;
  });

  beforeEach(async () => {
    shop = `adminauth-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    process.env.ADMIN_SHOP = shop;
    restoreClock();
    await prisma.loyaltyConfig.create({ data: { shop, ledgerStartAt: new Date('2026-01-01T00:00:00Z') } });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (savedShop === undefined) delete process.env.ADMIN_SHOP; else process.env.ADMIN_SHOP = savedShop;
    restoreClock();
    await prisma.$disconnect();
  });

  // ---- helpers ----

  const makeAdmin = async ({ email = `staff-${crypto.randomUUID()}@example.test`, password = ONE_TIME, mustChange = true } = {}) => {
    const user = await prisma.adminUser.create({ data: { shop, email, passwordHash: await hashPassword(password), mustChangePassword: mustChange } });
    return { user, email, password };
  };

  /** A tiny browser: keeps the session cookie and CSRF token, sends a fixed client IP. */
  function browser() {
    const b = { cookie: '', csrf: '', last: null };
    b.req = async (method, path, { body, headers = {}, raw } = {}) => {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: { 'X-Forwarded-For': ip, ...(b.cookie ? { Cookie: b.cookie } : {}), ...(method !== 'GET' && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: method === 'GET' ? undefined : raw ?? JSON.stringify(body ?? {}),
      });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) b.last = set[0];
      const mine = set.find((c) => c.startsWith('rw_admin='));
      if (mine) b.cookie = mine.split(';')[0].replace(/^rw_admin=$/, '');
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      if (json?.csrfToken) b.csrf = json.csrfToken;
      return { status: res.status, json, text, headers: res.headers, setCookie: set };
    };
    b.login = (email, password) => b.req('POST', '/api/login', { body: { email, password } });
    b.post = (path, body, headers = {}) => b.req('POST', `/api/${path}`, { body, headers: { 'X-CSRF-Token': b.csrf, ...headers } });
    b.get = (path) => b.req('GET', `/api/${path}`);
    return b;
  }

  async function loggedIn({ mustChange = false } = {}) {
    const admin = await makeAdmin({ mustChange });
    const b = browser();
    const r = await b.login(admin.email, admin.password);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    return { b, admin };
  }

  // ===================== login =====================

  test('no session: the API is 401', async () => {
    const b = browser();
    assert.strictEqual((await b.get('session')).status, 401);
    assert.strictEqual((await b.get('meta')).status, 401);
  });

  test('a wrong password and an unknown admin get the SAME answer; both are audited', async () => {
    const admin = await makeAdmin();
    const a = await browser().login(admin.email, 'wrong-password-xx');
    const b = await browser().login(`nobody-${crypto.randomUUID()}@example.test`, 'wrong-password-xx');
    assert.deepStrictEqual([a.status, a.json], [401, { ok: false, error: 'INVALID_CREDENTIALS' }]);
    assert.deepStrictEqual([b.status, b.json], [a.status, a.json]);
    assert.strictEqual(a.setCookie.length, 0);
    assert.strictEqual(await prisma.auditLog.count({ where: { shop, action: 'admin_login_failed' } }), 2);
  });

  test('login is case-insensitive on the email; the cookie is httpOnly, Secure, SameSite=Strict and scoped to the admin path; the token is stored hashed', async () => {
    const admin = await makeAdmin({ email: 'Staff.Person@Example.test' });
    const b = browser();
    const r = await b.login('staff.person@example.TEST', admin.password);
    assert.strictEqual(r.status, 200);
    const cookie = r.setCookie.find((c) => c.startsWith('rw_admin='));
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; SameSite=Strict/);
    assert.match(cookie, new RegExp(`; Path=${BASE}/admin(;|$)`));
    const token = cookie.split(';')[0].slice('rw_admin='.length);
    assert.ok(token.length >= 40);
    const rows = await prisma.adminSession.findMany({ where: { userId: admin.user.id } });
    assert.strictEqual(rows.length, 1);
    assert.notStrictEqual(rows[0].token, token, 'the database holds a hash, not the cookie value');
    assert.strictEqual(rows[0].token, crypto.createHash('sha256').update(token).digest('hex'));
    assert.strictEqual(await prisma.auditLog.count({ where: { shop, action: 'admin_login' } }), 1);
  });

  test('responses never contain the password hash', async () => {
    const { b } = await loggedIn();
    const s = await b.get('session');
    assert.ok(!/argon2|scrypt|passwordHash/.test(s.text));
    assert.deepStrictEqual(Object.keys(s.json).sort(), ['admin', 'csrfToken', 'mustChangePassword', 'ok']);
    assert.deepStrictEqual(Object.keys(s.json.admin), ['email']);
  });

  test('malformed login bodies are 400, not a crash', async () => {
    const b = browser();
    for (const body of [{}, { email: 1, password: 'x' }, { email: 'a@b.c' }, { email: '', password: 'x' }, { email: 'a'.repeat(300), password: 'x' }]) {
      assert.strictEqual((await b.req('POST', '/api/login', { body })).status, 400, JSON.stringify(body).slice(0, 40));
    }
    assert.strictEqual((await b.req('POST', '/api/login', { raw: '{not json', })).status, 400);
  });

  test('a login with a foreign Origin is refused, and so is a non-JSON write', async () => {
    const admin = await makeAdmin();
    const b = browser();
    const foreign = await b.req('POST', '/api/login', { body: { email: admin.email, password: admin.password }, headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(foreign.status, 403);
    assert.strictEqual(foreign.json.error, 'BAD_ORIGIN');
    const same = await b.req('POST', '/api/login', { body: { email: admin.email, password: admin.password }, headers: { Origin: new URL(url).origin } });
    assert.strictEqual(same.status, 200);
    const form = await browser().req('POST', '/api/login', { raw: 'email=a&password=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.strictEqual(form.status, 415);
  });

  // ===================== forced password change =====================

  test('with the one-time password only session, logout and change-password work; everything else is 403', async () => {
    const { b } = await loggedIn({ mustChange: true });
    const s = await b.get('session');
    assert.strictEqual(s.status, 200);
    assert.strictEqual(s.json.mustChangePassword, true);
    const meta = await b.get('meta');
    assert.deepStrictEqual([meta.status, meta.json.error], [403, 'PASSWORD_CHANGE_REQUIRED']);
    const unknown = await b.get('anything-else');
    assert.strictEqual(unknown.status, 403);
  });

  test('change password: wrong current, weak and unchanged passwords are refused; success clears the flag, ends OTHER sessions and is audited', async () => {
    const admin = await makeAdmin();
    const first = browser();
    const second = browser();
    await first.login(admin.email, admin.password);
    await second.login(admin.email, admin.password);

    const wrong = await first.post('change-password', { currentPassword: 'nope-nope-nope', newPassword: 'a-new-long-password-1' });
    assert.deepStrictEqual([wrong.status, wrong.json.error], [400, 'WRONG_CURRENT_PASSWORD']);
    for (const weak of ['short', 'aaaaaaaaaaaaaaaa', admin.password]) {
      const r = await first.post('change-password', { currentPassword: admin.password, newPassword: weak });
      assert.deepStrictEqual([r.status, r.json.error], [400, 'WEAK_PASSWORD'], weak);
    }
    assert.strictEqual((await prisma.adminUser.findUnique({ where: { id: admin.user.id } })).mustChangePassword, true);

    const ok = await first.post('change-password', { currentPassword: admin.password, newPassword: 'a-brand-new-password-9' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await prisma.adminUser.findUnique({ where: { id: admin.user.id } })).mustChangePassword, false);
    assert.strictEqual((await first.get('meta')).status, 200, 'the console is open now');
    assert.strictEqual((await second.get('session')).status, 401, 'the other session was ended');
    assert.strictEqual(await prisma.auditLog.count({ where: { shop, action: 'admin_password_changed' } }), 1);

    assert.strictEqual((await browser().login(admin.email, admin.password)).status, 401, 'the one-time password no longer works');
    assert.strictEqual((await browser().login(admin.email, 'a-brand-new-password-9')).status, 200);
  });

  // ===================== CSRF =====================

  test('every write needs the session\'s CSRF token; a GET does not; a foreign Origin is refused even with the token', async () => {
    const { b } = await loggedIn();
    assert.strictEqual((await b.get('session')).status, 200);

    const none = await b.req('POST', '/api/logout', { body: {} });
    assert.deepStrictEqual([none.status, none.json.error], [403, 'BAD_CSRF']);
    const wrong = await b.req('POST', '/api/logout', { body: {}, headers: { 'X-CSRF-Token': 'f'.repeat(64) } });
    assert.deepStrictEqual([wrong.status, wrong.json.error], [403, 'BAD_CSRF']);
    const foreign = await b.post('logout', {}, { Origin: 'https://evil.example' });
    assert.deepStrictEqual([foreign.status, foreign.json.error], [403, 'BAD_ORIGIN']);
    assert.strictEqual((await b.get('session')).status, 200, 'still logged in after the refused attempts');

    const other = (await loggedIn()).b; // another admin's token is useless here
    assert.strictEqual((await b.post('logout', {}, { 'X-CSRF-Token': other.csrf })).status, 403);

    assert.strictEqual((await b.post('logout', {})).status, 200);
  });

  test('the CSRF token differs per session and cannot be derived from the database', async () => {
    const admin = await makeAdmin({ mustChange: false });
    const a = browser();
    const c = browser();
    await a.login(admin.email, admin.password);
    await c.login(admin.email, admin.password);
    assert.notStrictEqual(a.csrf, c.csrf);
    const stored = (await prisma.adminSession.findMany({ where: { userId: admin.user.id } })).map((s) => s.token);
    assert.ok(!stored.includes(a.csrf), 'not the stored value');
    const hashedOfStored = stored.map((t) => crypto.createHash('sha256').update(`csrf:${t}`).digest('hex'));
    assert.ok(!hashedOfStored.includes(a.csrf), 'not derivable from the stored hash');
  });

  // ===================== logout =====================

  test('logout ends the session, clears the cookie and is audited', async () => {
    const { b, admin } = await loggedIn();
    const old = b.cookie;
    const r = await b.post('logout', {});
    assert.strictEqual(r.status, 200);
    assert.match(r.setCookie.find((c) => c.startsWith('rw_admin=')), /Max-Age=0/);
    assert.strictEqual(await prisma.adminSession.count({ where: { userId: admin.user.id } }), 0);
    const replay = browser();
    replay.cookie = old;
    assert.strictEqual((await replay.get('session')).status, 401, 'the old cookie is dead');
    assert.strictEqual(await prisma.auditLog.count({ where: { shop, action: 'admin_logout' } }), 1);
  });

  // ===================== rate limit =====================

  test('five wrong passwords block the account (even for the right password) with Retry-After; another account is unaffected; success resets', async () => {
    const a = await makeAdmin();
    const other = await makeAdmin();
    for (let i = 0; i < 5; i++) assert.strictEqual((await browser().login(a.email, `wrong-${i}-password`)).status, 401);
    const blocked = await browser().login(a.email, a.password);
    assert.deepStrictEqual([blocked.status, blocked.json.error], [429, 'TOO_MANY_ATTEMPTS']);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.strictEqual((await browser().login(other.email, other.password)).status, 200, 'another account is not affected');

    // Four failures then a success: the counter is cleared, four more failures are still allowed.
    const c = await makeAdmin();
    for (let i = 0; i < 4; i++) await browser().login(c.email, `wrong-${i}-password`);
    assert.strictEqual((await browser().login(c.email, c.password)).status, 200);
    for (let i = 0; i < 4; i++) assert.strictEqual((await browser().login(c.email, `again-${i}-password`)).status, 401);
    assert.strictEqual((await browser().login(c.email, c.password)).status, 200);
  });

  test('the block lifts once the 15-minute window has passed', async () => {
    const a = await makeAdmin();
    for (let i = 0; i < 5; i++) await browser().login(a.email, `wrong-${i}-password`);
    assert.strictEqual((await browser().login(a.email, a.password)).status, 429);
    const key = `acct:${shop}:${a.email.toLowerCase()}`;
    await prisma.$executeRaw`UPDATE "AdminLoginAttempt" SET "windowStart" = NOW() - INTERVAL '16 minutes' WHERE "key" = ${key}`;
    assert.strictEqual((await browser().login(a.email, a.password)).status, 200);
  });

  test('30 failures from one IP (across accounts that do not exist) block that IP only', async () => {
    for (let i = 0; i < 30; i++) await browser().login(`ghost-${i}-${crypto.randomUUID()}@example.test`, 'wrong-password-xx');
    const admin = await makeAdmin();
    const blocked = await browser().login(admin.email, admin.password);
    assert.strictEqual(blocked.status, 429);
    const elsewhere = browser();
    ip = '203.0.113.77';
    const ok = await elsewhere.login(admin.email, admin.password);
    assert.strictEqual(ok.status, 200, 'another address can still log in');
  });

  test('wrong current passwords on the change-password form count toward the same limit', async () => {
    const { b, admin } = await loggedIn();
    for (let i = 0; i < 5; i++) await b.post('change-password', { currentPassword: `wrong-${i}-password`, newPassword: 'a-brand-new-password-9' });
    const r = await b.post('change-password', { currentPassword: admin.password, newPassword: 'a-brand-new-password-9' });
    assert.strictEqual(r.status, 429);
  });

  // ===================== expiry (fake clock) =====================

  test('idle expiry: 60 minutes of silence ends the session; activity slides it', async () => {
    const t0 = new Date('2026-10-12T09:00:00Z').getTime();
    setFixedTime(new Date(t0));
    const { b } = await loggedIn();
    setFixedTime(new Date(t0 + 59 * MIN));
    assert.strictEqual((await b.get('session')).status, 200);
    setFixedTime(new Date(t0 + 59 * MIN + 59 * MIN));
    assert.strictEqual((await b.get('session')).status, 200, 'slid forward by the earlier request');
    setFixedTime(new Date(t0 + 59 * MIN + 59 * MIN + 61 * MIN));
    assert.strictEqual((await b.get('session')).status, 401);
  });

  test('absolute expiry: 8 hours after login the session ends however active it is', async () => {
    const t0 = new Date('2026-10-12T09:00:00Z').getTime();
    setFixedTime(new Date(t0));
    const { b } = await loggedIn();
    let t = t0;
    for (let i = 0; i < 12; i++) { // a request every 50 minutes keeps it idle-alive
      t += 50 * MIN;
      setFixedTime(new Date(t));
      const status = (await b.get('session')).status;
      if (t - t0 < 8 * 60 * MIN) assert.strictEqual(status, 200, `at +${(t - t0) / MIN} min`);
      else { assert.strictEqual(status, 401, `at +${(t - t0) / MIN} min`); return; }
    }
    assert.fail('the session never expired');
  });

  // ===================== static files =====================

  test('the console page and its files carry a strict CSP, no framing, no caching; dotfiles and traversal are refused', async () => {
    const page = await fetch(`${url}/`);
    assert.strictEqual(page.status, 200);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
    assert.strictEqual(page.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(page.headers.get('cache-control'), 'no-store');
    assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await page.text(), /<div id="app">/);

    const js = await fetch(`${url}/static/app.js`);
    assert.strictEqual(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    for (const bad of ['/static/../auth.js', '/static/%2e%2e/auth.js', '/static/.env', '/static/..%2fauth.js']) {
      const r = await fetch(`${url}${bad}`);
      assert.ok([403, 404].includes(r.status), `${bad} -> ${r.status}`);
      assert.ok(!(await r.text()).includes('createHash'), `${bad} served source`);
    }
    assert.strictEqual((await fetch(`${url}/nonsense`)).status, 404);
  });
});
