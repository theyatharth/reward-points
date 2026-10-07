// test/loyalty/ledger.test.js
//
// T2.4: Integration tests for the Ledger Service and Webhook Queue.
// Tests the full flow: storeWebhook -> processPendingWebhooks -> Ledger DB state.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import { uniqueId } from '../helpers/ids.js';

const TEST_SHOP = `test-ledger-${Date.now()}.myshopify.com`;

describe('Ledger Service & Webhooks', () => {
  before(async () => {

    // Insert a test config
    await prisma.loyaltyConfig.create({
      data: {
        shop: TEST_SHOP,
        earnMode: 'per_currency_unit',
        pointsPerUnit: 1, // 1 point per 100 paise
        taxHandling: 'exclusive',
        pointsRounding: 'floor',
        holdPeriodDays: 30,
        ledgerStartAt: new Date('2026-01-01T00:00:00Z'), // Past date
      },
    });
  });

  after(async () => {
    // We cannot delete LedgerEntries because of the immutability trigger.
    // The test uses a unique shop name per run, so data isolation is preserved.
    await prisma.$disconnect();
  });

  const testRunId = Date.now();
  const shopifyCustomerId = `cust_${testRunId}`;
  const orderId = `order_${testRunId}`;

  test('1. Earn (orders/paid)', async () => {
    const payload = {
      id: orderId,
      processed_at: '2026-09-20T10:00:00Z',
      subtotal_price: '100.00',
      taxes_included: false,
      customer: { id: shopifyCustomerId },
      line_items: [
        { price: '100.00', quantity: 1, tax_lines: [], discount_allocations: [] }
      ],
      shipping_lines: []
    };

    const webhook = await storeWebhook({
      shop: TEST_SHOP,
      topic: 'orders/paid',
      payload,
      shopifyWebhookId: `wh_earn_${Date.now()}`,
    });

    assert.equal(webhook.status, 'pending');

    const processed = await processPendingWebhooks({ shop: TEST_SHOP });
    assert.equal(processed, 1);

    const updatedWebhook = await prisma.webhookEvent.findUnique({ where: { id: webhook.id } });
    assert.equal(updatedWebhook.status, 'processed');

    // Verify DB state
    const order = await prisma.loyaltyOrder.findUnique({
      where: { shop_shopifyOrderId: { shop: TEST_SHOP, shopifyOrderId: orderId } },
      include: { lot: true },
    });
    assert.ok(order);
    assert.equal(order.pointsEarned, 100);
    assert.equal(order.eligibleAmountPaise, 10000);
    assert.equal(order.lot.originalPoints, 100);
    assert.equal(order.lot.remaining, 100);
    assert.equal(order.lot.status, 'pending');

    const account = await prisma.loyaltyAccount.findUnique({
      where: { shop_shopifyCustomerId: { shop: TEST_SHOP, shopifyCustomerId } },
    });
    assert.equal(account.pending, 100);
    assert.equal(account.available, 0);

    const entries = await prisma.ledgerEntry.findMany({ where: { accountId: account.id } });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, 'earn');
    assert.equal(entries[0].points, 100);
  });

  test('2. Refund (refunds/create)', async () => {
    const refundPayload = {
      id: `refund_${testRunId}`,
      order_id: orderId,
      refund_line_items: [
        { subtotalSet: { shopMoney: { amount: '50.00' } } }
      ],
      order_adjustments: []
    };

    const webhook = await storeWebhook({
      shop: TEST_SHOP,
      topic: 'refunds/create',
      payload: refundPayload,
      shopifyWebhookId: `wh_refund_${Date.now()}`,
    });

    await processPendingWebhooks({ shop: TEST_SHOP });

    const updatedWebhook = await prisma.webhookEvent.findUnique({ where: { id: webhook.id } });
    assert.equal(updatedWebhook.status, 'processed');

    const order = await prisma.loyaltyOrder.findUnique({
      where: { shop_shopifyOrderId: { shop: TEST_SHOP, shopifyOrderId: orderId } },
      include: { lot: true, refunds: true },
    });
    // Reversed: round(100 * 50.00 / 100.00) = 50
    assert.equal(order.lot.remaining, 50);
    assert.equal(order.lot.status, 'pending'); // Still pending

    const account = await prisma.loyaltyAccount.findUnique({
      where: { shop_shopifyCustomerId: { shop: TEST_SHOP, shopifyCustomerId } },
    });
    // Removed from pending because lot was pending
    assert.equal(account.pending, 50);
    assert.equal(account.available, 0);

    const entries = await prisma.ledgerEntry.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'asc' } });
    assert.equal(entries.length, 2);
    assert.equal(entries[1].type, 'refund');
    assert.equal(entries[1].points, -50);
  });

  test('3. Cancel (orders/cancelled)', async () => {
    const cancelPayload = {
      id: orderId,
      customer: { id: shopifyCustomerId }
    };

    const webhook = await storeWebhook({
      shop: TEST_SHOP,
      topic: 'orders/cancelled',
      payload: cancelPayload,
      shopifyWebhookId: `wh_cancel_${Date.now()}`,
    });

    await processPendingWebhooks({ shop: TEST_SHOP });

    const updatedWebhook = await prisma.webhookEvent.findUnique({ where: { id: webhook.id } });
    assert.equal(updatedWebhook.status, 'processed');

    const order = await prisma.loyaltyOrder.findUnique({
      where: { shop_shopifyOrderId: { shop: TEST_SHOP, shopifyOrderId: orderId } },
      include: { lot: true },
    });
    // Remaining 50 should be cancelled
    assert.equal(order.lot.remaining, 0);
    assert.equal(order.lot.status, 'cancelled');

    const account = await prisma.loyaltyAccount.findUnique({
      where: { shop_shopifyCustomerId: { shop: TEST_SHOP, shopifyCustomerId } },
    });
    assert.equal(account.pending, 0);
    assert.equal(account.available, 0);

    const entries = await prisma.ledgerEntry.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'asc' } });
    assert.equal(entries.length, 3);
    assert.equal(entries[2].type, 'cancel');
    assert.equal(entries[2].points, -50);
  });

  test('4. Pre-ledger ignore', async () => {
    const payload = {
      id: String(uniqueId()),
      processed_at: '2025-01-01T10:00:00Z', // Before ledgerStartAt (2026-01-01)
      subtotal_price: '100.00',
      taxes_included: false,
      customer: { id: shopifyCustomerId },
      line_items: [
        { price: '100.00', quantity: 1, tax_lines: [], discount_allocations: [] }
      ],
      shipping_lines: []
    };

    const webhook = await storeWebhook({
      shop: TEST_SHOP,
      topic: 'orders/paid',
      payload,
      shopifyWebhookId: `wh_pre_ledger_${Date.now()}`,
    });

    await processPendingWebhooks({ shop: TEST_SHOP });

    const updatedWebhook = await prisma.webhookEvent.findUnique({ where: { id: webhook.id } });
    // Should be skipped due to date
    assert.equal(updatedWebhook.status, 'skipped');
    assert.ok(updatedWebhook.lastError.includes('predates'));
  });
});
