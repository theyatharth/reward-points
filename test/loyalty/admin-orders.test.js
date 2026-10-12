// test/loyalty/admin-orders.test.js
//
// Admin console, Orders & webhooks: the orders that earned points (with reversals and the reward used), the event
// queue with its filters and counts, retrying a failed or dead event, and the page.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooksWithStats } from '../../web/loyalty/service/webhook.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { setFixedTime, restoreClock } from '../../web/loyalty/adapters/clock.js';
import { startConsole, adminBrowser, allKeys } from '../helpers/admin-http.js';
import { uniqueId } from '../helpers/ids.js';
import { renderOrders } from '../../web/admin/public/pages/orders.js';

describe('Admin orders and webhooks', () => {
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
    restoreClock();
    shop = `ord-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    process.env.ADMIN_SHOP = shop;
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
    await prisma.loyaltyConfig.create({
      data: { shop, spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, currency: 'INR', holdPeriodDays: 30, ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
    });
    admin = await adminBrowser(site.url, shop);
  });

  const process_ = () => processPendingWebhooksWithStats({ shop });
  const send = (topic, payload) => storeWebhook({ shop, topic, payload, shopifyWebhookId: crypto.randomUUID() });
  let minute = 0;
  const paid = async (customer, points, { orderId = uniqueId(), units = 2 } = {}) => {
    const at = new Date(Date.now() - (++minute) * 60 * 1000 * -1 - 3600 * 1000).toISOString(); // strictly increasing, an hour ago
    await send('orders/paid', { id: orderId, customer: { id: customer }, processed_at: at, line_items: [{ id: 1, quantity: units, price: String(points / units), title: 'x' }] });
    await process_();
    return orderId;
  };
  const rawEvent = (data) => prisma.webhookEvent.create({ data: { shop, shopifyWebhookId: crypto.randomUUID(), topic: 'orders/paid', payload: {}, status: 'processed', ...data } });

  // ===================== orders =====================

  test('orders: points, reversals, state, the lot, the reward used; newest first; paged; whitelisted', async () => {
    const x = await paid('1001', 200); // 2 units x 100
    const y = await paid('1002', 300);
    const z = await paid('1003', 100, { units: 1 });
    const w = await paid('1004', 400);
    await send('refunds/create', { id: uniqueId(), order_id: x, refund_line_items: [{ line_item_id: 1, quantity: 1 }] });
    await send('orders/cancelled', { id: y });
    await process_();
    const acc = await prisma.loyaltyAccount.findFirst({ where: { shop, shopifyCustomerId: '1003' } });
    await prisma.reward.create({ data: { accountId: acc.id, shop, discountCode: 'ORD-USED0001', discountCodeId: 'gid://x/1', valueInPaise: 5000, pointsUsed: 500, status: 'used', usedOrderId: String(z) } });

    const r = await admin.get('orders');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json.orders.map((o) => o.orderRef), [w, z, y, x].map(String), 'newest first');
    const byRef = Object.fromEntries(r.json.orders.map((o) => [o.orderRef, o]));
    assert.deepStrictEqual([byRef[x].state, byRef[x].pointsEarned, byRef[x].pointsReversed, byRef[x].eligible], ['partly reversed', 200, 100, '200.00']);
    assert.deepStrictEqual([byRef[y].state, byRef[y].pointsReversed], ['cancelled', 300]);
    assert.deepStrictEqual([byRef[z].state, byRef[z].rewardUsed, byRef[w].rewardUsed], ['earned', true, false]);
    assert.deepStrictEqual([byRef[w].customerId, byRef[w].lot.status, byRef[w].lot.remaining], ['1004', 'pending', 400]);
    assert.deepStrictEqual(Object.keys(byRef[w]).sort(), ['customerId', 'eligible', 'lot', 'orderRef', 'pointsEarned', 'pointsReversed', 'processedAt', 'rewardUsed', 'state']);
    const keys = allKeys(r.json);
    for (const bad of ['id', 'accountId', 'lotId', 'shop', 'lines', 'payload']) assert.ok(!keys.has(bad), `no "${bad}"`);

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await admin.get(`orders?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.json.orders.map((o) => o.orderRef));
      cursor = page.json.nextCursor;
      pages++;
    } while (cursor && pages < 5);
    assert.deepStrictEqual([pages, seen], [2, [w, z, y, x].map(String)]);
  });

  test('another shop\'s orders are not listed', async () => {
    const other = `ord-other-${Date.now()}.myshopify.com`;
    await prisma.loyaltyConfig.create({ data: { shop: other, ledgerStartAt: new Date('2026-01-01T00:00:00Z') } });
    const acc = await prisma.loyaltyAccount.create({ data: { shop: other, shopifyCustomerId: '5' } });
    await prisma.loyaltyOrder.create({ data: { accountId: acc.id, shop: other, shopifyOrderId: '777', pointsEarned: 1, eligibleAmountPaise: 100, processedAt: new Date() } });
    assert.deepStrictEqual((await admin.get('orders')).json.orders, []);
  });

  // ===================== events =====================

  test('events: filter by status and topic, counts for every status, order and refund references, never the payload', async () => {
    const secret = 'SECRET-PAYLOAD-VALUE';
    await rawEvent({ topic: 'orders/paid', status: 'processed', payload: { id: 7001, customer: { id: 1 }, note: secret } });
    await rawEvent({ topic: 'refunds/create', status: 'failed', attempts: 2, lastError: 'Original order not yet in ledger, retry later', nextRetryAt: new Date(Date.now() + 60000), payload: { id: 8001, order_id: 7001, note: secret } });
    await rawEvent({ topic: 'orders/cancelled', status: 'dead', attempts: 6, lastError: 'boom', payload: { id: 7002 } });
    await rawEvent({ topic: 'orders/paid', status: 'pending', payload: { id: 7003 } });
    await rawEvent({ topic: 'orders/paid', status: 'skipped', lastError: 'Guest checkout (no customer)', payload: { id: 7004 } });

    const all = await admin.get('events');
    assert.strictEqual(all.json.events.length, 5);
    assert.deepStrictEqual(all.json.counts, { pending: 1, processing: 0, processed: 1, failed: 1, dead: 1, skipped: 1 });
    assert.ok(!all.text.includes(secret), 'the payload never leaves the server');
    assert.deepStrictEqual(Object.keys(all.json.events[0]).sort(), ['attempts', 'canRetry', 'id', 'lastError', 'nextRetryAt', 'orderRef', 'purged', 'receivedAt', 'refundRef', 'status', 'topic']);

    const failed = (await admin.get('events?status=failed')).json.events;
    assert.deepStrictEqual(failed.map((e) => [e.topic, e.orderRef, e.refundRef, e.canRetry, e.attempts]), [['refunds/create', '7001', '8001', true, 2]]);
    assert.deepStrictEqual((await admin.get('events?status=dead')).json.events.map((e) => [e.orderRef, e.refundRef, e.canRetry]), [['7002', null, true]]);
    assert.deepStrictEqual((await admin.get('events?status=processed')).json.events.map((e) => e.canRetry), [false]);
    assert.strictEqual((await admin.get('events?topic=orders/paid')).json.events.length, 3);
    assert.strictEqual((await admin.get('events?status=nonsense')).json.events.length, 5, 'an unknown status is ignored, not an error');
    assert.strictEqual((await admin.get('events?status=failed&topic=orders/paid')).json.events.length, 0);
  });

  test('events are paged newest first with every event once; another shop\'s events never appear', async () => {
    for (let i = 0; i < 5; i++) await rawEvent({ payload: { id: 9000 + i } });
    const other = `ord-other-${Date.now()}.myshopify.com`;
    await prisma.webhookEvent.create({ data: { shop: other, topic: 'orders/paid', payload: { id: 1 }, status: 'failed' } });
    const refs = [];
    let cursor = null;
    let pages = 0;
    do {
      const r = await admin.get(`events?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      refs.push(...r.json.events.map((e) => e.orderRef));
      cursor = r.json.nextCursor;
      pages++;
    } while (cursor && pages < 6);
    assert.deepStrictEqual([pages, refs], [3, ['9004', '9003', '9002', '9001', '9000']]);
    assert.strictEqual((await admin.get('events?status=failed')).json.events.length, 0);
  });

  // ===================== retry =====================

  test('retry (end to end): a refund that failed because its order was missing is applied after the retry', async () => {
    const orderId = uniqueId();
    gw.addOrder({ id: orderId, processed_at: new Date().toISOString() }); // Shopify knows the order, the ledger does not yet
    const refundEvent = await send('refunds/create', { id: uniqueId(), order_id: orderId, refund_line_items: [{ line_item_id: 1, quantity: 1 }] });
    await process_();
    let row = await prisma.webhookEvent.findUnique({ where: { id: refundEvent.id } });
    assert.strictEqual(row.status, 'failed');
    await prisma.webhookEvent.update({ where: { id: refundEvent.id }, data: { status: 'dead', attempts: 6, nextRetryAt: null } }); // gave up

    await paid('1001', 200, { orderId });
    const r = await admin.post(`events/${refundEvent.id}/retry`, {});
    assert.deepStrictEqual([r.status, r.json], [200, { ok: true, status: 'pending' }]);
    row = await prisma.webhookEvent.findUnique({ where: { id: refundEvent.id } });
    assert.deepStrictEqual([row.status, row.attempts, row.nextRetryAt], ['pending', 0, null], 'a fresh start');
    assert.ok(row.lastError, 'the earlier error is kept for reference');

    await process_();
    assert.strictEqual((await prisma.webhookEvent.findUnique({ where: { id: refundEvent.id } })).status, 'processed');
    assert.strictEqual((await prisma.loyaltyAccount.findFirst({ where: { shop, shopifyCustomerId: '1001' } })).pending, 100, 'one of two units reversed');

    const audit = await prisma.auditLog.findMany({ where: { shop, action: 'event_retried' } });
    assert.strictEqual(audit.length, 1);
    assert.strictEqual(audit[0].adminId, admin.admin.id);
    assert.deepStrictEqual(audit[0].detail, { eventId: refundEvent.id, topic: 'refunds/create', previousStatus: 'dead', orderRef: String(orderId) });
  });

  test('retry of an event that is genuinely bad fails visibly again, it does not loop', async () => {
    const orderId = await paid('1002', 200);
    const bad = await send('refunds/create', { id: uniqueId(), order_id: orderId, refund_line_items: [{ line_item_id: 1, quantity: 5 }] }); // more than the 2 units
    await process_();
    assert.strictEqual((await prisma.webhookEvent.findUnique({ where: { id: bad.id } })).status, 'dead');
    assert.strictEqual((await admin.post(`events/${bad.id}/retry`, {})).status, 200);
    await process_();
    const row = await prisma.webhookEvent.findUnique({ where: { id: bad.id } });
    assert.deepStrictEqual([row.status, row.attempts], ['dead', 1]);
    assert.match(row.lastError, /above the line quantity/);
  });

  test('retry refusals: processed, pending and skipped are not retryable (409), a purged payload cannot be, unknown and foreign events are 404', async () => {
    for (const status of ['processed', 'pending', 'skipped', 'processing']) {
      const e = await rawEvent({ status });
      const r = await admin.post(`events/${e.id}/retry`, {});
      assert.deepStrictEqual([r.status, r.json.error], [409, 'NOT_RETRYABLE'], status);
      assert.strictEqual((await prisma.webhookEvent.findUnique({ where: { id: e.id } })).status, status, 'unchanged');
    }
    const purged = await rawEvent({ status: 'dead', payload: { _purged: true }, payloadPurgedAt: new Date() });
    const p = await admin.post(`events/${purged.id}/retry`, {});
    assert.deepStrictEqual([p.status, p.json.error], [409, 'PAYLOAD_PURGED']);
    assert.strictEqual((await admin.get('events')).json.events.find((e) => e.id === purged.id).canRetry, false);

    const other = await prisma.webhookEvent.create({ data: { shop: `ord-other-${Date.now()}.myshopify.com`, topic: 'orders/paid', payload: { id: 1 }, status: 'dead' } });
    assert.strictEqual((await admin.post(`events/${other.id}/retry`, {})).status, 404);
    assert.strictEqual((await admin.post(`events/${crypto.randomUUID()}/retry`, {})).status, 404);
    assert.strictEqual((await admin.post('events/..%2F..%2Fx/retry', {})).status, 404);
    assert.strictEqual((await prisma.webhookEvent.findUnique({ where: { id: other.id } })).status, 'dead', 'the other shop\'s event was not touched');
    assert.strictEqual(await prisma.auditLog.count({ where: { shop, action: 'event_retried' } }), 0);
  });

  test('retry needs the CSRF token and an open console', async () => {
    const e = await rawEvent({ status: 'failed', attempts: 1, lastError: 'x' });
    assert.strictEqual((await admin.req('POST', `events/${e.id}/retry`, {}, { 'X-CSRF-Token': '' })).status, 403);
    const forced = await adminBrowser(site.url, shop, { mustChange: true });
    assert.strictEqual((await forced.post(`events/${e.id}/retry`, {})).status, 403);
    assert.strictEqual((await prisma.webhookEvent.findUnique({ where: { id: e.id } })).status, 'failed');
  });

  // ===================== page =====================

  const sample = () => ({
    orders: [{ orderRef: '1019', customerId: '1015', processedAt: '2026-10-08T12:00:00.000Z', eligible: '1349.91', pointsEarned: 1349, pointsReversed: 675, state: 'partly reversed', lot: { status: 'pending', remaining: 674, activatesAt: '2026-11-07T00:00:00.000Z' }, rewardUsed: true }],
    events: [{ id: 'e1', topic: 'refunds/create', status: 'failed', attempts: 2, lastError: '<script>alert(1)</script>', nextRetryAt: '2026-10-12T10:00:00.000Z', receivedAt: '2026-10-12T09:00:00.000Z', orderRef: '1019', refundRef: '88', purged: false, canRetry: true }],
    attention: [{ id: 'e1', topic: 'refunds/create', status: 'failed', attempts: 2, lastError: '<img src=x onerror=alert(2)>', nextRetryAt: '2026-10-12T10:00:00.000Z', receivedAt: '2026-10-12T09:00:00.000Z', orderRef: '1019', refundRef: '88', purged: false, canRetry: true },
      { id: 'e2', topic: 'orders/cancelled', status: 'dead', attempts: 6, lastError: 'boom', nextRetryAt: null, receivedAt: '2026-10-12T08:00:00.000Z', orderRef: '1020', refundRef: null, purged: true, canRetry: false }],
    counts: { pending: 0, processing: 0, processed: 3, failed: 1, dead: 1, skipped: 0 }, status: 'all', ordersNext: 'o2', eventsNext: null, currency: 'INR',
  });

  test('the page lists orders and events, offers Retry only where it can work, and escapes everything', () => {
    const html = String(renderOrders(sample()));
    for (const text of ['Orders &amp; webhooks', 'Events that need attention (2)', 'Retry now', 'partly reversed', 'reward used', 'payload purged', 'Not available in this version', 'Load more orders']) assert.ok(html.includes(text), `has ${text}`);
    assert.strictEqual((html.match(/data-act="retry"/g) || []).length, 2, 'one in the panel, one in the table; the purged one has none');
    assert.ok(!html.includes('<script>alert(1)') && !html.includes('<img src=x'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && html.includes('&lt;img src=x onerror=alert(2)&gt;'));
    assert.ok(!/\sstyle=/.test(html));
  });

  test('with nothing failing there is no attention panel; empty tables say so', () => {
    const html = String(renderOrders({ orders: [], events: [], attention: [], counts: {}, status: 'failed', ordersNext: null, eventsNext: null, currency: 'INR' }));
    assert.ok(!html.includes('need attention'));
    assert.match(html, /No orders have earned points yet/);
    assert.match(html, /No events/);
    assert.match(html, /aria-pressed="true">failed/);
  });
});
