// test/loyalty/notifications.test.js
//
// On-site notifications (decision D8): points earned, points activated, reward redeemed. Written in the ledger
// transaction (once per event, whatever is redelivered or retried), shown through the signed proxy /history, marked
// read with POST /notifications/read, scoped to the calling customer. Fake gateway, fake clock.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { prisma } from '../../web/lib/prisma.js';
import proxyRouter from '../../web/routes/proxy.routes.js';
import { appProxySignature } from '../../web/lib/app-proxy.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import { activateDueLots, deleteVoidedCodes } from '../../web/loyalty/service/jobs.js';
import { redeem, resolveRedemption } from '../../web/loyalty/service/redemption.js';
import { notificationText } from '../../web/loyalty/service/notifications.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { setFixedTime, restoreClock, now } from '../../web/loyalty/adapters/clock.js';
import { uniqueId } from '../helpers/ids.js';
import { assertLedgerBalances } from '../helpers/invariants.js';

const SECRET = 'test-app-proxy-secret';
const DAY = 24 * 60 * 60 * 1000;

describe('On-site notifications', () => {
  let server;
  let base;
  let shop;
  let gw;
  let savedSecret;
  let customer;

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
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (savedSecret === undefined) delete process.env.SHOPIFY_API_SECRET; else process.env.SHOPIFY_API_SECRET = savedSecret;
    restoreClock();
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    shop = `notif-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    customer = String(uniqueId());
    setFixedTime(new Date('2026-09-01T10:00:00Z'));
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
    await prisma.loyaltyConfig.create({
      data: { shop, spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, rewardExpiryDays: 90, currency: 'INR', holdPeriodDays: 30, ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
    });
  });

  const signed = (path, who = customer) => {
    const params = { shop, path_prefix: '/apps/rewards-dev', timestamp: String(Math.floor(Date.now() / 1000)), logged_in_customer_id: who };
    return `${base}${path}?${new URLSearchParams({ ...params, signature: appProxySignature(params, SECRET) })}`;
  };
  const history = async (who = customer) => (await fetch(signed('/history', who))).json();
  const markRead = (who = customer) => fetch(signed('/notifications/read', who), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const rows = (type) => prisma.notification.findMany({ where: { shop, ...(type ? { type } : {}) }, orderBy: { createdAt: 'asc' } });
  const account = () => prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: customer } } });

  async function earn(points, name = '#1042', orderId = uniqueId(), webhookId = crypto.randomUUID()) {
    const payload = { id: orderId, name, customer: { id: customer }, processed_at: now().toISOString(), line_items: [{ id: 1, quantity: 1, price: String(points), title: 'x' }] };
    await storeWebhook({ shop, topic: 'orders/paid', payload, shopifyWebhookId: webhookId });
    await processPendingWebhooks({ shop });
    gw.addOrder({ id: orderId, processed_at: payload.processed_at, refunds: [] });
    return { orderId, payload };
  }
  async function earnActive(points) {
    const r = await earn(points);
    setFixedTime(new Date(now().getTime() + 31 * DAY));
    await activateDueLots({ shop });
    return r;
  }

  // ===================== writing =====================

  test('an order that earns points writes ONE "points earned" notification, with the order name; a redelivery writes none', async () => {
    const { orderId, payload } = await earn(600);
    const [n] = await rows('points_earned');
    assert.deepStrictEqual(n.data, { points: 600, orderRef: '#1042' });
    assert.strictEqual(n.readAt, null);
    await storeWebhook({ shop, topic: 'orders/paid', payload, shopifyWebhookId: crypto.randomUUID() }); // same order, another webhook id
    await processPendingWebhooks({ shop });
    assert.strictEqual((await rows('points_earned')).length, 1);
    assert.strictEqual(n.dedupeKey, `points_earned:${orderId}`);
  });

  test('an order without a name uses its number; with neither, the notification has no order reference', async () => {
    await earn(100, null);
    const orderId = uniqueId();
    await storeWebhook({ shop, topic: 'orders/paid', shopifyWebhookId: crypto.randomUUID(), payload: { id: orderId, order_number: 77, customer: { id: customer }, processed_at: now().toISOString(), line_items: [{ id: 1, quantity: 1, price: '50', title: 'x' }] } });
    await processPendingWebhooks({ shop });
    const refs = (await rows('points_earned')).map((n) => n.data.orderRef);
    assert.deepStrictEqual(refs.sort((a, b) => String(a).localeCompare(String(b))), ['#77', null]);
  });

  test('activating a lot writes a "points activated" notification with the points that became usable; once', async () => {
    await earn(600);
    setFixedTime(new Date(now().getTime() + 31 * DAY));
    assert.strictEqual((await activateDueLots({ shop })).activated, 1);
    assert.deepStrictEqual((await rows('points_activated')).map((n) => n.data), [{ points: 600 }]);
    await activateDueLots({ shop });
    assert.strictEqual((await rows('points_activated')).length, 1, 'nothing more to activate');
  });

  test('activation that only repays debt writes none; a partial repayment reports what is left', async () => {
    await earn(300);
    await prisma.loyaltyAccount.update({ where: { id: (await account()).id }, data: { debt: 300 } });
    setFixedTime(new Date(now().getTime() + 31 * DAY));
    await activateDueLots({ shop });
    assert.strictEqual((await rows('points_activated')).length, 0, 'all 300 repaid the debt: nothing became available');

    await earn(500);
    await prisma.loyaltyAccount.update({ where: { id: (await account()).id }, data: { debt: 120 } });
    setFixedTime(new Date(now().getTime() + 31 * DAY));
    await activateDueLots({ shop });
    assert.deepStrictEqual((await rows('points_activated')).map((n) => n.data), [{ points: 380 }]);
  });

  test('a redemption writes "reward redeemed" when the code is issued, not before, and a replay writes none', async () => {
    await earnActive(500);
    const key = crypto.randomUUID();
    const r = await redeem({ shop, shopifyCustomerId: customer, idempotencyKey: key });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual((await rows('reward_redeemed')).map((n) => n.data), [{ pointsUsed: 500, valuePaise: 5000 }]);
    await redeem({ shop, shopifyCustomerId: customer, idempotencyKey: key });
    assert.strictEqual((await rows('reward_redeemed')).length, 1);
  });

  test('while a redemption is still "creating" there is no notification; completing it writes one; a failed one writes none', async () => {
    await earnActive(500);
    gw.loseNextCreateResponseOnce();
    const lookup = gw.findDiscountByCode.bind(gw);
    let first = true;
    gw.findDiscountByCode = async (c) => { if (first) { first = false; throw new Error('timeout'); } return lookup(c); };
    const r = await redeem({ shop, shopifyCustomerId: customer, idempotencyKey: crypto.randomUUID() });
    assert.strictEqual(r.status, 'creating');
    assert.strictEqual((await rows('reward_redeemed')).length, 0);
    await resolveRedemption((await prisma.redemption.findFirst({ where: { shop } })).id);
    assert.strictEqual((await rows('reward_redeemed')).length, 1);
  });

  test('a code voided as it is issued (the race) is NOT announced as redeemed', async () => {
    const { orderId } = await earnActive(500);
    gw.loseNextCreateResponseOnce();
    const lookup = gw.findDiscountByCode.bind(gw);
    let first = true;
    gw.findDiscountByCode = async (c) => { if (first) { first = false; throw new Error('timeout'); } return lookup(c); };
    await redeem({ shop, shopifyCustomerId: customer, idempotencyKey: crypto.randomUUID() });
    await storeWebhook({ shop, topic: 'refunds/create', shopifyWebhookId: crypto.randomUUID(), payload: { id: uniqueId(), order_id: orderId, refund_line_items: [{ line_item_id: 1, quantity: 1 }] } });
    await processPendingWebhooks({ shop });
    const settled = await resolveRedemption((await prisma.redemption.findFirst({ where: { shop } })).id);
    assert.strictEqual(settled.reason, 'REWARD_VOIDED');
    assert.strictEqual((await rows('reward_redeemed')).length, 0);
    await deleteVoidedCodes({ shop });
    await assertLedgerBalances(prisma, (await account()).id);
  });

  test('nothing is written without a customer (a guest order earns nothing)', async () => {
    await storeWebhook({ shop, topic: 'orders/paid', shopifyWebhookId: crypto.randomUUID(), payload: { id: uniqueId(), name: '#9', processed_at: now().toISOString(), line_items: [{ id: 1, quantity: 1, price: '100' }] } });
    await processPendingWebhooks({ shop });
    assert.strictEqual((await rows()).length, 0);
  });

  // ===================== wording =====================

  test('the sentences come from the data and the shop\'s currency; odd data gives a neutral line', () => {
    const cfg = { currency: 'INR' };
    assert.strictEqual(notificationText({ type: 'points_earned', data: { points: 1349, orderRef: '#1019' } }, cfg), "You're earning 1,349 points on order #1019");
    assert.strictEqual(notificationText({ type: 'points_earned', data: { points: 5, orderRef: null } }, cfg), "You're earning 5 points");
    assert.strictEqual(notificationText({ type: 'points_activated', data: { points: 674 } }, cfg), '674 points are now available to use');
    assert.strictEqual(notificationText({ type: 'reward_redeemed', data: { pointsUsed: 500, valuePaise: 5000 } }, cfg), 'Your ₹50 reward is ready to use (500 points)');
    assert.strictEqual(notificationText({ type: 'reward_redeemed', data: { pointsUsed: 100, valuePaise: 1250 } }, { currency: 'USD' }), 'Your $12.50 reward is ready to use (100 points)');
    assert.strictEqual(notificationText({ type: 'something_else', data: null }, cfg), 'Your rewards were updated');
    assert.strictEqual(notificationText({ type: 'points_earned', data: { points: 'x', orderRef: 'y'.repeat(100) } }, cfg).length < 80, true, 'long references are cut');
  });

  // ===================== the storefront =====================

  test('/history lists the notifications newest first with the sentence, a read flag and the unread count; no ids', async () => {
    await earnActive(600); // earned, activated
    await redeem({ shop, shopifyCustomerId: customer, idempotencyKey: crypto.randomUUID() });
    const view = await history();
    assert.strictEqual(view.notifications.unread, 3);
    assert.deepStrictEqual(view.notifications.items.map((n) => n.type), ['reward_redeemed', 'points_activated', 'points_earned']);
    assert.deepStrictEqual(view.notifications.items.map((n) => n.text), [
      'Your ₹50 reward is ready to use (500 points)', '600 points are now available to use', "You're earning 600 points on order #1042"]);
    assert.ok(view.notifications.items.every((n) => n.read === false));
    for (const n of view.notifications.items) assert.deepStrictEqual(Object.keys(n).sort(), ['date', 'read', 'text', 'type']);
    assert.ok(!JSON.stringify(view.notifications).includes(shop));
  });

  test('POST /notifications/read marks the caller\'s notifications read and nobody else\'s', async () => {
    await earn(100);
    const other = String(uniqueId());
    await storeWebhook({ shop, topic: 'orders/paid', shopifyWebhookId: crypto.randomUUID(), payload: { id: uniqueId(), name: '#2', customer: { id: other }, processed_at: now().toISOString(), line_items: [{ id: 1, quantity: 1, price: '50' }] } });
    await processPendingWebhooks({ shop });
    assert.strictEqual((await history()).notifications.unread, 1);
    const res = await markRead();
    assert.deepStrictEqual([res.status, await res.json()], [200, { success: true }]);
    const after = await history();
    assert.strictEqual(after.notifications.unread, 0);
    assert.strictEqual(after.notifications.items[0].read, true, 'still listed, now read');
    assert.strictEqual((await history(other)).notifications.unread, 1, 'the other customer\'s are untouched');
  });

  test('marking read needs a valid signature and a logged-in customer; a member with no account is fine', async () => {
    const noSig = await fetch(`${base}/notifications/read?shop=${shop}&logged_in_customer_id=${customer}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.strictEqual(noSig.status, 401);
    assert.strictEqual((await markRead('999000111')).status, 200, 'no account: nothing to mark');
    assert.deepStrictEqual((await history('999000111')).notifications, { unread: 0, items: [] });
  });

  test('only the latest ten are listed, the unread count is the full count', async () => {
    const acc = await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: customer } });
    await prisma.notification.createMany({ data: Array.from({ length: 14 }, (_, i) => ({ accountId: acc.id, shop, type: 'points_earned', data: { points: i }, dedupeKey: `t:${crypto.randomUUID()}`, createdAt: new Date(Date.now() - (14 - i) * 1000) })) });
    const v = await history();
    assert.strictEqual(v.notifications.unread, 14);
    assert.strictEqual(v.notifications.items.length, 10);
    assert.strictEqual(v.notifications.items[0].text, "You're earning 13 points");
  });
});
