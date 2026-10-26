// test/loyalty/admin-shopify-auth.test.js
//
// The console embedded in the Shopify admin (ADMIN_AUTH=shopify): every /admin/api call is authenticated by the App Bridge
// session token alone. Forged, expired, wrong-app, other-shop and missing tokens are refused; the shop always comes from
// the verified token; the audit log records the Shopify user id; the password endpoints do not exist in this mode.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { adminAuthMode, embeddedCsp } from '../../web/admin/router.js';
import { startEmbeddedConsole, sessionToken, installShop, TEST_API_KEY } from '../helpers/shopify-embedded.js';
import { startConsole } from '../helpers/admin-http.js';

const newShop = (tag) => `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
const RETRY = 'x-shopify-retry-invalid-session-request';

describe('Embedded console: session tokens', () => {
  let site;
  let shopA;
  let shopB;

  before(async () => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
    site = await startEmbeddedConsole();
    shopA = newShop('emb-a');
    shopB = newShop('emb-b');
    for (const [shop, customer] of [[shopA, '1111'], [shopB, '2222']]) {
      await installShop(shop);
      await prisma.loyaltyConfig.create({
        data: { shop, spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, currency: 'INR', holdPeriodDays: 30, ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
      });
      await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: customer, available: 700 } });
    }
  });
  after(async () => {
    await site.close();
    await prisma.$disconnect();
  });

  // ---------- refused ----------

  test('no token: 401 on every kind of call, JSON, nothing served', async () => {
    for (const [method, path] of [['GET', 'session'], ['GET', 'overview'], ['GET', 'customers?query=1111'], ['GET', 'audit'], ['POST', 'customers/1111/adjust'], ['POST', 'rules']]) {
      const r = await site.call(method, path);
      assert.strictEqual(r.status, 401, `${method} ${path}`);
      assert.strictEqual(r.json?.error, 'NOT_LOGGED_IN');
    }
    const r = await site.call('GET', 'overview', { headers: { Authorization: 'Bearer ' } });
    assert.strictEqual(r.status, 401);
    const basic = await site.call('GET', 'overview', { headers: { Authorization: 'Basic abc' } });
    assert.strictEqual(basic.status, 401);
  });

  test('a token in the query string is not accepted on the API (header only)', async () => {
    const r = await site.call('GET', `overview?id_token=${sessionToken(shopA)}`);
    assert.strictEqual(r.status, 401);
  });

  test('forged tokens: wrong secret, alg none, tampered payload, garbage', async () => {
    const forged = sessionToken(shopA, { secret: 'not-the-app-secret-not-the-app-secret' });
    const good = sessionToken(shopA);
    const [h, p, s] = good.split('.');
    const swapped = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), dest: `https://${shopB}`, iss: `https://${shopB}/admin` })).toString('base64url');
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
    for (const token of [forged, `${h}.${swapped}.${s}`, none, 'abc.def.ghi', 'garbage', `${h}.${p}.`]) {
      const r = await site.call('GET', 'overview', { token });
      assert.strictEqual(r.status, 401, token.slice(0, 30));
      assert.strictEqual(r.json?.error, 'INVALID_SESSION_TOKEN');
    }
  });

  test('an expired token (and one not valid yet) is refused and the client is told to fetch a new one', async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const token of [sessionToken(shopA, { exp: now - 120, nbf: now - 300 }), sessionToken(shopA, { nbf: now + 300, exp: now + 400 })]) {
      const r = await site.call('GET', 'session', { token });
      assert.strictEqual(r.status, 401);
      assert.strictEqual(r.headers.get(RETRY), '1');
    }
  });

  test('a token for another app (wrong audience) is refused', async () => {
    const r = await site.call('GET', 'overview', { token: sessionToken(shopA, { aud: 'some-other-apps-api-key' }) });
    assert.strictEqual(r.status, 401);
  });

  test('a token that does not name one real myshopify.com shop is refused', async () => {
    for (const opts of [
      { dest: 'https://evil.example.com', iss: 'https://evil.example.com/admin' },
      { dest: `https://${shopA}`, iss: `https://${shopB}/admin` },
      { dest: `https://${shopA}.evil.example.com`, iss: `https://${shopA}.evil.example.com/admin` },
      { dest: 'not a url', iss: 'not a url' },
      { sub: '' },
    ]) {
      const r = await site.call('GET', 'overview', { token: sessionToken(shopA, opts) });
      assert.strictEqual(r.status, 401, JSON.stringify(opts));
    }
  });

  // ---------- accepted: the shop comes from the token ----------

  test('a valid token reads its own shop, and /session says who and where', async () => {
    const r = await site.call('GET', 'session', { token: sessionToken(shopA, { sub: '9001' }) });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.admin, { shop: shopA, shopifyUserId: '9001' });
    assert.strictEqual(r.json.mustChangePassword, false);
    const o = await site.call('GET', 'overview', { token: sessionToken(shopA) });
    assert.strictEqual(o.status, 200);
  });

  test('other shop: a token for B sees only B, whatever ?shop= or the body says', async () => {
    const tokenB = sessionToken(shopB);
    for (const q of ['customers?query=1111', `customers?query=1111&shop=${shopA}`]) {
      const r = await site.call('GET', q, { token: tokenB });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json.results, [], q);
    }
    const own = await site.call('GET', `customers?query=2222&shop=${shopA}`, { token: tokenB });
    assert.deepStrictEqual(own.json.results.map((c) => c.shopifyCustomerId), ['2222']);
    assert.strictEqual((await site.call('GET', 'customers/1111', { token: tokenB })).status, 404);
    // A write aimed at A's customer, with A's shop in the body and the query, finds nothing in B.
    const w = await site.call('POST', `customers/1111/adjust?shop=${shopA}`, { token: tokenB, body: { shop: shopA, points: 50, reason: 'Missing points', note: 'cross shop attempt', idempotencyKey: crypto.randomUUID() } });
    assert.strictEqual(w.status, 404);
    assert.strictEqual((await prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop: shopA, shopifyCustomerId: '1111' } } })).available, 700);
  });

  test('a token for a shop with no rewards set up yet reads nothing of anyone else', async () => {
    const empty = newShop('emb-empty');
    await installShop(empty);
    const r = await site.call('GET', 'customers?query=1111', { token: sessionToken(empty) });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.results, []);
    const audit = await site.call('GET', 'audit', { token: sessionToken(empty) });
    assert.deepStrictEqual(audit.json.entries, []);
  });

  // ---------- audit records the Shopify user ----------

  test('an adjustment is audited with the Shopify user id, no admin row and no e-mail', async () => {
    const token = sessionToken(shopA, { sub: '77001' });
    const r = await site.call('POST', 'customers/1111/adjust', { token, body: { points: 25, reason: 'Missing points', note: 'embedded console test', idempotencyKey: crypto.randomUUID() } });
    assert.strictEqual(r.status, 200, r.text);
    const rows = await prisma.auditLog.findMany({ where: { shop: shopA, action: 'points_adjusted' } });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].shopifyUserId, '77001');
    assert.strictEqual(rows[0].adminId, null);

    const list = await site.call('GET', 'audit', { token });
    assert.strictEqual(list.json.entries[0].admin, 'Shopify user 77001');
    const detail = await site.call('GET', 'customers/1111', { token });
    assert.ok(detail.json.ledger.entries.some((e) => e.adminEmail === 'Shopify user 77001' && e.adminNote === 'embedded console test'));
    // B's audit log does not show it.
    const other = await site.call('GET', 'audit', { token: sessionToken(shopB) });
    assert.deepStrictEqual(other.json.entries, []);
  });

  test('a rules change is audited with the Shopify user id', async () => {
    const token = sessionToken(shopB, { sub: '88002' });
    const rules = await site.call('GET', 'rules', { token });
    assert.strictEqual(rules.status, 200);
    const save = await site.call('POST', 'rules', { token, body: { expected: rules.json.program.updatedAt, changes: { holdPeriodDays: 14 } } });
    assert.strictEqual(save.status, 200, save.text);
    const row = await prisma.auditLog.findFirst({ where: { shop: shopB, action: 'rules_changed' } });
    assert.strictEqual(row.shopifyUserId, '88002');
    assert.strictEqual(row.adminId, null);
  });

  // ---------- no password in this mode ----------

  test('login, logout and change-password do not exist (a valid token gets a 404, no token a 401)', async () => {
    const token = sessionToken(shopA);
    for (const p of ['login', 'logout', 'change-password']) {
      assert.strictEqual((await site.call('POST', p, { token, body: { email: 'a@b.test', password: 'x' } })).status, 404, p);
      assert.strictEqual((await site.call('POST', p, { body: { email: 'a@b.test', password: 'x' } })).status, 401, p);
    }
    // An admin cookie does nothing here.
    const r = await site.call('GET', 'overview', { headers: { Cookie: 'rw_admin=abcdefghijklmnopqrstuvwxyz0123456789' } });
    assert.strictEqual(r.status, 401);
  });

  // ---------- the page ----------

  test('the page carries App Bridge and the API key, may be framed by this shop only, and sets no cookie', async () => {
    const r = await site.call('GET', `?shop=${shopA}&embedded=1`);
    assert.strictEqual(r.status, 200);
    assert.match(r.text, new RegExp(`<meta name="shopify-api-key" content="${TEST_API_KEY}">`));
    assert.match(r.text, /<script src="https:\/\/cdn\.shopify\.com\/shopifycloud\/app-bridge\.js"><\/script>/);
    assert.match(r.text, /<meta name="rw-auth" content="shopify">/);
    assert.ok(r.text.indexOf('app-bridge.js') < r.text.indexOf('static/app.js'), 'App Bridge loads before the console');
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp.includes(`frame-ancestors https://admin.shopify.com https://${shopA}`), csp);
    assert.ok(csp.includes('script-src \'self\' https://cdn.shopify.com'));
    assert.strictEqual(r.headers.get('x-frame-options'), null);
    assert.strictEqual(r.headers.get('set-cookie'), null);
  });

  test('a shop that is not a shop name gets no frame-ancestors entry (no header injection)', async () => {
    for (const shop of ['evil.example.com', 'a.myshopify.com;script-src *', 'x y.myshopify.com']) {
      const r = await site.call('GET', `?shop=${encodeURIComponent(shop)}`);
      const csp = r.headers.get('content-security-policy');
      assert.ok(csp.includes('frame-ancestors https://admin.shopify.com'), csp);
      assert.ok(!csp.includes('evil'), csp);
      assert.ok(!csp.includes('script-src *'), csp);
    }
    assert.strictEqual(embeddedCsp(null).includes('frame-ancestors https://admin.shopify.com'), true);
  });

  test('the password console is unchanged: no App Bridge, never framed, login still works', async () => {
    const plain = await startConsole();
    try {
      const r = await fetch(`${plain.url}/`);
      const text = await r.text();
      assert.ok(!text.includes('app-bridge'));
      assert.ok(!text.includes('rw-auth'));
      assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
      assert.strictEqual((await fetch(`${plain.url}/api/session`)).status, 401);
      // A Shopify session token means nothing to the password console.
      const withToken = await fetch(`${plain.url}/api/overview`, { headers: { Authorization: `Bearer ${sessionToken(shopA)}` } });
      assert.strictEqual(withToken.status, 401);
    } finally {
      await plain.close();
    }
  });
});

