// test/loyalty/real-fixtures.test.js
//
// The four REAL captured orders/paid payloads (test/fixtures/shopify/real/, test
// orders #1015 to #1018 from the dev app, USD) through the real pipeline:
//   storeWebhook (enum topic, as the Shopify library delivers it)
//     -> processPendingWebhooks -> writeEarning -> LoyaltyOrder / LoyaltyAccount
//
// Only the order id and customer.id are overridden, with uniqueId(): earn dedupe
// keys are global and ledger rows are immutable, so a captured id would collide
// with the first run on a persistent database. Everything else is exactly as
// captured. Config mirrors the M5 seed profile (scripts/seed-config.mjs):
// spend 10000 paise : 100 points, tax "inclusive", after-discount, gift cards excluded.

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
import { uniqueId } from '../helpers/ids.js';

const REAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'shopify', 'real');

describe('Real captured orders through the webhook pipeline', () => {
  let shop = '';

  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });

  beforeEach(() => {
    shop = `real-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    setFixedTime('2026-10-08T12:00:00Z');
    ledgerService.setGatewayFactory(() => new FakeShopifyGateway(shop));
  });

  after(async () => {
    restoreClock();
    await prisma.$disconnect();
  });

  const seedConfig = (overrides = {}) => prisma.loyaltyConfig.create({
    data: {
      shop,
      spendAmountPaise: 10000,
      pointsPerUnit: 100,
      taxHandling: 'inclusive',
      earnBasis: 'after_discount',
      excludeGiftCards: true,
      ledgerStartAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    },
  });

  // The real body, minus the _provenance header, with ONLY order id and customer.id replaced.
  function load(file) {
    const payload = JSON.parse(readFileSync(join(REAL, file), 'utf8'));
    delete payload._provenance;
    payload.id = uniqueId();
    payload.customer.id = uniqueId();
    return payload;
  }

  async function ingest(payload) {
    const event = await storeWebhook({ shop, topic: 'ORDERS_PAID', payload, shopifyWebhookId: crypto.randomUUID() });
    await processPendingWebhooks({ shop });
    const processed = await prisma.webhookEvent.findUnique({ where: { id: event.id } });
    const order = await prisma.loyaltyOrder.findUnique({
      where: { shop_shopifyOrderId: { shop, shopifyOrderId: String(payload.id) } },
    });
    const account = await prisma.loyaltyAccount.findUnique({
      where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: String(payload.customer.id) } },
    });
    return { event: processed, order, account };
  }

  const expectEarned = ({ event, order, account }, paise, points) => {
    assert.strictEqual(event.status, 'processed', event.lastError ?? '');
    assert.strictEqual(event.topic, 'orders/paid', 'normalised at intake');
    assert.strictEqual(order.eligibleAmountPaise, paise, 'eligibleAmountPaise');
    assert.strictEqual(order.pointsEarned, points, 'pointsEarned');
    assert.strictEqual(account.pending, points, 'pending balance');
  };

  test('#1015 plain order: 600.00, no discount, no tax -> 60000 paise, 600 points', async () => {
    await seedConfig();
    expectEarned(await ingest(load('orders-paid-1015-plain.json')), 60000, 600);
  });

  test('#1016 10% discount code: 749.95 - 74.99 -> 67496 paise, 674 points', async () => {
    await seedConfig();
    expectEarned(await ingest(load('orders-paid-1016-discount.json')), 67496, 674);
  });

  test('#1017 gift card + discount: the 10.00 gift card is excluded; the discount only touched the other line -> 67496, 674', async () => {
    await seedConfig();
    const payload = load('orders-paid-1017-giftcard-discount.json');
    assert.strictEqual(payload.line_items.filter((l) => l.gift_card === true).length, 1, 'fixture has one gift card line');
    expectEarned(await ingest(payload), 67496, 674);
  });

  test('#1018 tax included: 712.45 - 108.68 tax -> 60377 paise, 603 points (tax stripped from the real tax_lines[].price)', async () => {
    await seedConfig();
    const payload = load('orders-paid-1018-tax-included.json');
    assert.strictEqual(payload.taxes_included, true);
    assert.strictEqual(payload.line_items[0].tax_lines.length, 1);
    assert.strictEqual(payload.line_items[0].tax_lines[0].price, '108.68');
    expectEarned(await ingest(payload), 60377, 603);
  });

  // Contrast cases: the flags are what separate the numbers above from these.
  test('#1017 with excludeGiftCards OFF the gift card earns its price: 67496 + 1000 -> 68496 paise, 684 points', async () => {
    await seedConfig({ excludeGiftCards: false });
    expectEarned(await ingest(load('orders-paid-1017-giftcard-discount.json')), 68496, 684);
  });

  test('#1018 with taxHandling "exclusive" nothing is stripped: 712.45 -> 71245 paise, 712 points', async () => {
    await seedConfig({ taxHandling: 'exclusive' });
    expectEarned(await ingest(load('orders-paid-1018-tax-included.json')), 71245, 712);
  });

  test('the fixtures themselves carry no personal-data keys with real values', () => {
    for (const f of ['orders-paid-1015-plain.json', 'orders-paid-1016-discount.json', 'orders-paid-1017-giftcard-discount.json', 'orders-paid-1018-tax-included.json']) {
      const text = readFileSync(join(REAL, f), 'utf8');
      assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), `${f}: no email address`);
      const body = JSON.parse(text);
      assert.ok(typeof body._provenance?.note === 'string' && /REAL delivery/.test(body._provenance.note), `${f}: has a _provenance note`);
      assert.ok(!('_exported' in body), `${f}: _exported header replaced`);
      for (const key of ['email', 'contact_email', 'phone', 'first_name', 'last_name']) {
        for (const holder of [body, body.customer, body.billing_address, body.shipping_address]) {
          const v = holder?.[key];
          assert.ok(v === undefined || v === null || String(v).startsWith('[redacted'), `${f}: ${key} must be absent, null or redacted`);
        }
      }
    }
  });
});
