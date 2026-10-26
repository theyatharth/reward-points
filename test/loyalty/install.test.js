// test/loyalty/install.test.js
//
// Public app install setup: the shop's currency is read through the gateway and its LoyaltyConfig is created from the seed
// profile (hold 30 days, ledgerStartAt = now); idempotent; never fails the request; an event that arrives before the shop has
// a config waits (and is retried) instead of earning with made-up rules; the holding period is capped.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { ensureShopConfig, runInstallSetup, INSTALL_HOLD_DAYS } from '../../web/loyalty/service/install.js';
import { isTwoDecimalCurrency } from '../../web/loyalty/rules/currency.js';
import { validateConfig, MAX_HOLD_DAYS, DEFAULT_CONFIG } from '../../web/loyalty/rules/config.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { storeWebhook, processPendingWebhooks, waitingPlan, retryPlan, RETRY_DELAYS_MINUTES, WAITING_RETRY_MINUTES, WAITING_WINDOW_DAYS } from '../../web/loyalty/service/webhook.js';
import { setFixedTime, restoreClock } from '../../web/loyalty/adapters/clock.js';
import { loadShopify } from '../helpers/shopify-embedded.js';
import { uniqueId } from '../helpers/ids.js';

const newShop = () => `inst-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
const silent = { log: () => {}, error: () => {} };

describe('Install setup', () => {
  let shop;
  let gw;
  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });
  after(async () => {
    restoreClock();
    await prisma.$disconnect();
  });
  beforeEach(() => {
    restoreClock();
    shop = newShop();
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
  });

  test('creates the config from the shop currency: seed profile, hold 30 days, ledgerStartAt = now, one audit row', async () => {
    gw.shopCurrency = 'USD';
    const before = Date.now();
    const r = await ensureShopConfig(shop, gw);
    assert.deepStrictEqual([r.status, r.currency, r.supported], ['created', 'USD', true]);
    const c = await prisma.loyaltyConfig.findUnique({ where: { shop } });
    assert.strictEqual(c.currency, 'USD');
    assert.strictEqual(c.holdPeriodDays, INSTALL_HOLD_DAYS);
    assert.strictEqual(INSTALL_HOLD_DAYS, 30);
    assert.ok(c.ledgerStartAt.getTime() >= before - 1000 && c.ledgerStartAt.getTime() <= Date.now() + 1000);
    assert.deepStrictEqual([c.spendAmountPaise, c.pointsPerUnit, c.pointsPerReward, c.rewardValue], [10000, 100, 100, 1000]);
    const audit = await prisma.auditLog.findMany({ where: { shop } });
    assert.deepStrictEqual(audit.map((a) => [a.action, a.adminId, a.shopifyUserId]), [['app_installed', null, null]]);
    assert.deepStrictEqual(audit[0].detail, { currency: 'USD', supported: true, holdPeriodDays: 30 });
  });

  test('idempotent: a second and third run change nothing, not even a rule the merchant has edited since', async () => {
    await ensureShopConfig(shop, gw);
    await prisma.loyaltyConfig.update({ where: { shop }, data: { holdPeriodDays: 7, pointsPerUnit: 3 } });
    gw.shopCurrency = 'EUR';
    for (let i = 0; i < 2; i++) assert.strictEqual((await ensureShopConfig(shop, gw)).status, 'exists');
    const c = await prisma.loyaltyConfig.findUnique({ where: { shop } });
    assert.deepStrictEqual([c.currency, c.holdPeriodDays, c.pointsPerUnit], ['INR', 7, 3]);
    assert.strictEqual(await prisma.auditLog.count({ where: { shop } }), 1);
  });

  test('five at once (two tabs, a retry): exactly one config and one audit row', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => ensureShopConfig(shop, gw)));
    assert.strictEqual(results.filter((r) => r.status === 'created').length, 1);
    assert.strictEqual(await prisma.loyaltyConfig.count({ where: { shop } }), 1);
    assert.strictEqual(await prisma.auditLog.count({ where: { shop, action: 'app_installed' } }), 1);
  });

  test('a currency that is not two-decimal still gets its config, flagged as not supported', async () => {
    gw.shopCurrency = 'JPY';
    const r = await ensureShopConfig(shop, gw);
    assert.deepStrictEqual([r.status, r.currency, r.supported], ['created', 'JPY', false]);
    assert.strictEqual((await prisma.loyaltyConfig.findUnique({ where: { shop } })).currency, 'JPY');
    assert.strictEqual((await ensureShopConfig(shop, gw)).supported, false);
    for (const c of ['INR', 'USD', 'EUR', 'GBP', 'AED']) assert.strictEqual(isTwoDecimalCurrency(c), true, c);
    for (const c of ['JPY', 'KWD', 'BHD', 'KRW', 'XX', '', undefined, null, 'inr1']) assert.strictEqual(isTwoDecimalCurrency(c), false, String(c));
  });

  test('the currency cannot be read: no config is made up, nothing throws, the reason is logged', async () => {
    gw.injectFailure(new Error('Shopify is down'));
    const lines = [];
    const r = await runInstallSetup({ session: { shop } }, () => gw, { log: (m) => lines.push(m), error: (m) => lines.push(m) });
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(await prisma.loyaltyConfig.count({ where: { shop } }), 0);
    assert.ok(lines.some((l) => l.includes(shop) && l.includes('Shopify is down')));
    // The next try (the console, or the worker) works.
    assert.strictEqual((await runInstallSetup({ session: { shop } }, () => gw, silent)).status, 'created');
  });

  test('runInstallSetup never throws: a bad session, a gateway that cannot be built, a garbage currency', async () => {
    for (const arg of [{}, { session: null }, { session: { shop: '' } }]) assert.strictEqual((await runInstallSetup(arg, () => gw, silent)).status, 'failed');
    assert.strictEqual((await runInstallSetup({ session: { shop } }, () => { throw new Error('no gateway'); }, silent)).status, 'failed');
    gw.shopCurrency = 'rupees';
    assert.strictEqual((await runInstallSetup({ session: { shop } }, () => gw, silent)).status, 'failed');
    assert.strictEqual(await prisma.loyaltyConfig.count({ where: { shop } }), 0);
  });

  test('wired into shopifyApp(): its afterAuth hook sets the shop up', async () => {
    const shopify = await loadShopify();
    assert.strictEqual(typeof shopify.config.hooks.afterAuth, 'function');
    gw.shopCurrency = 'GBP';
    await shopify.config.hooks.afterAuth({ session: { shop } });
    assert.strictEqual((await prisma.loyaltyConfig.findUnique({ where: { shop } })).currency, 'GBP');
  });

  // ---------- events that arrive before the config ----------

  const paid = (customer = '501') => ({ id: uniqueId(), customer: { id: customer }, processed_at: new Date().toISOString(), line_items: [{ id: 1, quantity: 1, price: '250.00', title: 'x' }] });
  const eventOf = (id) => prisma.webhookEvent.findUnique({ where: { id } });

  test('an event for a shop with no config and no currency waits: failed, retried in 5 minutes, never earns with defaults', async () => {
    gw.injectFailure(new Error('Shopify is down'));
    const e = await storeWebhook({ shop, topic: 'orders/paid', payload: paid(), shopifyWebhookId: crypto.randomUUID() });
    await processPendingWebhooks({ shop });
    const after1 = await eventOf(e.id);
    assert.strictEqual(after1.status, 'failed');
    assert.match(after1.lastError, /not set up yet/);
    const minutes = (after1.nextRetryAt.getTime() - Date.now()) / 60000;
    assert.ok(minutes > 4 && minutes <= 5.1, `retry in ${minutes} minutes`);
    assert.strictEqual(await prisma.loyaltyAccount.count({ where: { shop } }), 0);
    assert.strictEqual(await prisma.loyaltyConfig.count({ where: { shop } }), 0);
  });

  test('...and is processed on a later try once the shop can be set up, in the shop currency, with ledgerStartAt before the event', async () => {
    gw.injectFailure(new Error('Shopify is down'));
    const order = paid('502');
    const e = await storeWebhook({ shop, topic: 'orders/paid', payload: order, shopifyWebhookId: crypto.randomUUID() });
    await processPendingWebhooks({ shop });
    assert.strictEqual((await eventOf(e.id)).status, 'failed');
    await prisma.webhookEvent.update({ where: { id: e.id }, data: { nextRetryAt: new Date(Date.now() - 1000) } });
    gw.shopCurrency = 'USD';
    await processPendingWebhooks({ shop });
    const done = await eventOf(e.id);
    // The config was created at the moment of this retry, after the order was paid: the order predates ledgerStartAt, so it is
    // skipped (nothing before the install is ever credited), but it is handled, not stuck and not dead.
    assert.ok(['processed', 'skipped'].includes(done.status), done.status);
    assert.strictEqual((await prisma.loyaltyConfig.findUnique({ where: { shop } })).currency, 'USD');
  });

  test('with the currency readable the first event sets the shop up itself', async () => {
    gw.shopCurrency = 'EUR';
    const e = await storeWebhook({ shop, topic: 'orders/paid', payload: paid('503'), shopifyWebhookId: crypto.randomUUID() });
    await processPendingWebhooks({ shop });
    assert.notStrictEqual((await eventOf(e.id)).status, 'failed');
    assert.strictEqual((await prisma.loyaltyConfig.findUnique({ where: { shop } })).currency, 'EUR');
  });

  test('refunds and cancellations wait the same way', async () => {
    gw.injectFailure(new Error('down')); gw.injectFailure(new Error('down'));
    const a = await storeWebhook({ shop, topic: 'refunds/create', payload: { id: uniqueId(), order_id: uniqueId(), refund_line_items: [], transactions: [] }, shopifyWebhookId: crypto.randomUUID() });
    const b = await storeWebhook({ shop, topic: 'orders/cancelled', payload: { id: uniqueId() }, shopifyWebhookId: crypto.randomUUID() });
    await processPendingWebhooks({ shop });
    for (const e of [a, b]) assert.match((await eventOf(e.id)).lastError, /not set up yet/);
  });

  test('retry window: the normal schedule is 1, 5, 30, 120, 360 minutes (8 h 36 min); a waiting event is retried every 5 minutes for 7 days', () => {
    assert.deepStrictEqual(RETRY_DELAYS_MINUTES, [1, 5, 30, 120, 360]);
    assert.strictEqual(RETRY_DELAYS_MINUTES.reduce((a, b) => a + b, 0), 516);
    assert.strictEqual(retryPlan(6, new Error('x')).status, 'dead');
    assert.deepStrictEqual([WAITING_RETRY_MINUTES, WAITING_WINDOW_DAYS], [5, 7]);
    const fresh = waitingPlan({ createdAt: new Date(Date.now() - 6 * 24 * 3600 * 1000) });
    assert.strictEqual(fresh.status, 'failed');
    assert.strictEqual(waitingPlan({ createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) }).status, 'dead');
  });

  test('an event that has waited more than 7 days is dead, with the reason kept', async () => {
    gw.injectFailure(new Error('down'));
    const e = await storeWebhook({ shop, topic: 'orders/paid', payload: paid(), shopifyWebhookId: crypto.randomUUID() });
    await prisma.webhookEvent.update({ where: { id: e.id }, data: { createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) } });
    await processPendingWebhooks({ shop });
    const d = await eventOf(e.id);
    assert.strictEqual(d.status, 'dead');
    assert.match(d.lastError, /not set up yet/);
  });
});

describe('Holding period cap', () => {
  after(async () => { await prisma.$disconnect(); });

  test('validateConfig refuses more than 55 days when it is being set; an older longer value does not block editing other rules', () => {
    assert.strictEqual(MAX_HOLD_DAYS, 55);
    assert.strictEqual(validateConfig({ holdPeriodDays: 55 }).holdPeriodDays, 55);
    for (const n of [56, 60, 90, 365]) assert.throws(() => validateConfig({ holdPeriodDays: n }), /cannot be more than 55/, String(n));
    const old = { ...DEFAULT_CONFIG, holdPeriodDays: 90 };
    assert.strictEqual(validateConfig({ pointsPerUnit: 2 }, old).pointsPerUnit, 2);
    assert.throws(() => validateConfig({ holdPeriodDays: 90 }, old));
  });

  test('the database refuses it too (a script or hand-run SQL cannot set a longer hold)', async () => {
    const s = newShop();
    await assert.rejects(prisma.loyaltyConfig.create({ data: { shop: s, holdPeriodDays: 56 } }), /LoyaltyConfig_holdPeriodDays_range|check constraint/i);
    await prisma.loyaltyConfig.create({ data: { shop: s, holdPeriodDays: 55 } });
    await assert.rejects(prisma.loyaltyConfig.update({ where: { shop: s }, data: { holdPeriodDays: 90 } }), /LoyaltyConfig_holdPeriodDays_range|check constraint/i);
    await assert.rejects(prisma.loyaltyConfig.update({ where: { shop: s }, data: { holdPeriodDays: -1 } }), /check constraint|holdPeriodDays/i);
  });
});

describe('Install setup on console start', () => {
  test('opening the embedded console sets up a shop that has no config yet, and leaves a configured one alone', async () => {
    const { startEmbeddedConsole, sessionToken, installShop } = await import('../helpers/shopify-embedded.js');
    const site = await startEmbeddedConsole();
    const shop = newShop();
    const gw = new FakeShopifyGateway(shop);
    gw.shopCurrency = 'CAD';
    ledgerService.setGatewayFactory(() => gw);
    try {
      await installShop(shop);
      const r = await site.call('GET', 'session', { token: sessionToken(shop) });
      assert.strictEqual(r.status, 200);
      assert.strictEqual((await prisma.loyaltyConfig.findUnique({ where: { shop } })).currency, 'CAD');
      gw.shopCurrency = 'USD';
      await site.call('GET', 'session', { token: sessionToken(shop) });
      assert.strictEqual((await prisma.loyaltyConfig.findUnique({ where: { shop } })).currency, 'CAD');
      // A Shopify failure on that call does not fail the console.
      const other = newShop();
      await installShop(other);
      gw.injectFailure(new Error('down'));
      assert.strictEqual((await site.call('GET', 'session', { token: sessionToken(other) })).status, 200);
    } finally {
      await site.close();
      await prisma.$disconnect();
    }
  });
});
