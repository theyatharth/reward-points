// test/loyalty/tax-pipeline.test.js
//
// Included-tax stripping through the real pipeline (storeWebhook ->
// processPendingWebhooks -> writeEarning), with taxHandling "inclusive" (the M5
// seed profile).
//
// PAYLOAD PROVENANCE: derived from the real captured orders/paid body (test order
// #1015: one line, USD, taxes_included true, tax_lines []), keeping only the fields
// the adapter reads. The line's `tax_lines` and the price are EDITED BY HAND, so this
// is NOT a real taxed payload. The single-tax-line shape it uses ({ title, price,
// rate }) is now VERIFIED by the real taxed capture #1018, which
// real-fixtures.test.js feeds through the same pipeline. What this file adds is the
// failure case: a tax line with neither price nor amount (hand-made) must fail the
// event visibly. Multiple tax lines on one line item remain UNVERIFIED.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { setFixedTime, restoreClock } from '../../web/loyalty/adapters/clock.js';
import { uniqueId, uniqueKey } from '../helpers/ids.js';

describe('Included-tax stripping through the webhook pipeline', () => {
  let shop = '';
  let customerId = '';

  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });

  beforeEach(async () => {
    shop = `taxes-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    customerId = uniqueKey('cust');
    setFixedTime('2026-10-08T12:00:00Z');
    ledgerService.setGatewayFactory(() => new FakeShopifyGateway(shop));
    await prisma.loyaltyConfig.create({
      data: { shop, pointsPerUnit: 1, taxHandling: 'inclusive', ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
    });
  });

  after(async () => {
    restoreClock();
    await prisma.$disconnect();
  });

  // Derived from the real captured order #1015; price and tax_lines edited by hand.
  const taxedOrder = (taxLines) => ({
    id: uniqueId(),
    name: '#1015',
    order_number: 1015,
    processed_at: '2026-10-08T03:56:52-04:00',
    taxes_included: true,
    customer: { id: customerId },
    shipping_lines: [{ price: '0.00', discounted_price: '0.00' }],
    line_items: [{
      id: 17009161568453, product_id: 9027684925637, quantity: 1, gift_card: false,
      price: '21.00',            // EDITED BY HAND (the capture had 600.00 and no tax)
      tax_lines: taxLines,       // EDITED BY HAND (the single-entry shape is verified by capture #1018)
      discount_allocations: [],
    }],
  });
  const run = async (payload) => {
    const event = await storeWebhook({ shop, topic: 'ORDERS_PAID', payload, shopifyWebhookId: crypto.randomUUID() });
    await processPendingWebhooks({ shop });
    return prisma.webhookEvent.findUnique({ where: { id: event.id } });
  };
  const account = () => prisma.loyaltyAccount.findUnique({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: customerId } },
  });

  test('"price"-shaped tax line: included tax is stripped (21.00 incl. 1.00 earns 20)', async () => {
    const ev = await run(taxedOrder([{ title: 'GST', price: '1.00', rate: 0.05 }]));
    assert.strictEqual(ev.status, 'processed', ev.lastError ?? '');
    const a = await account();
    assert.strictEqual(a.pending, 20);
    const order = await prisma.loyaltyOrder.findFirst({ where: { shop } });
    assert.strictEqual(order.eligibleAmountPaise, 2000);
  });

  test('a tax line with neither price nor amount FAILS the event visibly and earns nothing', async () => {
    const ev = await run(taxedOrder([{ title: 'GST', rate: 0.05 }]));
    assert.strictEqual(ev.status, 'failed');
    assert.match(ev.lastError, /neither a parsable "price" nor "amount"/);
    // The payload went through Postgres JSONB, which reorders keys (shorter names first),
    // so assert the key names without depending on their order.
    const found = ev.lastError.match(/keys found: (.*)\)$/)[1].split(', ').sort();
    assert.deepStrictEqual(found, ['rate', 'title']);
    assert.ok(!ev.lastError.includes('GST'), 'the error lists key names, not values');
    assert.strictEqual(await account(), null, 'no account and no points: nothing was earned on the gross price');
    assert.strictEqual(await prisma.ledgerEntry.count({ where: { dedupeKey: { startsWith: 'earn:' }, account: { shop } } }), 0);
  });
});
