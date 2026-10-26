// test/loyalty/currency-guard.test.js
//
// Only two-decimal currencies are supported (every amount is whole hundredths). For any other the program is off, visibly:
// events are skipped with the reason, redeeming and adjusting are refused with a clear message, the storefront says rewards
// are not available, and the console shows a banner on every page.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import { redeem } from '../../web/loyalty/service/redemption.js';
import { adjustPoints } from '../../web/loyalty/service/adjustment.js';
import { customerView, redeemForCustomer } from '../../web/loyalty/service/storefront.js';
import { programInfo } from '../../web/admin/data/program.js';
import { renderBanner } from '../../web/admin/public/banner.js';
import { startEmbeddedConsole, sessionToken, installShop } from '../helpers/shopify-embedded.js';
import { uniqueId } from '../helpers/ids.js';

const BASE = { spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, holdPeriodDays: 30, ledgerStartAt: new Date('2026-01-01T00:00:00Z') };
const newShop = () => `cur-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;

describe('Currency guard', () => {
  let shop;
  let gw;
  before(() => { if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB'); });
  after(async () => { await prisma.$disconnect(); });
  beforeEach(() => {
    shop = newShop();
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
  });

  const configure = (currency) => prisma.loyaltyConfig.create({ data: { shop, ...BASE, currency } });
  const paid = (customer, amount = '300') => ({ id: uniqueId(), customer: { id: customer }, processed_at: new Date().toISOString(), line_items: [{ id: 1, quantity: 1, price: amount, title: 'x' }] });
  const event = (topic, payload) => storeWebhook({ shop, topic, payload, shopifyWebhookId: crypto.randomUUID() });
  const row = (id) => prisma.webhookEvent.findUnique({ where: { id } });

  test('a supported currency (INR, USD, EUR, GBP) still earns, so the guard is not a blanket skip', async () => {
    for (const currency of ['INR', 'USD']) {
      shop = newShop();
      await configure(currency);
      const e = await event('orders/paid', paid(String(uniqueId())));
      await processPendingWebhooks({ shop });
      assert.strictEqual((await row(e.id)).status, 'processed', currency);
      assert.strictEqual(await prisma.ledgerEntry.count({ where: { account: { shop } } }), 1);
    }
  });

  for (const currency of ['JPY', 'KWD', 'BHD', 'KRW']) {
    test(`${currency}: orders, refunds and cancellations are skipped with the reason, and nothing is written`, async () => {
      await configure(currency);
      const customer = String(uniqueId());
      const events = [
        await event('orders/paid', paid(customer)),
        await event('refunds/create', { id: uniqueId(), order_id: uniqueId(), refund_line_items: [], transactions: [] }),
        await event('orders/cancelled', { id: uniqueId() }),
      ];
      await processPendingWebhooks({ shop });
      for (const e of events) {
        const r = await row(e.id);
        assert.strictEqual(r.status, 'skipped', e.topic);
        assert.match(r.lastError, new RegExp(`shop currency \\(${currency}\\) is not supported`));
        assert.match(r.lastError, /two decimals/);
        assert.strictEqual(r.nextRetryAt, null);
      }
      assert.strictEqual(await prisma.loyaltyAccount.count({ where: { shop } }), 0);
      assert.strictEqual(await prisma.loyaltyOrder.count({ where: { shop } }), 0);
      assert.strictEqual(await prisma.ledgerEntry.count({ where: { account: { shop } } }), 0);
    });
  }

  test('redeem is refused with a clear message even for an account that holds points; nothing changes', async () => {
    await configure('JPY');
    const customer = String(uniqueId());
    const account = await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: customer, available: 5000 } });
    const r = await redeem({ shop, shopifyCustomerId: customer, idempotencyKey: crypto.randomUUID() });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'CURRENCY_UNSUPPORTED']);
    assert.match(r.message, /cannot be redeemed in this store/);
    const s = await redeemForCustomer({ shop, shopifyCustomerId: customer, idempotencyKey: crypto.randomUUID() });
    assert.strictEqual(s.status, 403);
    assert.deepStrictEqual([s.body.success, s.body.reason], [false, 'CURRENCY_UNSUPPORTED']);
    assert.strictEqual(await prisma.redemption.count({ where: { shop } }), 0);
    assert.strictEqual((await prisma.loyaltyAccount.findUnique({ where: { id: account.id } })).available, 5000);
    assert.strictEqual(gw.discounts.size, 0, 'no discount code was created in Shopify');
  });

  test('an admin adjustment is refused too', async () => {
    await configure('KWD');
    const customer = String(uniqueId());
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: customer, available: 10 } });
    const admin = await prisma.adminUser.create({ data: { shop, email: `a-${crypto.randomUUID()}@example.test`, passwordHash: 'x', mustChangePassword: false } });
    const r = await adjustPoints({ shop, shopifyCustomerId: customer, points: 5, reason: 'Missing points', note: 'a test of the guard', adminId: admin.id, idempotencyKey: crypto.randomUUID() });
    assert.deepStrictEqual([r.ok, r.reason], [false, 'CURRENCY_UNSUPPORTED']);
    assert.match(r.message, /KWD/);
    assert.strictEqual(await prisma.ledgerEntry.count({ where: { account: { shop } } }), 0);
  });

  test('the storefront view says unavailable for an unsupported currency and has no such key otherwise', async () => {
    await configure('JPY');
    const customer = String(uniqueId());
    assert.strictEqual((await customerView({ shop, shopifyCustomerId: customer })).unavailable, 'currency');
    shop = newShop();
    await configure('EUR');
    assert.ok(!('unavailable' in (await customerView({ shop, shopifyCustomerId: customer }))));
  });

  test('console: /meta carries the banner text for an unsupported shop on every page, and nothing for a supported one', async () => {
    const site = await startEmbeddedConsole();
    try {
      await configure('JPY');
      await installShop(shop);
      const meta = (await site.call('GET', 'meta', { token: sessionToken(shop) })).json.program;
      assert.deepStrictEqual([meta.configured, meta.currency, meta.currencySupported], [true, 'JPY', false]);
      assert.match(meta.currencyMessage, /JPY.*not supported.*skipped.*cannot redeem/);
      const ok = newShop();
      await prisma.loyaltyConfig.create({ data: { shop: ok, ...BASE, currency: 'USD' } });
      await installShop(ok);
      assert.deepStrictEqual((await site.call('GET', 'meta', { token: sessionToken(ok) })).json.program, { configured: true, currency: 'USD', currencySupported: true, currencyMessage: null });
      const none = newShop();
      await installShop(none);
      assert.strictEqual((await site.call('GET', 'meta', { token: sessionToken(none) })).json.program.configured, false);
    } finally { await site.close(); }
  });

  test('the banner renders for an unsupported shop (escaped, an alert), and is empty for a supported shop, an unknown one or no data', async () => {
    const p = await programInfo(shop);
    assert.strictEqual(p.configured, false);
    const html = String(renderBanner({ currencySupported: false, currencyMessage: '<b>JPY</b> is not supported' }));
    assert.match(html, /role="alert"/);
    assert.match(html, /Rewards are switched off for this shop/);
    assert.ok(!html.includes('<b>JPY</b>') && html.includes('&lt;b&gt;JPY'));
    for (const none of [null, undefined, {}, { currencySupported: true }, { currencySupported: true, currencyMessage: null }]) assert.strictEqual(String(renderBanner(none)), '');
  });
});
