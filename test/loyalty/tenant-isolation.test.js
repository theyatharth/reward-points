// test/loyalty/tenant-isolation.test.js
//
// Three shops in ONE database never see or change each other's data, in the admin API and in the storefront (App Proxy) API.
//
//   shop A: INR, 500 points = 50.00      shop B: USD, 200 points = 20.00      shop C: EUR, 300 points = 15.00
//
// Different rules and currencies, so a leak shows as a wrong number. The SAME numeric customer id (CUST) has an account in all
// three shops, the worst case for any query that forgets the shop (real Shopify ids are not shared between stores; the code
// must not rely on that). ONLY_A / ONLY_B / ONLY_C exist in one shop each. Hold 0, everything activated:
//   A: CUST 600, ONLY_A 500     B: CUST 300, ONLY_B 250     C: CUST 450, ONLY_C 320     (+ an 11-point admin bonus for CUST in each)
// Each shop also has one failed webhook event, an audit row and its own notifications. ADMIN_SHOP is UNSET throughout (the
// admins sign in unpinned, each with their own e-mail). The tests run in order and share this state; the admin tests come first.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { prisma } from '../../web/lib/prisma.js';
import proxyRouter from '../../web/routes/proxy.routes.js';
import { appProxySignature } from '../../web/lib/app-proxy.js';
import { hashPassword } from '../../web/lib/passwords.js';
import { AMBIGUOUS_EMAIL_MESSAGE } from '../../web/admin/auth.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import { activateDueLots } from '../../web/loyalty/service/jobs.js';
import { adjustPoints } from '../../web/loyalty/service/adjustment.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { restoreClock } from '../../web/loyalty/adapters/clock.js';
import { startConsole, adminBrowser, allKeys } from '../helpers/admin-http.js';
import { uniqueId } from '../helpers/ids.js';

const SECRET = 'test-app-proxy-secret';
const CUST = '777000111';
const SPEC = {
  A: { currency: 'INR', pointsPerReward: 500, rewardValue: 5000, value: '50.00', cust: 600, only: ['888000111', 500], onlyId: '888000111' },
  B: { currency: 'USD', pointsPerReward: 200, rewardValue: 2000, value: '20.00', cust: 300, only: ['999000111', 250], onlyId: '999000111' },
  C: { currency: 'EUR', pointsPerReward: 300, rewardValue: 1500, value: '15.00', cust: 450, only: ['666000111', 320], onlyId: '666000111' },
};
const KEYS = ['A', 'B', 'C'];
const others = (k) => KEYS.filter((x) => x !== k);

