// test/loyalty/admin-overview.test.js
//
// Admin console, Overview: GET /admin/api/overview on a real ledger scenario (webhooks, activation, adjustment,
// redemption, refund) with exact numbers, the whitelist, the session gate, and the page rendering from API output.
//
// Rule: 500 points = 50.00 (rewardValue 5000 paise), 1 point per 100 paise, hold 30 days.
// A earns 600, gets a 100 bonus, redeems 500: available 200, one open code (500 points, 50.00).
// B earns 300 (still pending). C earns 400 (activated) and has the order refunded: 400 reversed, 0 left.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import { activateDueLots } from '../../web/loyalty/service/jobs.js';
import { adjustPoints } from '../../web/loyalty/service/adjustment.js';
import { redeem } from '../../web/loyalty/service/redemption.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { setFixedTime, restoreClock, now } from '../../web/loyalty/adapters/clock.js';
import { startConsole, adminBrowser, allKeys } from '../helpers/admin-http.js';
import { uniqueId } from '../helpers/ids.js';
import { renderOverview } from '../../web/admin/public/pages/overview.js';

const DAY = 24 * 60 * 60 * 1000;

describe('Admin overview', () => {
  let site;
  let shop;
  let gw;
  let admin;
  let savedShop;

  before(async () => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
    savedShop = process.env.ADMIN_SHOP;
    site = await startConsole();
  });
  after(async () => {
    await site.close();
    if (savedShop === undefined) delete process.env.ADMIN_SHOP; else process.env.ADMIN_SHOP = savedShop;
    restoreClock();
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    shop = `ovw-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    process.env.ADMIN_SHOP = shop;
    setFixedTime(new Date());
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
    await prisma.loyaltyConfig.create({
      data: { shop, spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, rewardExpiryDays: 90, currency: 'INR', holdPeriodDays: 30, ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
    });
    admin = await adminBrowser(site.url, shop);
  });

  const earn = async (customer, points) => {
    const orderId = uniqueId();
    await storeWebhook({ shop, topic: 'orders/paid', shopifyWebhookId: crypto.randomUUID(),
      payload: { id: orderId, customer: { id: customer }, processed_at: now().toISOString(), line_items: [{ id: 1, quantity: 1, price: String(points), title: 'x' }] } });
    await processPendingWebhooks({ shop });
    gw.addOrder({ id: orderId, processed_at: now().toISOString(), refunds: [] });
    return orderId;
  };

  async function scenario() {
    const [A, B, C] = ['1001', '1002', '1003'];
    const orderA = await earn(A, 600);
    const orderC = await earn(C, 400);
    setFixedTime(new Date(now().getTime() + 31 * DAY)); // A and C are due
    await activateDueLots({ shop });
    await earn(B, 300); // B earns after the jump: still pending
    const bonus = await adjustPoints({
      shop, shopifyCustomerId: A, points: 100, reason: 'Special bonus', note: 'overview test', adminId: admin.admin.id, idempotencyKey: crypto.randomUUID(),
    });
    assert.strictEqual(bonus.ok, true);
    assert.strictEqual((await redeem({ shop, shopifyCustomerId: A, idempotencyKey: crypto.randomUUID() })).ok, true);
    await storeWebhook({ shop, topic: 'refunds/create', shopifyWebhookId: crypto.randomUUID(), payload: { id: uniqueId(), order_id: orderC, refund_line_items: [{ line_item_id: 1, quantity: 1 }] } });
    await processPendingWebhooks({ shop });
    restoreClock(); // the admin's session lives on the same clock: the API is called in real time
    void orderA;
  }

  test('the numbers of a real ledger scenario, exactly', async () => {
    await scenario();
    const r = await admin.get('overview');
    assert.strictEqual(r.status, 200, r.text);
    const d = r.json;
    assert.strictEqual(d.configured, true);
    assert.deepStrictEqual(d.rule, { pointsPerReward: 500, rewardValue: '50.00', currency: 'INR', holdPeriodDays: 30 });
    assert.deepStrictEqual(d.members, { total: 3, active90: 3, new30: 3, buyers: 3, returningBuyers: 0 });
    assert.deepStrictEqual(d.points, { issued: 1400, pending: 300, available: 200, redeemed: 500, expired: 0, reversed: 400, owed: 0 });
    assert.deepStrictEqual(d.values, { issued: '140.00', pending: '30.00', available: '20.00', redeemed: '50.00', expired: '0.00', reversed: '40.00', owed: '0.00' });
    assert.deepStrictEqual(d.liability.available, { points: 200, value: '20.00' });
    assert.deepStrictEqual(d.liability.openCodes, { count: 1, value: '50.00' });
    assert.deepStrictEqual(d.rewards, { unlocked: 1, used: 0, usedValue: '0.00', open: 1 });
    assert.ok(Math.abs(d.redemptionRate - 500 / 1100) < 1e-9, 'redeemed / (issued - pending)');
    assert.strictEqual(d.business.available, false);
    assert.strictEqual(d.events.counts.processed, 4, '3 paid + 1 refund');
    assert.strictEqual(d.events.recent.length, 4);
    assert.deepStrictEqual(Object.keys(d.events.recent[0]).sort(), ['attempts', 'receivedAt', 'status', 'topic']);
  });

  test('expired codes and owed points show up; a returned expiry is not counted as expired', async () => {
    await scenario();
    const reward = await prisma.reward.findFirst({ where: { shop } });
    await prisma.reward.update({ where: { id: reward.id }, data: { status: 'expired' } });
    const account = await prisma.loyaltyAccount.findFirst({ where: { shop, shopifyCustomerId: '1001' } });
    await prisma.loyaltyAccount.update({ where: { id: account.id }, data: { debt: 40 } });
    const d = (await admin.get('overview')).json;
    assert.strictEqual(d.points.expired, 500);
    assert.strictEqual(d.values.expired, '50.00');
    assert.deepStrictEqual(d.liability.openCodes, { count: 0, value: '0.00' });
    assert.deepStrictEqual(d.liability.owed, { points: 40, value: '4.00' });

    await prisma.ledgerEntry.create({ data: { accountId: account.id, type: 'reward_return', points: 500, dedupeKey: `t:${crypto.randomUUID()}`, rewardId: reward.id } });
    assert.strictEqual((await admin.get('overview')).json.points.expired, 0, 'its points came back');
  });

  test('an empty shop is all zeros, not an error', async () => {
    const d = (await admin.get('overview')).json;
    assert.deepStrictEqual(d.members, { total: 0, active90: 0, new30: 0, buyers: 0, returningBuyers: 0 });
    assert.deepStrictEqual(d.points, { issued: 0, pending: 0, available: 0, redeemed: 0, expired: 0, reversed: 0, owed: 0 });
    assert.strictEqual(d.redemptionRate, null);
    assert.deepStrictEqual(d.events.recent, []);
  });

  test('only this shop\'s data: another shop\'s accounts and events are not counted', async () => {
    await scenario();
    const other = `ovw-other-${Date.now()}.myshopify.com`;
    await prisma.loyaltyConfig.create({ data: { shop: other } });
    await prisma.loyaltyAccount.create({ data: { shop: other, shopifyCustomerId: '9', available: 5000, pending: 70, debt: 3 } });
    await prisma.webhookEvent.create({ data: { shop: other, topic: 'orders/paid', payload: {}, status: 'failed' } });
    const d = (await admin.get('overview')).json;
    assert.strictEqual(d.members.total, 3);
    assert.strictEqual(d.points.available, 200);
    assert.strictEqual(d.events.counts.failed, undefined);
  });

  test('the response is a whitelist: no shop, no ids, no customer ids, no codes, no payloads', async () => {
    await scenario();
    const r = await admin.get('overview');
    const keys = allKeys(r.json);
    for (const bad of ['id', 'shop', 'accountId', 'shopifyCustomerId', 'discountCode', 'payload', 'lastError', 'passwordHash', 'email']) assert.ok(!keys.has(bad), `no "${bad}"`);
    for (const secret of [shop, '1001', '1002', '1003']) assert.ok(!r.text.includes(`"${secret}"`), `"${secret}" is not in the response`);
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['asOf', 'business', 'configured', 'events', 'liability', 'members', 'ok', 'points', 'redemptionRate', 'rewards', 'rule', 'values', 'worker']);
  });

  test('it needs a session, and the one-time password must have been changed', async () => {
    const anon = await fetch(`${site.url}/api/overview`);
    assert.strictEqual(anon.status, 401);
    const forced = await adminBrowser(site.url, shop, { mustChange: true });
    const r = await forced.get('overview');
    assert.deepStrictEqual([r.status, r.json.error], [403, 'PASSWORD_CHANGE_REQUIRED']);
  });

  test('a shop with no loyalty rule says so', async () => {
    const noRule = `ovw-norule-${Date.now()}.myshopify.com`;
    process.env.ADMIN_SHOP = noRule; // the console serves this shop; it has an admin but no LoyaltyConfig
    const b = await adminBrowser(site.url, noRule);
    assert.deepStrictEqual((await b.get('overview')).json, { ok: true, configured: false });
  });

  // ---- the page ----

  test('the page renders the API numbers; hostile values are escaped', async () => {
    await scenario();
    const d = (await admin.get('overview')).json;
    d.events.recent[0].topic = '<img src=x onerror=alert(1)>';
    d.events.recent[0].status = 'failed"><script>x</script>';
    const html = String(renderOverview(d));
    assert.ok(html.includes('Rewards overview'));
    for (const text of ['1,400', '₹140', '₹20', '₹50', 'Where issued points are now', 'Not available in this version']) assert.ok(html.includes(text), `has ${text}`);
    assert.ok(!html.includes('<img src=x') && !html.includes('<script>x'), 'hostile markup is not in the output as markup');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(/<svg class="stack-svg"[^>]*role="img"/.test(html), 'the bar is an SVG (no inline style under the CSP)');
    assert.ok(!/\sstyle=/.test(html), 'no inline style attribute');
  });

  test('the page says when events are failing, and renders an unconfigured shop', () => {
    const base = { configured: true, asOf: new Date().toISOString(), rule: { pointsPerReward: 100, rewardValue: '10.00', currency: 'USD', holdPeriodDays: 30 },
      members: { total: 0, active90: 0, new30: 0, buyers: 0, returningBuyers: 0 }, points: { issued: 0, pending: 0, available: 0, redeemed: 0, expired: 0, reversed: 0, owed: 0 },
      values: { issued: '0.00', pending: '0.00', available: '0.00', redeemed: '0.00', expired: '0.00', reversed: '0.00', owed: '0.00' },
      liability: { available: { points: 0, value: '0.00' }, openCodes: { count: 0, value: '0.00' }, pending: { points: 0, value: '0.00' }, redeemed: { points: 0, value: '0.00', usedValue: '0.00' }, expired: { points: 0, value: '0.00' }, owed: { points: 0, value: '0.00' } },
      rewards: { unlocked: 0, used: 0, usedValue: '0.00', open: 0 }, redemptionRate: null, business: { available: false, reason: 'n/a' }, events: { counts: { dead: 2, failed: 1 }, recent: [] } };
    assert.match(String(renderOverview(base)), /3 webhook events failed or dead/);
    assert.match(String(renderOverview(base)), /\$10/);
    assert.match(String(renderOverview({ configured: false })), /no loyalty rule/);
  });
});
