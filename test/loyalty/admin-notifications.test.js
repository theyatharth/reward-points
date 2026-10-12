// test/loyalty/admin-notifications.test.js
//
// Admin console, Notifications: a read-only log of the on-site notifications (whitelisted, scoped to the shop), and the page.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { startConsole, adminBrowser, allKeys } from '../helpers/admin-http.js';
import { renderNotifications } from '../../web/admin/public/pages/notifications.js';

describe('Admin notifications', () => {
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
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    shop = `anotif-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    process.env.ADMIN_SHOP = shop;
    await prisma.loyaltyConfig.create({ data: { shop, currency: 'INR', ledgerStartAt: new Date('2026-01-01T00:00:00Z') } });
    admin = await adminBrowser(site.url, shop);
  });

  const seed = async (rows) => {
    const acc = await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: '6001' } });
    let i = 0;
    for (const [type, data, readAt] of rows) {
      await prisma.notification.create({ data: { accountId: acc.id, shop, type, data, dedupeKey: `t:${crypto.randomUUID()}`, readAt: readAt ?? null, createdAt: new Date(Date.now() - (rows.length - i++) * 1000) } });
    }
    return acc;
  };

  test('the log: sentence, customer, read flag, newest first, counts per type; paged', async () => {
    await seed([['points_earned', { points: 600, orderRef: '#1042' }], ['points_activated', { points: 600 }], ['reward_redeemed', { pointsUsed: 500, valuePaise: 5000 }, new Date()], ['points_earned', { points: 5, orderRef: null }]]);
    const r = await admin.get('notifications');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json.notifications.map((n) => n.text), ["You're earning 5 points", 'Your ₹50 reward is ready to use (500 points)', '600 points are now available to use', "You're earning 600 points on order #1042"]);
    assert.deepStrictEqual(r.json.notifications.map((n) => n.read), [false, true, false, false]);
    assert.ok(r.json.notifications.every((n) => n.customerId === '6001'));
    assert.deepStrictEqual(r.json.counts, { points_earned: 2, points_activated: 1, reward_redeemed: 1 });
    assert.deepStrictEqual(Object.keys(r.json.notifications[0]).sort(), ['createdAt', 'customerId', 'read', 'text', 'type']);

    const p1 = await admin.get('notifications?limit=3');
    assert.strictEqual(p1.json.notifications.length, 3);
    const p2 = await admin.get(`notifications?limit=3&cursor=${p1.json.nextCursor}`);
    assert.deepStrictEqual([p2.json.notifications.length, p2.json.nextCursor], [1, null]);
  });

  test('a whitelist and scoped to the shop; it needs a session and an open console', async () => {
    await seed([['points_earned', { points: 1, orderRef: 'x', secret: 'LEAK' }]]);
    const other = `anotif-other-${Date.now()}.myshopify.com`;
    await prisma.loyaltyConfig.create({ data: { shop: other } });
    const acc = await prisma.loyaltyAccount.create({ data: { shop: other, shopifyCustomerId: '6002' } });
    await prisma.notification.create({ data: { accountId: acc.id, shop: other, type: 'points_earned', data: { points: 9 }, dedupeKey: `t:${crypto.randomUUID()}` } });
    const r = await admin.get('notifications');
    assert.strictEqual(r.json.notifications.length, 1);
    assert.ok(!r.text.includes('LEAK') && !r.text.includes('6002'));
    const keys = allKeys(r.json);
    for (const bad of ['id', 'accountId', 'data', 'dedupeKey', 'shop']) assert.ok(!keys.has(bad), `no "${bad}"`);
    assert.strictEqual((await fetch(`${site.url}/api/notifications`)).status, 401);
    assert.strictEqual((await (await adminBrowser(site.url, shop, { mustChange: true })).get('notifications')).status, 403);
  });

  test('the page lists the log, says what is not available, and escapes everything', () => {
    const html = String(renderNotifications({ items: [{ type: 'points_earned', customerId: '6001', text: '<img src=x onerror=alert(1)>', createdAt: '2026-10-12T09:00:00.000Z', read: false }], next: 'n2', counts: { points_earned: 1 } }));
    for (const text of ['Notifications', 'Points earned', 'Load more', 'Not available in this version', 'WhatsApp']) assert.ok(html.includes(text), `has ${text}`);
    assert.ok(!html.includes('<img src=x') && html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!/\sstyle=/.test(html));
    assert.match(String(renderNotifications({ items: [], next: null, counts: {} })), /No notifications yet/);
  });
});