describe('three shops in one database', () => {
  let site;
  let proxyBase;
  let proxyServer;
  let savedShop;
  let savedSecret;
  const gws = {};
  const S = {}; // S.A, S.B, S.C

  before(async () => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
    savedShop = process.env.ADMIN_SHOP;
    savedSecret = process.env.SHOPIFY_API_SECRET;
    process.env.SHOPIFY_API_SECRET = SECRET;
    delete process.env.ADMIN_SHOP; // unpinned: each admin finds their own shop by e-mail
    site = await startConsole();
    const app = express();
    app.use('/api/proxy', proxyRouter);
    proxyServer = http.createServer(app);
    await new Promise((r) => proxyServer.listen(0, '127.0.0.1', r));
    proxyBase = `http://127.0.0.1:${proxyServer.address().port}/api/proxy`;

    const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    for (const k of KEYS) S[k] = await setupShop(k, `iso-${k.toLowerCase()}-${tag}.myshopify.com`);
    ledgerService.setGatewayFactory((shop) => gws[shop]);
  });
  after(async () => {
    await site.close();
    await new Promise((r) => proxyServer.close(r));
    restoreClock();
    if (savedShop === undefined) delete process.env.ADMIN_SHOP; else process.env.ADMIN_SHOP = savedShop;
    if (savedSecret === undefined) delete process.env.SHOPIFY_API_SECRET; else process.env.SHOPIFY_API_SECRET = savedSecret;
    await prisma.$disconnect();
  });

  async function setupShop(key, shop) {
    const spec = SPEC[key];
    await prisma.loyaltyConfig.create({
      data: { shop, spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: spec.pointsPerReward, rewardValue: spec.rewardValue, rewardExpiryDays: 90, currency: spec.currency, holdPeriodDays: 0, ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
    });
    const gw = new FakeShopifyGateway(shop);
    gws[shop] = gw;
    ledgerService.setGatewayFactory((s) => gws[s]);
    const orderIds = [];
    for (const [customer, points] of [[CUST, spec.cust], spec.only]) {
      const orderId = uniqueId();
      orderIds.push(String(orderId));
      const processedAt = new Date().toISOString();
      await storeWebhook({
        shop, topic: 'orders/paid', shopifyWebhookId: crypto.randomUUID(),
        payload: { id: orderId, name: `#${String(orderId).slice(-4)}`, customer: { id: customer }, processed_at: processedAt, taxes_included: false, line_items: [{ id: 1, quantity: 1, price: `${points}.00`, title: 'Item', gift_card: false, discount_allocations: [], tax_lines: [] }], discount_codes: [] },
      });
      await processPendingWebhooks({ shop });
      gw.addOrder({ id: orderId, processed_at: processedAt, refunds: [] });
    }
    await activateDueLots({ shop });

    // One failed event: a refund for an order that exists in Shopify (after the ledger start) but the ledger has not seen yet.
    const missingOrderId = uniqueId();
    gw.addOrder({ id: missingOrderId, processed_at: new Date().toISOString(), refunds: [] });
    const failed = await storeWebhook({ shop, topic: 'refunds/create', shopifyWebhookId: crypto.randomUUID(), payload: { id: uniqueId(), order_id: missingOrderId, refund_line_items: [{ line_item_id: 1, quantity: 1 }] } });
    await processPendingWebhooks({ shop });
    assert.equal((await prisma.webhookEvent.findUnique({ where: { id: failed.id } })).status, 'failed', 'the setup event failed as intended');

    const admin = await adminBrowser(site.url, shop); // ADMIN_SHOP is unset: found by its own random e-mail
    await adjustPoints({ shop, shopifyCustomerId: CUST, points: 11, reason: 'Special bonus', note: 'Isolation test bonus', adminId: admin.admin.id, idempotencyKey: crypto.randomUUID() });
    return {
      shop, admin, orderIds, failedEventId: failed.id, gw, spec,
      ids: {
        order: (await prisma.loyaltyOrder.findFirst({ where: { shop } })).id,
        audit: (await prisma.auditLog.findFirst({ where: { shop } })).id,
        notification: (await prisma.notification.findFirst({ where: { shop } })).id,
      },
    };
  }

  const bal = async (shop, customer) => {
    const a = await prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: customer } } });
    return a && { available: a.available, pending: a.pending, debt: a.debt };
  };
  const ownMembers = (k) => [CUST, SPEC[k].onlyId].sort();

  describe('the admin API', () => {
    test('Overview: each shop counts only its own members and points, in its own currency', async () => {
      for (const k of KEYS) {
        const o = (await S[k].admin.get('overview')).json;
        const expected = SPEC[k].cust + SPEC[k].only[1] + 11;
        assert.equal(o.members.total, 2, k);
        assert.deepEqual([o.points.issued, o.points.available, o.rule.currency, o.rule.rewardValue], [expected, expected, SPEC[k].currency, SPEC[k].value], k);
      }
    });

    test('customers: the same id shows each shop\'s own account; other shops\' members do not exist (404 / empty)', async () => {
      for (const k of KEYS) {
        const d = (await S[k].admin.get(`customers/${CUST}`)).json;
        assert.deepEqual([d.account.available, d.rule.currency, d.orders.map((o) => o.orderRef)], [SPEC[k].cust + 11, SPEC[k].currency, [S[k].orderIds[0]]], k);
        assert.deepEqual((await S[k].admin.get('customers')).json.results.map((r) => r.shopifyCustomerId).sort(), ownMembers(k), k);
        for (const o of others(k)) {
          assert.equal((await S[k].admin.get(`customers/${SPEC[o].onlyId}`)).status, 404, `${k} -> ${o}'s member`);
          assert.deepEqual((await S[k].admin.get(`customers?query=${SPEC[o].onlyId}`)).json.results, [], `${k} search for ${o}'s member`);
          assert.deepEqual((await S[k].admin.get(`customers?query=${SPEC[o].onlyId.slice(0, 4)}`)).json.results, [], `${k} prefix search`);
        }
      }
    });

    test('an adjustment touches only the signed-in shop\'s account; another shop\'s member is not found and unchanged', async () => {
      for (const k of KEYS) {
        const before = Object.fromEntries(await Promise.all(KEYS.map(async (x) => [x, await bal(S[x].shop, CUST)])));
        const body = (n) => ({ points: n, reason: 'Special bonus', note: `Isolation: only shop ${k}`, idempotencyKey: crypto.randomUUID() });
        const mine = await S[k].admin.post(`customers/${CUST}/adjust`, body(5));
        assert.equal(mine.status, 200, mine.text);
        assert.deepEqual(await bal(S[k].shop, CUST), { ...before[k], available: before[k].available + 5 }, k);
        for (const o of others(k)) {
          assert.deepEqual(await bal(S[o].shop, CUST), before[o], `the same customer id in shop ${o} is untouched`);
          const foreignMember = await bal(S[o].shop, SPEC[o].onlyId);
          const theirs = await S[k].admin.post(`customers/${SPEC[o].onlyId}/adjust`, body(7));
          assert.equal(theirs.status, 404, `${k} -> ${o}`);
          assert.deepEqual(await bal(S[o].shop, SPEC[o].onlyId), foreignMember);
        }
      }
    });

    test('the same adjustment key in three shops is three independent adjustments', async () => {
      const key = crypto.randomUUID();
      for (const k of KEYS) {
        const r = await S[k].admin.post(`customers/${CUST}/adjust`, { points: 1, reason: 'Special bonus', note: 'Same key, three shops', idempotencyKey: key });
        assert.deepEqual([r.status, r.json.replayed], [200, false], k);
      }
    });

    test('orders and webhook events: only the shop\'s own; another shop\'s event cannot be listed or retried', async () => {
      for (const k of KEYS) {
        const orders = (await S[k].admin.get('orders')).json;
        assert.deepEqual(orders.orders.map((o) => o.orderRef).sort(), [...S[k].orderIds].sort(), k);
        assert.equal(orders.currency, SPEC[k].currency);
        const events = (await S[k].admin.get('events?limit=100')).json.events.map((e) => e.id);
        assert.ok(events.includes(S[k].failedEventId), k);
        for (const o of others(k)) {
          assert.ok(!events.includes(S[o].failedEventId), `${k} cannot list ${o}'s event`);
          const retry = await S[k].admin.post(`events/${S[o].failedEventId}/retry`, {});
          assert.equal(retry.status, 404, `${k} retry ${o}'s event`);
          assert.equal((await prisma.webhookEvent.findUnique({ where: { id: S[o].failedEventId } })).status, 'failed');
          assert.equal(await prisma.auditLog.count({ where: { shop: S[o].shop, action: 'event_retried' } }), 0);
        }
      }
    });

    test('a cursor taken from another shop\'s rows leaks nothing (orders, events, audit, notifications)', async () => {
      for (const k of KEYS) {
        for (const o of others(k)) {
          const orders = (await S[k].admin.get(`orders?cursor=${S[o].ids.order}`)).json;
          assert.ok((orders.orders ?? []).every((x) => S[k].orderIds.includes(x.orderRef)), `${k} orders via ${o}'s cursor`);
          const audit = (await S[k].admin.get(`audit?cursor=${S[o].ids.audit}`)).json;
          assert.ok((audit.entries ?? []).every((e) => e.id !== S[o].ids.audit));
          const notes = await S[k].admin.get(`notifications?cursor=${S[o].ids.notification}`);
          assert.ok((notes.json.notifications ?? []).every((n) => [CUST, SPEC[k].onlyId].includes(n.customerId)));
          const events = await S[k].admin.get(`events?cursor=${S[o].failedEventId}`);
          assert.ok((events.json.events ?? []).every((e) => e.id !== S[o].failedEventId));
        }
      }
    });

    test('the audit log and the notifications are each shop\'s own', async () => {
      for (const k of KEYS) {
        const audit = (await S[k].admin.get('audit?limit=100')).json;
        const ids = new Set(audit.entries.map((e) => e.id));
        assert.ok(ids.has(S[k].ids.audit), k);
        for (const o of others(k)) {
          assert.ok(!ids.has(S[o].ids.audit), `${k} audit has none of ${o}'s`);
          assert.ok(audit.entries.every((e) => e.admin !== S[o].admin.email));
        }
        const notes = (await S[k].admin.get('notifications?limit=100')).json.notifications;
        const text = notes.map((n) => n.text).join(' | ');
        assert.match(text, new RegExp(`earning ${SPEC[k].cust} points`), k);
        for (const o of others(k)) assert.doesNotMatch(text, new RegExp(`earning (${SPEC[o].cust}|${SPEC[o].only[1]}) points`), `${k} sees none of ${o}'s`);
        assert.ok(notes.every((n) => ownMembers(k).includes(n.customerId)));
      }
    });

    test('reconciliation checks only the shop\'s own accounts and stores its result under that shop', async () => {
      for (const k of KEYS) {
        const r = await S[k].admin.post('reconciliation/run', {});
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.last.accountsChecked, 2, k);
        assert.equal((await S[k].admin.get('reconciliation')).json.last.accountsChecked, 2);
      }
    });

    test('rules: each shop reads its own; a save changes only the signed-in shop and is audited under it', async () => {
      const before = Object.fromEntries(await Promise.all(KEYS.map(async (x) => [x, await prisma.loyaltyConfig.findUnique({ where: { shop: S[x].shop } })])));
      for (const k of KEYS) {
        const rules = (await S[k].admin.get('rules')).json;
        assert.deepEqual([rules.redeem.pointsPerReward, rules.redeem.rewardValue, rules.redeem.currency], [SPEC[k].pointsPerReward, SPEC[k].value, SPEC[k].currency], k);
      }
      const a = (await S.A.admin.get('rules')).json;
      const saved = await S.A.admin.post('rules', { expected: a.program.updatedAt, changes: { codeValidDays: 45 } });
      assert.equal(saved.status, 200, saved.text);
      assert.equal((await prisma.loyaltyConfig.findUnique({ where: { shop: S.A.shop } })).rewardExpiryDays, 45);
      for (const o of ['B', 'C']) {
        assert.deepEqual(await prisma.loyaltyConfig.findUnique({ where: { shop: S[o].shop } }), before[o], `shop ${o}'s rule is untouched`);
        assert.equal(await prisma.auditLog.count({ where: { shop: S[o].shop, action: 'rules_changed' } }), 0);
      }
      assert.equal(await prisma.auditLog.count({ where: { shop: S.A.shop, action: 'rules_changed' } }), 1);

      // Another shop's form timestamp is not valid for A.
      const b = (await S.B.admin.get('rules')).json;
      const wrong = await S.A.admin.post('rules', { expected: b.program.updatedAt, changes: { codeValidDays: 46 } });
      assert.equal(wrong.status, 409);
      assert.equal((await prisma.loyaltyConfig.findUnique({ where: { shop: S.A.shop } })).rewardExpiryDays, 45);
    });

    test('no response names another shop or carries a shop domain at all', async () => {
      for (const k of KEYS) {
        for (const path of ['overview', 'customers', `customers/${CUST}`, 'orders', 'events', 'audit', 'reconciliation', 'rules', 'notifications', 'meta']) {
          const r = await S[k].admin.get(path);
          for (const o of others(k)) assert.ok(!r.text.includes(S[o].shop), `${k} ${path} does not mention ${o}`);
          assert.ok(!r.text.includes('.myshopify.com'), `${k} ${path} carries no shop domain`);
          assert.ok(!allKeys(r.json ?? {}).has('shop'), `${k} ${path} has no "shop" key`);
        }
      }
    });

    test('a session belongs to its shop: a forged shop in the query or a header is ignored', async () => {
      const r = await S.B.admin.req('GET', `customers/${SPEC.A.onlyId}?shop=${encodeURIComponent(S.A.shop)}`);
      assert.equal(r.status, 404);
      const o = await S.B.admin.req('GET', `orders?shop=${encodeURIComponent(S.A.shop)}`, undefined, { 'X-Shop': S.A.shop });
      assert.ok(o.json.orders.every((x) => S.B.orderIds.includes(x.orderRef)));
    });
  });

  describe('admin sign-in with several shops (ADMIN_SHOP unset)', () => {
    const PASSWORD = 'Correct-horse-battery-staple-1';
    let seq = 0;
    const login = (email, password = PASSWORD) => fetch(`${site.url}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.77.${Date.now() % 250}.${(seq += 1) % 250}` },
      body: JSON.stringify({ email, password }),
    });

    test('admins with DIFFERENT e-mails in different shops can all sign in, each into their own shop', async () => {
      assert.equal(process.env.ADMIN_SHOP, undefined);
      const passwordHash = await hashPassword(PASSWORD);
      const people = {};
      for (const k of KEYS) {
        people[k] = `person-${k.toLowerCase()}-${crypto.randomUUID()}@example.test`;
        await prisma.adminUser.create({ data: { shop: S[k].shop, email: people[k], passwordHash, mustChangePassword: false } });
      }
      for (const k of KEYS) {
        const res = await login(people[k]);
        assert.equal(res.status, 200, k);
        const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('rw_admin=')).split(';')[0];
        const session = await (await fetch(`${site.url}/api/session`, { headers: { Cookie: cookie } })).json();
        assert.equal(session.admin.email, people[k]);
        const overview = await (await fetch(`${site.url}/api/overview`, { headers: { Cookie: cookie } })).json();
        assert.equal(overview.rule.currency, SPEC[k].currency, `${k} signed into its own shop`);
      }
    });

    test('the SAME e-mail in two shops is refused with a clear message (no guessing which shop)', async () => {
      const email = `shared-${crypto.randomUUID()}@example.test`;
      const passwordHash = await hashPassword(PASSWORD);
      for (const k of ['A', 'B']) await prisma.adminUser.create({ data: { shop: S[k].shop, email, passwordHash, mustChangePassword: false } });
      const res = await login(email);
      assert.equal(res.status, 409);
      assert.equal(res.headers.getSetCookie?.().some((c) => c.startsWith('rw_admin=')), false, 'no session was issued');
      const body = await res.json();
      assert.deepEqual([body.ok, body.error, body.message], [false, 'AMBIGUOUS_ADMIN_EMAIL', AMBIGUOUS_EMAIL_MESSAGE]);
      assert.match(body.message, /more than one shop/);
      assert.match(body.message, /different e-mail address for each shop/);
    });

    test('...but a wrong password gets the ordinary answer, so the message never reveals who is an admin', async () => {
      const email = `shared2-${crypto.randomUUID()}@example.test`;
      const passwordHash = await hashPassword(PASSWORD);
      for (const k of ['B', 'C']) await prisma.adminUser.create({ data: { shop: S[k].shop, email, passwordHash, mustChangePassword: false } });
      const wrong = await login(email, 'not-the-password-at-all');
      assert.equal(wrong.status, 401);
      assert.equal((await wrong.json()).error, 'INVALID_CREDENTIALS');
      const nobody = await login(`nobody-${crypto.randomUUID()}@example.test`, 'not-the-password-at-all');
      assert.equal(nobody.status, 401);
      assert.equal((await nobody.json()).error, 'INVALID_CREDENTIALS');
    });

    test('with ADMIN_SHOP set the console serves that one shop, and the shared e-mail signs in there', async () => {
      const email = `shared3-${crypto.randomUUID()}@example.test`;
      const passwordHash = await hashPassword(PASSWORD);
      for (const k of ['A', 'C']) await prisma.adminUser.create({ data: { shop: S[k].shop, email, passwordHash, mustChangePassword: false } });
      process.env.ADMIN_SHOP = S.C.shop;
      try {
        const res = await login(email);
        assert.equal(res.status, 200);
        const cookie = res.headers.getSetCookie().find((c) => c.startsWith('rw_admin=')).split(';')[0];
        const overview = await (await fetch(`${site.url}/api/overview`, { headers: { Cookie: cookie } })).json();
        assert.equal(overview.rule.currency, 'EUR', 'signed into the pinned shop');
        // an admin of another shop cannot sign in at a console pinned to shop C
        assert.equal((await login(S.B.admin.email, S.B.admin.password)).status, 401, 'B\'s admin, with the right password, is not an admin of C');
      } finally {
        delete process.env.ADMIN_SHOP;
      }
    });
  });

  describe('the storefront (App Proxy) API', () => {
    const signedUrl = (path, { shop, customer, tamper } = {}) => {
      const params = { shop, path_prefix: '/apps/rewards-dev', timestamp: String(Math.floor(Date.now() / 1000)), logged_in_customer_id: customer };
      const signature = appProxySignature(params, SECRET);
      return `${proxyBase}${path}?${new URLSearchParams({ ...params, ...(tamper ?? {}), signature })}`;
    };
    const get = async (path, opts) => { const r = await fetch(signedUrl(path, opts)); return { status: r.status, json: await r.json().catch(() => null) }; };
    const post = async (path, opts, body, headers = {}) => {
      const r = await fetch(signedUrl(path, opts), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    const key = () => ({ 'Idempotency-Key': crypto.randomUUID() });

    test('/history: the same customer id sees each shop\'s own balance, rule, currency and notifications', async () => {
      for (const k of KEYS) {
        const r = await get('/history', { shop: S[k].shop, customer: CUST });
        assert.equal(r.status, 200, k);
        // earned + 11 bonus + 5 + 1 from the admin tests above
        assert.deepEqual([r.json.balance.available, r.json.rule.currency, r.json.rule.rewardValue, r.json.rule.pointsPerReward], [SPEC[k].cust + 17, SPEC[k].currency, SPEC[k].value, SPEC[k].pointsPerReward], k);
        const text = r.json.notifications.items.map((n) => n.text).join(' | ');
        assert.match(text, new RegExp(`earning ${SPEC[k].cust} points`), k);
        for (const o of others(k)) assert.doesNotMatch(text, new RegExp(`earning ${SPEC[o].cust} points`), `${k} sees none of ${o}'s`);
      }
    });

    test('/history: a customer who exists only in another shop sees an empty account there, and none of that shop\'s data', async () => {
      for (const k of KEYS) {
        for (const o of others(k)) {
          const r = await get('/history', { shop: S[k].shop, customer: SPEC[o].onlyId });
          assert.equal(r.status, 200);
          assert.deepEqual(r.json.balance, { available: 0, pending: 0, owed: 0 }, `${SPEC[o].onlyId} in ${k}`);
          assert.deepEqual([r.json.history, r.json.rewards, r.json.notifications.unread], [[], [], 0]);
          assert.equal(await prisma.loyaltyAccount.count({ where: { shop: S[k].shop, shopifyCustomerId: SPEC[o].onlyId } }), 0, 'looking does not create an account');
        }
      }
    });

    test('/redeem in one shop spends only that shop\'s points and creates the code in that shop only', async () => {
      for (const k of KEYS) {
        const before = Object.fromEntries(await Promise.all(KEYS.map(async (x) => [x, await bal(S[x].shop, CUST)])));
        const discountsBefore = Object.fromEntries(KEYS.map((x) => [x, S[x].gw.discounts.size]));
        const r = await post('/redeem', { shop: S[k].shop, customer: CUST }, {}, key());
        assert.equal(r.status, 200, `${k}: ${JSON.stringify(r.json)}`);
        assert.deepEqual([r.json.pointsUsed, r.json.value, r.json.currency], [SPEC[k].pointsPerReward, SPEC[k].value, SPEC[k].currency], k);
        assert.deepEqual(await bal(S[k].shop, CUST), { ...before[k], available: before[k].available - SPEC[k].pointsPerReward }, k);
        for (const o of others(k)) {
          assert.deepEqual(await bal(S[o].shop, CUST), before[o], `the same customer id in ${o} is untouched`);
          assert.equal(S[o].gw.discounts.size, discountsBefore[o], `no discount created in ${o}`);
        }
        assert.equal(S[k].gw.discounts.size, discountsBefore[k] + 1);
        assert.equal([...S[k].gw.discounts.values()].at(-1).amount, SPEC[k].value);
      }
    });

    test('the same Idempotency-Key in three shops is three separate requests, not a replay of the first', async () => {
      const shared = crypto.randomUUID();
      const codes = new Set();
      for (const k of KEYS) {
        const r = await post('/redeem', { shop: S[k].shop, customer: SPEC[k].onlyId }, {}, { 'Idempotency-Key': shared });
        assert.equal(r.status, 200, `${k}: ${JSON.stringify(r.json)}`);
        assert.deepEqual([r.json.pointsUsed, r.json.value], [SPEC[k].pointsPerReward, SPEC[k].value], k);
        codes.add(r.json.code);
      }
      assert.equal(codes.size, 3, 'three different codes');
    });

    test('marking notifications read in one shop leaves the same customer id\'s notifications in the others unread', async () => {
      const unread = (shop) => prisma.notification.count({ where: { shop, readAt: null, account: { shopifyCustomerId: CUST } } });
      const before = Object.fromEntries(await Promise.all(KEYS.map(async (x) => [x, await unread(S[x].shop)])));
      assert.ok(KEYS.every((x) => before[x] > 0));
      assert.equal((await post('/notifications/read', { shop: S.A.shop, customer: CUST }, {})).status, 200);
      assert.equal(await unread(S.A.shop), 0);
      assert.equal(await unread(S.B.shop), before.B);
      assert.equal(await unread(S.C.shop), before.C);
    });

    test('a request signed for shop A cannot read or redeem for another shop: the shop is part of the signature', async () => {
      for (const k of KEYS) {
        for (const o of others(k)) {
          const before = await bal(S[o].shop, CUST);
          const discounts = S[o].gw.discounts.size;
          const h = await fetch(signedUrl('/history', { shop: S[k].shop, customer: CUST, tamper: { shop: S[o].shop } }));
          assert.equal(h.status, 401, `${k} -> ${o} history`);
          const p = await fetch(signedUrl('/redeem', { shop: S[k].shop, customer: CUST, tamper: { shop: S[o].shop } }), { method: 'POST', headers: { 'Content-Type': 'application/json', ...key() }, body: '{}' });
          assert.equal(p.status, 401, `${k} -> ${o} redeem`);
          assert.deepEqual(await bal(S[o].shop, CUST), before);
          assert.equal(S[o].gw.discounts.size, discounts);
        }
      }
    });

    test('identity comes from the signed query, never the body: a body naming another shop or customer is ignored', async () => {
      const before = { onlyA: await bal(S.A.shop, SPEC.A.onlyId), onlyB: await bal(S.B.shop, SPEC.B.onlyId), onlyC: await bal(S.C.shop, SPEC.C.onlyId) };
      await post('/redeem', { shop: S.A.shop, customer: CUST }, { shop: S.B.shop, shopifyCustomerId: SPEC.B.onlyId, customerId: SPEC.C.onlyId, logged_in_customer_id: SPEC.A.onlyId }, key());
      assert.deepEqual(await bal(S.A.shop, SPEC.A.onlyId), before.onlyA);
      assert.deepEqual(await bal(S.B.shop, SPEC.B.onlyId), before.onlyB);
      assert.deepEqual(await bal(S.C.shop, SPEC.C.onlyId), before.onlyC);
    });

    test('a signed request for a shop with no rule is refused and creates nothing', async () => {
      const ghost = `iso-ghost-${Date.now()}.myshopify.com`;
      for (const [method, path] of [['GET', '/history'], ['POST', '/redeem'], ['POST', '/notifications/read']]) {
        const res = await fetch(signedUrl(path, { shop: ghost, customer: CUST }), { method, headers: { 'Content-Type': 'application/json', ...key() }, body: method === 'POST' ? '{}' : undefined });
        assert.equal(res.status, 404, `${method} ${path}`);
      }
      assert.equal(await prisma.loyaltyAccount.count({ where: { shop: ghost } }), 0);
    });
  });

  test('a refund for shop A\'s order reverses points in shop A only', async () => {
    // Real Shopify ids are unique platform-wide (the ledger's dedupe keys embed them), so each shop has its own orders.
    const refundId = uniqueId();
    await storeWebhook({ shop: S.A.shop, topic: 'refunds/create', shopifyWebhookId: crypto.randomUUID(), payload: { id: refundId, order_id: S.A.orderIds[1], refund_line_items: [{ line_item_id: 1, quantity: 1 }] } });
    const before = { b: await bal(S.B.shop, SPEC.B.onlyId), c: await bal(S.C.shop, SPEC.C.onlyId), bc: await bal(S.B.shop, CUST), cc: await bal(S.C.shop, CUST) };
    await processPendingWebhooks({ shop: S.A.shop });
    assert.equal((await prisma.loyaltyRefund.findFirst({ where: { shop: S.A.shop, shopifyRefundId: String(refundId) } }))?.pointsReversed, 500, 'A\'s order fully reversed in A');
    assert.deepEqual([await bal(S.B.shop, SPEC.B.onlyId), await bal(S.C.shop, SPEC.C.onlyId), await bal(S.B.shop, CUST), await bal(S.C.shop, CUST)], [before.b, before.c, before.bc, before.cc]);
    for (const o of ['B', 'C']) assert.equal(await prisma.loyaltyRefund.count({ where: { shop: S[o].shop, shopifyRefundId: String(refundId) } }), 0);
  });
});
