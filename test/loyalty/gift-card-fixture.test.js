// test/loyalty/gift-card-fixture.test.js
//
// The gift-card-with-discount fixture (only its order id is made unique per run) through the real pipeline:
//   storeWebhook -> processPendingWebhooks -> writeEarning -> LoyaltyOrder / LoyaltyAccount
//
//   product line   ₹499.00 with a ₹50.00 discount allocation -> 44,900 paise
//   gift-card line ₹110.00, no discount allocation            -> 11,000 paise
//
// excludeGiftCards ON (default): the gift card earns nothing -> 449 points
// excludeGiftCards OFF:          the gift card earns its price -> 559 points

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { setFixedTime, restoreClock } from '../../web/loyalty/adapters/clock.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'shopify', 'orders-paid-gift-card-with-discount.json');

describe('Gift-card fixture through the webhook pipeline', () => {
  let shop = '';

  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });

  beforeEach(() => {
    shop = `giftcard-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    setFixedTime('2026-09-24T12:00:00Z');
    ledgerService.setGatewayFactory(() => new FakeShopifyGateway(shop));
  });

  after(async () => {
    restoreClock();
    await prisma.$disconnect();
  });

  async function run(excludeGiftCards) {
    await prisma.loyaltyConfig.create({
      data: { shop, pointsPerUnit: 1, excludeGiftCards, ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
    });
    // The real fixture. Only the order id is replaced: earn dedupe keys
    // ("earn:<orderId>") are unique across ALL shops and ledger rows can never
    // be deleted, so a fixed id would collide between the two flag cases and
    // with earlier runs on a persistent test database. Lines, prices, discount
    // allocations and the gift-card marker are exactly as captured.
    const payload = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    payload.id = Number(`${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`);
    const event = await storeWebhook({ shop, topic: 'orders/paid', payload, shopifyWebhookId: crypto.randomUUID() });
    await processPendingWebhooks({ shop });

    const processed = await prisma.webhookEvent.findUnique({ where: { id: event.id } });
    const order = await prisma.loyaltyOrder.findUnique({
      where: { shop_shopifyOrderId: { shop, shopifyOrderId: String(payload.id) } },
    });
    const account = await prisma.loyaltyAccount.findUnique({
      where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: String(payload.customer.id) } },
    });
    return { processed, order, account };
  }

  test('excludeGiftCards ON (default): earns 449 points; the gift card earns nothing', async () => {
    const { processed, order, account } = await run(true);
    assert.strictEqual(processed.status, 'processed', processed.lastError ?? '');
    assert.strictEqual(order.eligibleAmountPaise, 44900);
    assert.strictEqual(order.pointsEarned, 449);
    assert.strictEqual(account.pending, 449);
  });

  test('excludeGiftCards OFF: earns 559 points; the discount touches only the product line', async () => {
    const { processed, order, account } = await run(false);
    assert.strictEqual(processed.status, 'processed', processed.lastError ?? '');
    assert.strictEqual(order.eligibleAmountPaise, 55900);
    assert.strictEqual(order.pointsEarned, 559);
    assert.strictEqual(account.pending, 559);
  });

  test('a config row created without the flag defaults to gift cards excluded (449)', async () => {
    await prisma.loyaltyConfig.create({
      data: { shop, pointsPerUnit: 1, ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
    });
    const config = await prisma.loyaltyConfig.findUnique({ where: { shop } });
    assert.strictEqual(config.excludeGiftCards, true);
    assert.deepStrictEqual(config.excludedCollectionIds, []);
    assert.strictEqual(config.spendAmountPaise, 100);
    assert.strictEqual(config.earnBasis, 'after_discount');
    assert.strictEqual(config.restoreRewardOnFullRefund, true);
    assert.strictEqual(config.returnPointsOnCodeExpiry, false);
  });
});
