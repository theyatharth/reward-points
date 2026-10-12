// test/loyalty/proxy-routes.test.js
//
// Task 6, the storefront side: POST /api/proxy/redeem and GET /api/proxy/history over real HTTP
// (an Express app on an ephemeral port), with App Proxy signatures computed the way Shopify does.
// Decision D6: the customer comes from the SIGNED `logged_in_customer_id`; responses are whitelists:
// no internal ids, no notes, no admin names. Fake gateway, fake clock.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { prisma } from '../../web/lib/prisma.js';
import proxyRouter from '../../web/routes/proxy.routes.js';
import { appProxySignature } from '../../web/lib/app-proxy.js';
import { adjustPoints } from '../../web/loyalty/service/adjustment.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { setFixedTime, restoreClock } from '../../web/loyalty/adapters/clock.js';
import { uniqueId } from '../helpers/ids.js';

const SECRET = 'test-app-proxy-secret';
const DAY = 24 * 60 * 60 * 1000;

describe('App proxy storefront routes', () => {
  let server = null;
  let base = '';
  let shop = '';
  let gw = null;
  let adminId = '';
  let customer = '';
  let savedSecret;

  before(async () => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
    savedSecret = process.env.SHOPIFY_API_SECRET;
    process.env.SHOPIFY_API_SECRET = SECRET;
    const app = express();
    app.use('/api/proxy', proxyRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/proxy`;
  });

  beforeEach(async () => {
    shop = `proxy-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    customer = String(uniqueId());
    setFixedTime(new Date('2026-09-01T10:00:00Z'));
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
    await prisma.loyaltyConfig.create({
      data: { shop, spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, rewardExpiryDays: 90, currency: 'INR', ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
    });
    adminId = (await prisma.adminUser.create({ data: { shop, email: `a-${crypto.randomUUID()}@example.test`, passwordHash: 'x' } })).id;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (savedSecret === undefined) delete process.env.SHOPIFY_API_SECRET; else process.env.SHOPIFY_API_SECRET = savedSecret;
    restoreClock();
    await prisma.$disconnect();
  });

  // ---- helpers ----

  /** A signed URL the way Shopify forwards it: shop, logged_in_customer_id, timestamp, then signature. */
  function signed(path, { shopName = shop, customerId = customer, extra = {} } = {}) {
    const params = { shop: shopName, path_prefix: '/apps/rewards-dev', timestamp: String(Math.floor(Date.now() / 1000)), ...extra };
    if (customerId !== null) params.logged_in_customer_id = customerId;
    const signature = appProxySignature(params, SECRET);
    return `${base}${path}?${new URLSearchParams({ ...params, signature })}`;
  }
  const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
  const grant = (points, who = customer) => adjustPoints({
    shop, shopifyCustomerId: who, points, reason: 'Special bonus', note: 'Internal: secret admin reasoning', adminId, idempotencyKey: crypto.randomUUID(),
  });
  const account = async (who = customer) => prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: who } } });

  /** Every key of a JSON value, at any depth. */
  const allKeys = (v, out = new Set()) => {
    if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { out.add(k); allKeys(x, out); });
    return out;
  };

  // ===================== authentication =====================

  test('an unsigned, wrongly signed or tampered request is refused with 401 and does nothing', async () => {
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: customer } });
    await grant(500);

    const unsigned = await post(`${base}/redeem?shop=${shop}&logged_in_customer_id=${customer}`, { idempotencyKey: 'k1' });
    assert.strictEqual(unsigned.status, 401);

    const good = new URL(signed('/redeem'));
    good.searchParams.set('logged_in_customer_id', '123456'); // changed after signing
    assert.strictEqual((await post(good.toString(), { idempotencyKey: 'k2' })).status, 401);

    const wrong = new URL(signed('/redeem'));
    wrong.searchParams.set('signature', 'f'.repeat(64));
    assert.strictEqual((await post(wrong.toString(), { idempotencyKey: 'k3' })).status, 401);
    assert.strictEqual((await fetch(`${base}/history?shop=${shop}&logged_in_customer_id=${customer}`)).status, 401);

    assert.strictEqual((await account()).available, 500, 'nothing was redeemed');
    assert.strictEqual(gw.discounts.size, 0);
  });

  test('a signed request without a logged-in customer is 401; a bad shop is 400', async () => {
    assert.strictEqual((await post(signed('/redeem', { customerId: null }), { idempotencyKey: 'k' })).status, 401);
    assert.strictEqual((await fetch(signed('/history', { customerId: 'abc' }))).status, 401);
    assert.strictEqual((await fetch(signed('/history', { shopName: 'evil.example.com' }))).status, 400);
  });

  test('a shop with no loyalty program is 404', async () => {
    const res = await fetch(signed('/history', { shopName: 'nobody-here.myshopify.com' }));
    assert.strictEqual(res.status, 404);
  });

  // ===================== redeem =====================

  test('redeem: the customer is the SIGNED one, whatever the body says; the code is bound to them', async () => {
    const other = String(uniqueId());
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: customer } });
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: other } });
    await grant(500);
    await grant(500, other);

    const res = await post(signed('/redeem'), { idempotencyKey: crypto.randomUUID(), customerId: other, shopifyCustomerId: other, logged_in_customer_id: other });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await account()).available, 0, 'the signed customer paid');
    assert.strictEqual((await account(other)).available, 500, 'the customer named in the body was untouched');
    const [d] = [...gw.discounts.values()];
    assert.strictEqual(d.customerId, customer);
  });

  test('redeem: success returns exactly the whitelisted fields, value from config, no internal ids', async () => {
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: customer } });
    await grant(500);
    const res = await post(signed('/redeem'), { idempotencyKey: crypto.randomUUID() });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Object.keys(body).sort(), ['balance', 'code', 'currency', 'expiresAt', 'pointsUsed', 'status', 'success', 'value']);
    assert.deepStrictEqual(body.balance, { available: 0 });
    assert.strictEqual(body.value, '50.00');
    assert.strictEqual(body.pointsUsed, 500);
    assert.strictEqual(body.currency, 'INR');
    assert.strictEqual(body.status, 'active');
    assert.match(body.code, /^PROX-[A-Z2-9]{8}$/);
    assert.strictEqual(new Date(body.expiresAt).getTime(), new Date('2026-09-01T10:00:00Z').getTime() + 90 * DAY);
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  });

  test('redeem: the same Idempotency-Key (header or body) twice debits once and returns the same code', async () => {
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: customer } });
    await grant(1000);
    const key = crypto.randomUUID();
    const a = await (await post(signed('/redeem'), {}, { 'Idempotency-Key': key })).json();
    const b = await (await post(signed('/redeem'), { idempotencyKey: key })).json();
    assert.strictEqual(a.success, true);
    assert.strictEqual(b.success, true);
    assert.strictEqual(a.code, b.code);
    assert.strictEqual(gw.discounts.size, 1);
    assert.strictEqual((await account()).available, 0, 'both chunks went into the one code, once');
  });

  test('redeem: a missing or empty key is 400; too few points is 400 with the gap; owed points is 409', async () => {
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: customer } });
    const noKey = await post(signed('/redeem'), {});
    assert.strictEqual(noKey.status, 400);
    assert.strictEqual((await noKey.json()).reason, 'INVALID_KEY');

    await grant(200);
    const short = await post(signed('/redeem'), { idempotencyKey: crypto.randomUUID() });
    const s = await short.json();
    assert.strictEqual(short.status, 400);
    assert.deepStrictEqual([s.success, s.reason, s.needed], [false, 'SHORT', 300]);

    await prisma.loyaltyAccount.update({ where: { id: (await account()).id }, data: { available: 0, debt: 150 } });
    await prisma.pointLot.updateMany({ where: { accountId: (await account()).id }, data: { remaining: 0, status: 'exhausted' } });
    const owed = await post(signed('/redeem'), { idempotencyKey: crypto.randomUUID() });
    const o = await owed.json();
    assert.strictEqual(owed.status, 409);
    assert.deepStrictEqual([o.reason, o.owed], ['OWED', 150]);
    assert.strictEqual(gw.discounts.size, 0);
  });

  test('redeem: Shopify down: 502, no points used, nothing leaks of the error', async () => {
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: customer } });
    await grant(500);
    const rejection = new Error('internal Shopify detail: shpat_SECRET');
    rejection.definitive = true;
    gw.injectFailure(rejection);
    const res = await post(signed('/redeem'), { idempotencyKey: crypto.randomUUID() });
    const text = await res.text();
    assert.strictEqual(res.status, 502);
    assert.ok(!text.includes('shpat_') && !text.includes('internal Shopify detail'));
    assert.strictEqual((await account()).available, 500);
  });

  test('redeem: the fourth attempt in the window is 429', async () => {
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: customer } });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(signed('/redeem'), { idempotencyKey: crypto.randomUUID() })).status);
    assert.deepStrictEqual(statuses, [400, 400, 400, 429], 'three SHORT refusals, then throttled');
  });

  // ===================== history =====================

  test('history: a customer with no account gets an empty whitelisted view', async () => {
    const res = await fetch(signed('/history'));
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(body.balance, { available: 0, pending: 0, owed: 0 });
    assert.deepStrictEqual(body.rule, { pointsPerReward: 500, rewardValue: '50.00', currency: 'INR', holdPeriodDays: 30, earnPoints: 1, earnSpend: '1.00' });
    assert.deepStrictEqual([body.pending, body.rewards, body.history], [[], [], []]);
  });

  test('history: balances, pending points with their date, live codes and entries, and NOTHING internal', async () => {
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: customer } });
    await grant(500);
    // An order that earns pending points, a redemption, and an adjustment with an internal note.
    const { storeWebhook, processPendingWebhooks } = await import('../../web/loyalty/service/webhook.js');
    await storeWebhook({
      shop, topic: 'orders/paid', shopifyWebhookId: crypto.randomUUID(),
      payload: { id: uniqueId(), name: '#1042', customer: { id: customer }, processed_at: '2026-09-01T09:00:00Z', line_items: [{ id: 1, quantity: 1, price: '120', title: 'Item' }] },
    });
    await processPendingWebhooks({ shop });
    const redeemed = await (await post(signed('/redeem'), { idempotencyKey: crypto.randomUUID() })).json();

    const res = await fetch(signed('/history'));
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Object.keys(body).sort(), ['balance', 'history', 'pending', 'rewards', 'rule', 'success']);
    assert.deepStrictEqual(body.balance, { available: 0, pending: 120, owed: 0 });
    assert.deepStrictEqual(body.pending, [{ points: 120, availableOn: '2026-10-01T09:00:00.000Z' }]);
    assert.deepStrictEqual(body.rewards.map((r) => Object.keys(r).sort()), [['code', 'expiresAt', 'value']]);
    assert.strictEqual(body.rewards[0].code, redeemed.code);

    const kinds = body.history.map((h) => `${h.kind}:${h.points}`).sort();
    assert.deepStrictEqual(kinds, ['bonus:500', 'earned:120', 'redeemed:-500']);
    for (const h of body.history) assert.deepStrictEqual(Object.keys(h).sort(), ['date', 'kind', 'label', 'points']);
    assert.ok(body.history.some((h) => h.label === 'Points earned on order 1042'), 'earn label carries only the order reference');

    // The whitelist: no key named like an id, no admin, no note; none of the secret text appears.
    const text = JSON.stringify(body);
    for (const bad of ['id', 'accountId', 'lotId', 'orderId', 'adminId', 'note', 'notes', 'dedupeKey', 'redemptionId', 'discountCodeId', 'shop', 'shopifyCustomerId']) {
      assert.ok(!allKeys(body).has(bad), `no "${bad}" key`);
    }
    for (const secret of ['Internal: secret admin reasoning', adminId, customer, shop]) assert.ok(!text.includes(secret), `"${String(secret).slice(0, 20)}" does not appear`);
  });

  test('history shows only the caller: another customer\'s data never appears', async () => {
    const other = String(uniqueId());
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: customer } });
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: other } });
    await grant(500, other);
    const body = await (await fetch(signed('/history'))).json();
    assert.deepStrictEqual(body.balance, { available: 0, pending: 0, owed: 0 });
    assert.deepStrictEqual(body.history, []);
    const theirs = await (await fetch(signed('/history', { customerId: other }))).json();
    assert.strictEqual(theirs.balance.available, 500);
  });
});