describe('ADMIN_AUTH setting', () => {
  test('password by default; shopify or password, any case; anything else is an error, not a silent default', () => {
    assert.strictEqual(adminAuthMode(undefined), 'password');
    assert.strictEqual(adminAuthMode(''), 'password');
    assert.strictEqual(adminAuthMode('password'), 'password');
    assert.strictEqual(adminAuthMode(' Shopify '), 'shopify');
    for (const bad of ['shopfy', 'none', 'true', '0']) assert.throws(() => adminAuthMode(bad), /ADMIN_AUTH must be/);
  });

  test('shopify mode without the shopify instance refuses to start', async () => {
    const { createAdminRouter } = await import('../../web/admin/router.js');
    assert.throws(() => createAdminRouter({ authMode: 'shopify' }), /needs the shopifyApp/);
  });
});

describe('Console api.js in the embedded page', () => {
  const realFetch = globalThis.fetch;
  let seq = 0;
  const load = async ({ meta, shopifyObj }) => {
    globalThis.document = { querySelector: (sel) => (sel === 'meta[name="rw-auth"]' && meta ? { content: meta } : null) };
    globalThis.window = shopifyObj ? { shopify: shopifyObj } : {};
    return import(`../../web/admin/public/api.js?case=${++seq}`);
  };
  after(() => {
    globalThis.fetch = realFetch;
    delete globalThis.document;
    delete globalThis.window;
  });
  const reply = (status, body, headers = {}) => ({ status, ok: status < 400, headers: { get: (k) => headers[k] ?? null }, json: async () => body });

  test('sends a fresh session token as a Bearer header, never the CSRF header or a cookie', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return reply(200, { ok: true }); };
    let n = 0;
    const { api } = await load({ meta: 'shopify', shopifyObj: { idToken: async () => `tok-${++n}` } });
    await api.get('overview');
    await api.post('rules', { a: 1 });
    assert.deepStrictEqual(calls.map((c) => c.init.headers.Authorization), ['Bearer tok-1', 'Bearer tok-2']);
    assert.ok(calls.every((c) => !('X-CSRF-Token' in c.init.headers)));
  });

  test('an expired token: asks App Bridge for a new one and tries once more; a second 401 is reported as a lost session', async () => {
    let n = 0;
    let lost = 0;
    globalThis.fetch = async (_url, init) => (init.headers.Authorization === 'Bearer tok-2' ? reply(200, { ok: true, x: 1 }) : reply(401, { ok: false }, { 'X-Shopify-Retry-Invalid-Session-Request': '1' }));
    const mod = await load({ meta: 'shopify', shopifyObj: { idToken: async () => `tok-${++n}` } });
    mod.onAuthEvents({ lost: () => { lost++; } });
    const ok = await mod.api.get('overview');
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.data.x, 1);
    assert.strictEqual(lost, 0);
    globalThis.fetch = async () => reply(401, { ok: false }, { 'X-Shopify-Retry-Invalid-Session-Request': '1' });
    const bad = await mod.api.get('overview');
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(lost, 1);
  });

  test('outside the Shopify admin (no App Bridge): no request is made', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return reply(200, {}); };
    const mod = await load({ meta: 'shopify', shopifyObj: null });
    const r = await mod.api.get('overview');
    assert.strictEqual(called, false);
    assert.deepStrictEqual([r.ok, r.status, r.data.error], [false, 401, 'NOT_EMBEDDED']);
  });

  test('the password console still sends the CSRF header on writes and no Authorization', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => { calls.push(init); return reply(200, { ok: true }); };
    const mod = await load({ meta: null, shopifyObj: null });
    mod.setCsrf('csrf-1');
    await mod.api.post('rules', {});
    await mod.api.get('overview');
    assert.strictEqual(calls[0].headers['X-CSRF-Token'], 'csrf-1');
    assert.ok(calls.every((c) => !('Authorization' in c.headers)));
  });
});
