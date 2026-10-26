// test/loyalty/admin-customers.test.js
//
// Admin console, Customers: search by Shopify id, the account detail (balances, lots, rewards, orders, a page of the
// ledger with the admin's own notes), adjusting points, isolation between shops, the whitelist, and the page.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { setFixedTime, restoreClock } from '../../web/loyalty/adapters/clock.js';
import { startConsole, adminBrowser, allKeys } from '../helpers/admin-http.js';
import { uniqueId } from '../helpers/ids.js';
import { renderCustomers } from '../../web/admin/public/pages/customers.js';

describe('Admin customers', () => {
  let site;
  let shop;
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
    restoreClock();
    shop = `cust-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    process.env.ADMIN_SHOP = shop;
    ledgerService.setGatewayFactory(() => new FakeShopifyGateway(shop));
    await prisma.loyaltyConfig.create({
      data: { shop, spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, currency: 'INR', holdPeriodDays: 30, ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
    });
    admin = await adminBrowser(site.url, shop);
  });

  const earn = async (customer, points, orderId = uniqueId()) => {
    await storeWebhook({ shop, topic: 'orders/paid', shopifyWebhookId: crypto.randomUUID(),
      payload: { id: orderId, customer: { id: customer }, processed_at: new Date().toISOString(), line_items: [{ id: 1, quantity: 2, price: String(points / 2), title: 'x' }] } });
    await processPendingWebhooks({ shop });
    return orderId;
  };
  const adjust = (id, body) => admin.post(`customers/${id}/adjust`, { idempotencyKey: crypto.randomUUID(), ...body });
  const account = (id) => prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: id } } });

  // ===================== search =====================

  test('search: an exact id, a prefix of 4+ digits, and the recent list; not digits is a hint, not an error', async () => {
    for (const id of ['4001', '4002', '40019999', '777']) await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: id, available: 10 } });
    const ids = async (q) => (await admin.get(`customers?query=${encodeURIComponent(q)}`)).json.results.map((r) => r.shopifyCustomerId);

    assert.deepStrictEqual(await ids('777'), ['777']);
    assert.deepStrictEqual(await ids('4001'), ['4001', '40019999'], 'a prefix of 4 or more digits');
    assert.deepStrictEqual(await ids('400'), [], 'under 4 digits only an exact id matches');
    assert.strictEqual((await ids('')).length, 4, 'empty: the most recent members');
    const bad = (await admin.get('customers?query=jane%40example.com')).json;
    assert.deepStrictEqual([bad.ok, bad.results], [true, []]);
    assert.match(bad.hint, /digits only/);
    const one = (await admin.get('customers?query=777')).json.results[0];
    assert.deepStrictEqual(Object.keys(one).sort(), ['available', 'availableValue', 'owed', 'pending', 'shopifyCustomerId']);
    assert.strictEqual(one.availableValue, '1.00', '10 points = 1.00 at 500 for 50.00');
  });

  test('search never returns another shop\'s members', async () => {
    const other = `cust-other-${Date.now()}.myshopify.com`;
    await prisma.loyaltyConfig.create({ data: { shop: other } });
    await prisma.loyaltyAccount.create({ data: { shop: other, shopifyCustomerId: '555500' } });
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: '555501' } });
    assert.deepStrictEqual((await admin.get('customers?query=5555')).json.results.map((r) => r.shopifyCustomerId), ['555501']);
    assert.strictEqual((await admin.get('customers/555500')).status, 404, 'the other shop\'s member is not found');
  });

  // ===================== detail =====================

  test('detail: balances, lifetime figures, lots, orders, rewards, and the ledger with the admin\'s own note', async () => {
    const orderRef = await earn('9001', 600); // 600 pending, 2 units
    await adjust('9001', { points: 100, reason: 'Special bonus', note: 'Monsoon garden bonus' });
    await adjust('9001', { points: -40, reason: 'Duplicate points', note: 'credited twice by mistake' });
    await storeWebhook({ shop, topic: 'refunds/create', shopifyWebhookId: crypto.randomUUID(), payload: { id: uniqueId(), order_id: orderRef, refund_line_items: [{ line_item_id: 1, quantity: 1 }] } });
    await processPendingWebhooks({ shop });

    const r = await admin.get('customers/9001');
    assert.strictEqual(r.status, 200, r.text);
    const d = r.json;
    assert.deepStrictEqual(d.account, {
      shopifyCustomerId: '9001', available: 60, pending: 300, owed: 0, availableValue: '6.00', pendingValue: '30.00', owedValue: '0.00',
      memberSince: d.account.memberSince, lifetimeEarned: 600 + 100 - 300, lifetimeRedeemed: 0, // deductions are not "earned": the design counts earnings net of returns
    });
    assert.deepStrictEqual(d.rule, { pointsPerReward: 500, rewardValue: '50.00', currency: 'INR', holdPeriodDays: 30 });

    assert.deepStrictEqual(d.orders.map((o) => [o.orderRef, o.eligible, o.pointsEarned, o.pointsReversed, o.state]), [[String(orderRef), '600.00', 600, 300, 'partly reversed']]);
    assert.deepStrictEqual(d.lots.map((l) => [l.source, l.status, l.originalPoints, l.remaining]).sort(), [['adjustment', 'active', 100, 60], ['order', 'pending', 600, 300]]);

    const byType = Object.fromEntries(d.ledger.entries.map((e) => [e.type, e]));
    assert.deepStrictEqual(Object.keys(byType).sort(), ['adjustment', 'bonus', 'earn', 'refund']);
    assert.strictEqual(byType.bonus.adminNote, 'Monsoon garden bonus');
    assert.strictEqual(byType.bonus.adminReason, 'Special bonus');
    assert.strictEqual(byType.bonus.adminEmail, admin.email, 'who made it');
    assert.strictEqual(byType.adjustment.adminNote, 'credited twice by mistake');
    assert.strictEqual(byType.refund.orderRef, String(orderRef));
    assert.strictEqual(byType.earn.adminNote, null);
    assert.strictEqual(byType.earn.points, 600);
    assert.strictEqual(byType.refund.points, -300);
    assert.strictEqual(byType.bonus.source, 'adjust');
    assert.strictEqual(d.ledger.nextCursor, null);
  });

  test('the ledger is paged: limit and cursor give every entry exactly once, newest first', async () => {
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: '9100' } });
    for (let i = 0; i < 5; i++) await adjust('9100', { points: 10 + i, reason: 'Missing points', note: `adjustment number ${i}` });
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const r = await admin.get(`customers/9100?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      assert.strictEqual(r.status, 200);
      seen.push(...r.json.ledger.entries.map((e) => e.points));
      cursor = r.json.ledger.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    assert.strictEqual(pages, 3);
    assert.deepStrictEqual(seen, [14, 13, 12, 11, 10], 'newest first, none twice, none missing');
    assert.strictEqual((await admin.get('customers/9100?cursor=not%20a%20cursor!!')).status, 200, 'a malformed cursor is ignored');
  });

  test('the detail is a whitelist: no internal ids, no dedupe keys, no shop, no payloads', async () => {
    await earn('9200', 400);
    await adjust('9200', { points: 5, reason: 'Missing points', note: 'for the whitelist test' });
    const r = await admin.get('customers/9200');
    const keys = allKeys(r.json);
    for (const bad of ['accountId', 'lotId', 'orderId', 'dedupeKey', 'redemptionId', 'rewardId', 'refundId', 'shop', 'passwordHash', 'payload', 'userId', 'adminId', 'detail']) {
      assert.ok(!keys.has(bad), `no "${bad}"`);
    }
    assert.ok(!r.text.includes(shop));
    assert.ok(!/adjust:[0-9a-f-]{36}:/.test(r.text), 'no dedupe key (it holds the account id)');
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['account', 'lots', 'ledger', 'ok', 'orders', 'rewards', 'rule'].sort());
    assert.deepStrictEqual(Object.keys(r.json.ledger.entries[0]).sort(), ['adminEmail', 'adminNote', 'adminReason', 'createdAt', 'id', 'note', 'orderRef', 'points', 'source', 'status', 'type']);
  });

  test('unknown or malformed ids are 404', async () => {
    assert.strictEqual((await admin.get('customers/123456')).status, 404);
    assert.strictEqual((await admin.get('customers/abc')).status, 404);
    assert.strictEqual((await admin.get('customers/1%20OR%201=1')).status, 404);
  });

  // ===================== adjust =====================

  test('add and deduct: the right entry types, balances, audit row with the admin, and replay', async () => {
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: '9300' } });
    const key = crypto.randomUUID();
    const add = await adjust('9300', { points: 200, reason: 'Customer service goodwill', note: 'Delayed delivery apology', idempotencyKey: key });
    assert.deepStrictEqual([add.status, add.json.ok, add.json.type, add.json.available, add.json.owed, add.json.replayed], [200, true, 'adjustment', 200, 0, false]);
    const again = await adjust('9300', { points: 200, reason: 'Customer service goodwill', note: 'Delayed delivery apology', idempotencyKey: key });
    assert.strictEqual(again.json.replayed, true);
    assert.strictEqual((await account('9300')).available, 200, 'applied once');

    const bonus = await adjust('9300', { points: 50, reason: 'Special bonus', note: 'Festive bonus' });
    assert.strictEqual(bonus.json.type, 'bonus');
    const ded = await adjust('9300', { points: -100, reason: 'Order issue correction', note: 'Wrong order credit' });
    assert.deepStrictEqual([ded.status, ded.json.available], [200, 150]);

    const audits = await prisma.auditLog.findMany({ where: { shop, action: 'points_adjusted' } });
    assert.strictEqual(audits.length, 3);
    assert.ok(audits.every((a) => a.adminId === admin.admin.id));
  });

  test('refusals: each rule has its own error and writes nothing', async () => {
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: '9400' } });
    await adjust('9400', { points: 100, reason: 'Missing points', note: 'setup balance' });
    const before = await prisma.ledgerEntry.count({ where: { accountId: (await account('9400')).id } });
    const cases = [
      [{ points: 0 }, 400, 'INVALID_POINTS'], [{ points: 1.5 }, 400, 'INVALID_POINTS'], [{ points: '10' }, 400, 'INVALID_POINTS'],
      [{ points: 5, reason: 'Duplicate points' }, 400, 'INVALID_REASON'],          // a deduct reason on an addition
      [{ points: -5, reason: 'Special bonus' }, 400, 'INVALID_REASON'],            // an add reason on a deduction
      [{ points: 5, reason: 'made up' }, 400, 'INVALID_REASON'], [{ points: 5, reason: '' }, 400, 'INVALID_REASON'],
      [{ points: 5, note: 'abc' }, 400, 'NOTE_TOO_SHORT'], [{ points: 5, note: '' }, 400, 'NOTE_TOO_SHORT'],
      [{ points: 5, idempotencyKey: '' }, 400, 'INVALID_KEY'],
      [{ points: -101, reason: 'Duplicate points', note: 'one more than there is' }, 409, 'EXCEEDS_AVAILABLE'],
    ];
    for (const [over, status, error] of cases) {
      const r = await adjust('9400', { points: 5, reason: 'Missing points', note: 'a valid note', ...over });
      assert.deepStrictEqual([r.status, r.json.error], [status, error], JSON.stringify(over));
    }
    assert.strictEqual((await adjust('999999', { points: 5, reason: 'Missing points', note: 'no such member' })).status, 404);
    assert.strictEqual(await prisma.ledgerEntry.count({ where: { accountId: (await account('9400')).id } }), before);
    assert.strictEqual((await account('9400')).available, 100);
  });

  test('a member of another shop cannot be adjusted', async () => {
    const other = `cust-other-${Date.now()}.myshopify.com`;
    await prisma.loyaltyConfig.create({ data: { shop: other } });
    await prisma.loyaltyAccount.create({ data: { shop: other, shopifyCustomerId: '9500' } });
    assert.strictEqual((await adjust('9500', { points: 5, reason: 'Missing points', note: 'wrong shop' })).status, 404);
    assert.strictEqual((await prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop: other, shopifyCustomerId: '9500' } } })).available, 0);
  });

  test('adjusting needs the CSRF token and an open console', async () => {
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: '9600' } });
    const noToken = await admin.req('POST', 'customers/9600/adjust', { points: 5, reason: 'Missing points', note: 'no token', idempotencyKey: 'k' }, { 'X-CSRF-Token': '' });
    assert.strictEqual(noToken.status, 403);
    const forced = await adminBrowser(site.url, shop, { mustChange: true });
    assert.strictEqual((await forced.post('customers/9600/adjust', { points: 5, reason: 'Missing points', note: 'forced change', idempotencyKey: 'k' })).status, 403);
    assert.strictEqual((await account('9600')).available, 0);
  });

  // ===================== page =====================

  const sample = () => ({
    list: { results: [{ shopifyCustomerId: '9001', available: 60, pending: 300, owed: 5, availableValue: '6.00' }], hint: null },
    selected: '9001',
    meta: { reasons: { add: ['Special bonus'], deduct: ['Duplicate points'] }, minNoteLength: 5 },
    detail: {
      account: { shopifyCustomerId: '9001', available: 60, pending: 300, owed: 5, availableValue: '6.00', pendingValue: '30.00', owedValue: '0.50', memberSince: '2026-10-01T00:00:00.000Z', lifetimeEarned: 360, lifetimeRedeemed: 0 },
      rule: { pointsPerReward: 500, rewardValue: '50.00', currency: 'INR', holdPeriodDays: 30 },
      lots: [{ status: 'pending', originalPoints: 600, remaining: 300, activatesAt: '2026-11-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', source: 'order', orderRef: '1019' }],
      rewards: [{ code: 'PLAT-ABCD2345', status: 'active', pointsUsed: 500, value: '50.00', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', usedOrderRef: null, deletePending: false }],
      orders: [{ orderRef: '1019', processedAt: '2026-10-01T00:00:00.000Z', eligible: '600.00', pointsEarned: 600, pointsReversed: 300, state: 'partly reversed' }],
      ledger: { entries: [{ id: 'e1', createdAt: '2026-10-01T00:00:00.000Z', type: 'bonus', points: 100, status: 'active', note: 'Special bonus from the shop', source: 'adjust', orderRef: null, adminNote: '<script>alert(1)</script>', adminReason: 'Special bonus', adminEmail: 'a@b.test' }], nextCursor: 'e2' },
    },
  });

  test('the page shows balances, lots, ledger, orders and rewards, and escapes every value', () => {
    const data = sample();
    data.detail.ledger.entries[0].note = '<img src=x onerror=alert(2)>';
    data.list.results[0].shopifyCustomerId = '9001"><b>';
    const html = String(renderCustomers(data));
    for (const text of ['Customer', '9001', 'Ledger', 'Point lots', 'PLAT-ABCD2345', 'partly reversed', 'Being recovered', 'Load more', 'Add Points', 'Deduct Points']) assert.ok(html.includes(text), `has ${text}`);
    assert.ok(!html.includes('<script>alert(1)') && !html.includes('<img src=x') && !html.includes('9001"><b>'), 'hostile markup is inert');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && html.includes('&lt;img src=x onerror=alert(2)&gt;'));
    assert.ok(!/\sstyle=/.test(html));
  });

  test('without a selection the page asks for one; without results it says no match', () => {
    const none = { list: { results: [], hint: 'Search by Shopify customer id: digits only.' }, selected: null, meta: sample().meta, detail: null };
    const html = String(renderCustomers(none));
    assert.match(html, /Pick a member/);
    assert.match(html, /No match/);
    assert.match(html, /digits only/);
  });
});
