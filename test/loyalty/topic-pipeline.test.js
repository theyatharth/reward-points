// test/loyalty/topic-pipeline.test.js
//
// Topic forms through the real pipeline. Shopify's library hands handlers the
// enum form ("ORDERS_PAID"). New events are normalised to the slash form at
// intake; rows stored before that (one exists in reward_points_dev) still hold
// the enum form and must still be processed.

import { test, describe, before, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { setFixedTime, restoreClock } from '../../web/loyalty/adapters/clock.js';
import { uniqueId, uniqueKey } from '../helpers/ids.js';

describe('Topic forms through the webhook pipeline', () => {
  let shop = '';
  let customerId = '';

  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });

  beforeEach(async () => {
    shop = `topics-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    customerId = uniqueKey('cust');
    setFixedTime('2026-09-20T12:00:00Z');
    ledgerService.setGatewayFactory(() => new FakeShopifyGateway(shop));
    await prisma.loyaltyConfig.create({
      data: { shop, pointsPerUnit: 1, ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
    });
  });

  after(async () => {
    restoreClock();
    await prisma.$disconnect();
  });

  const orderPayload = (orderId, amount = '100.00') => ({
    id: orderId,
    processed_at: '2026-09-20T10:00:00Z',
    subtotal_price: amount,
    taxes_included: false,
    customer: { id: customerId },
    line_items: [{ price: amount, quantity: 1, tax_lines: [], discount_allocations: [] }],
    shipping_lines: [],
  });
  const account = () => prisma.loyaltyAccount.findUnique({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: customerId } },
  });
  const event = (id) => prisma.webhookEvent.findUnique({ where: { id } });

  test('storeWebhook with the ENUM form stores the slash form, and the event is processed', async () => {
    const stored = await storeWebhook({
      shop, topic: 'ORDERS_PAID', payload: orderPayload(uniqueId()), shopifyWebhookId: crypto.randomUUID(),
    });
    assert.strictEqual(stored.topic, 'orders/paid', 'normalised at intake');

    await processPendingWebhooks({ shop });
    assert.strictEqual((await event(stored.id)).status, 'processed');
    assert.strictEqual((await account()).pending, 100);
  });

  test('a legacy row stored with the enum form ("ORDERS_PAID") is still processed', async () => {
    const legacy = await prisma.webhookEvent.create({
      data: { shop, topic: 'ORDERS_PAID', payload: orderPayload(uniqueId()), shopifyWebhookId: crypto.randomUUID(), status: 'pending' },
    });
    await processPendingWebhooks({ shop });

    const after = await event(legacy.id);
    assert.strictEqual(after.status, 'processed', after.lastError ?? '');
    assert.strictEqual(after.topic, 'ORDERS_PAID', 'the stored row is not rewritten');
    assert.strictEqual((await account()).pending, 100);
  });

  test('legacy enum rows for a refund and a cancellation are processed too', async () => {
    const orderId = uniqueId();
    await storeWebhook({ shop, topic: 'orders/paid', payload: orderPayload(orderId), shopifyWebhookId: crypto.randomUUID() });
    await processPendingWebhooks({ shop });
    assert.strictEqual((await account()).pending, 100);

    const refund = await prisma.webhookEvent.create({
      data: {
        shop, topic: 'REFUNDS_CREATE', shopifyWebhookId: crypto.randomUUID(), status: 'pending',
        payload: { id: uniqueId(), order_id: orderId, refund_line_items: [{ subtotalSet: { shopMoney: { amount: '40.00' } } }] },
      },
    });
    await processPendingWebhooks({ shop });
    assert.strictEqual((await event(refund.id)).status, 'processed');
    assert.strictEqual((await account()).pending, 60);

    const cancel = await prisma.webhookEvent.create({
      data: { shop, topic: 'ORDERS_CANCELLED', payload: { id: orderId }, shopifyWebhookId: crypto.randomUUID(), status: 'pending' },
    });
    await processPendingWebhooks({ shop });
    assert.strictEqual((await event(cancel.id)).status, 'processed');
    assert.strictEqual((await account()).pending, 0);
  });

  test('an unmapped topic is stored exactly as given, logged, and skipped as unhandled', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const stored = await storeWebhook({
        shop, topic: 'products/update', payload: { id: uniqueId() }, shopifyWebhookId: crypto.randomUUID(),
      });
      assert.strictEqual(stored.topic, 'products/update');
      assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes('products/update')), 'a warning names the topic');

      await processPendingWebhooks({ shop });
      const after = await event(stored.id);
      assert.strictEqual(after.status, 'skipped');
      assert.match(after.lastError, /Unhandled topic: products\/update/);
    } finally {
      warn.mock.restore();
    }
  });

  test('a known topic does not log a warning', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      await storeWebhook({ shop, topic: 'ORDERS_PAID', payload: orderPayload(uniqueId()), shopifyWebhookId: crypto.randomUUID() });
      assert.strictEqual(warn.mock.calls.length, 0);
    } finally {
      warn.mock.restore();
    }
  });
});
