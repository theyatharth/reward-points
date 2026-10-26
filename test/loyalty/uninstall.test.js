// test/loyalty/uninstall.test.js
//
// app/uninstalled: the shop is marked inactive, its tokens are dropped, the background jobs leave it alone, its data stays until
// shop/redact, and a reinstall switches it back on. app/scopes_update stores the new scopes. Every topic the public app subscribes to
// has a handler.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { prisma } from '../../web/lib/prisma.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { storeWebhook, processPendingWebhooks, processPendingWebhooksWithStats } from '../../web/loyalty/service/webhook.js';
import { activateDueLots, deleteVoidedCodes, expireUnusedCodes } from '../../web/loyalty/service/jobs.js';
import { syncDirtyAccounts, syncRuleMetafields } from '../../web/loyalty/service/metafield-sync.js';
import { runInstallSetup } from '../../web/loyalty/service/install.js';
import { inactiveShops } from '../../web/loyalty/service/shop-state.js';
import { startWebhookServer, loadShopify, installShop } from '../helpers/shopify-embedded.js';
import { webhookHandlers } from '../../web/routes/webhook.routes.js';
import { uniqueId } from '../helpers/ids.js';

const newShop = () => `unin-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
const CONFIG = { spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, currency: 'INR', holdPeriodDays: 30, ledgerStartAt: new Date('2026-01-01T00:00:00Z') };

describe('Uninstall and scopes', () => {
  let hook;
  let shop;
  let gw;
  before(async () => { hook = await startWebhookServer(); });
  after(async () => { await hook.close(); await prisma.$disconnect(); });
  beforeEach(async () => {
    shop = newShop();
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
    await prisma.loyaltyConfig.create({ data: { shop, ...CONFIG } });
    await installShop(shop);
    await prisma.shopInstall.create({ data: { shop, scopes: 'read_orders' } });
  });
  const uninstall = () => hook.send('app/uninstalled', shop, { id: 1, name: 'x', myshopify_domain: shop });
  const install = () => prisma.shopInstall.findUnique({ where: { shop } });

  test('uninstall: marked inactive, every session (the tokens) dropped, the data stays', async () => {
    await prisma.session.create({ data: { id: `${shop}_user1`, shop, state: 's', isOnline: true, accessToken: 'online-token' } });
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: String(uniqueId()), available: 10 } });
    const r = await uninstall();
    assert.strictEqual(r.status, 200);
    const row = await install();
    assert.strictEqual(row.status, 'uninstalled');
    assert.ok(row.uninstalledAt);
    assert.strictEqual(await prisma.session.count({ where: { shop } }), 0);
    assert.strictEqual(await prisma.loyaltyConfig.count({ where: { shop } }), 1);
    assert.strictEqual(await prisma.loyaltyAccount.count({ where: { shop } }), 1);
    assert.ok((await inactiveShops()).includes(shop));
    // Delivered twice: still fine.
    assert.strictEqual((await uninstall()).status, 200);
  });

  test('an old uninstall event after a reinstall (the token works) does not switch the shop off', async () => {
    gw.tokenValid = true;
    assert.strictEqual((await uninstall()).status, 200);
    const row = await install();
    assert.deepStrictEqual([row.status, row.uninstalledAt], ['active', null]);
    assert.ok(!(await inactiveShops()).includes(shop));
    // (shopify-app-express adds its own APP_UNINSTALLED handler that always deletes the shop's sessions; the next visit
    // exchanges a new token and the afterAuth hook runs again, so a stale event costs one token exchange, not the shop.)
  });

  test('jobs skip an uninstalled shop (events wait, lots stay pending, nothing is synced or deleted) until it is reinstalled', async () => {
    const customer = String(uniqueId());
    const account = await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: customer, pending: 5 } });
    const lot = await prisma.pointLot.create({ data: { accountId: account.id, originalPoints: 5, remaining: 5, shopifyOrderId: String(uniqueId()), activatesAt: new Date(Date.now() - 1000) } });
    await prisma.loyaltyOrder.create({ data: { accountId: account.id, shopifyOrderId: lot.shopifyOrderId, shop, pointsEarned: 5, eligibleAmountPaise: 500, processedAt: new Date(), lotId: lot.id } });
    await prisma.reward.create({ data: { accountId: account.id, shop, discountCode: `C-${crypto.randomUUID()}`, discountCodeId: 'gid://x/1', valueInPaise: 100, pointsUsed: 5, status: 'returned', needsShopifyDelete: true } });
    const event = await storeWebhook({ shop, topic: 'orders/paid', shopifyWebhookId: crypto.randomUUID(), payload: { id: uniqueId(), customer: { id: customer }, processed_at: new Date().toISOString(), line_items: [{ id: 1, quantity: 1, price: '100', title: 'x' }] } });
    await uninstall();

    // With no shop named (the worker) and with the shop named (an admin or a test): both leave it alone.
    assert.deepStrictEqual(await processPendingWebhooksWithStats({ shop }), { picked: 0, processed: 0, failed: 0 });
    await processPendingWebhooks();
    assert.strictEqual((await prisma.webhookEvent.findUnique({ where: { id: event.id } })).status, 'pending');
    // Named: nothing at all. Not named (the worker, which sees every shop's rows): this shop's rows are not touched.
    assert.strictEqual((await activateDueLots({ shop })).activated, 0);
    assert.strictEqual((await deleteVoidedCodes({ shop })).deleted, 0);
    assert.strictEqual((await expireUnusedCodes({ shop })).expired, 0);
    assert.strictEqual((await syncDirtyAccounts({ shop })).synced, 0);
    assert.strictEqual((await syncRuleMetafields({ shop })).synced, 0);
    await activateDueLots(); await deleteVoidedCodes(); await expireUnusedCodes(); await syncDirtyAccounts(); await syncRuleMetafields();
    assert.strictEqual((await prisma.pointLot.findUnique({ where: { id: lot.id } })).status, 'pending');
    assert.strictEqual((await prisma.reward.findFirst({ where: { shop } })).needsShopifyDelete, true);
    assert.ok(!(gw.metafieldCalls ?? []).flat().includes(customer), 'this shop was not synced');

    // Reinstall: the afterAuth hook runs, the shop is active again and the same jobs now work.
    const r = await runInstallSetup({ session: { shop, scope: 'read_orders,write_discounts' } }, () => gw, { log() {}, error() {} });
    assert.strictEqual(r.status, 'exists');
    const row = await install();
    assert.deepStrictEqual([row.status, row.uninstalledAt, row.scopes], ['active', null, 'read_orders,write_discounts']);
    assert.ok(!(await inactiveShops()).includes(shop));
    await processPendingWebhooks({ shop });
    assert.notStrictEqual((await prisma.webhookEvent.findUnique({ where: { id: event.id } })).status, 'pending');
    assert.strictEqual((await deleteVoidedCodes({ shop })).deleted, 1);
    assert.strictEqual((await activateDueLots({ shop })).due, 1);
  });

  test('shop/redact after an uninstall erases everything, including the uninstalled mark', async () => {
    await uninstall();
    assert.strictEqual((await hook.send('shop/redact', shop, { shop_id: 1, shop_domain: shop })).status, 200);
    assert.strictEqual(await install(), null);
    assert.strictEqual(await prisma.loyaltyConfig.count({ where: { shop } }), 0);
  });

  test('app/scopes_update stores the new scopes on the shop and on its session', async () => {
    const r = await hook.send('app/scopes_update', shop, { id: 1, previous: ['read_orders'], current: ['read_orders', 'write_discounts', 'read_customers', 'write_customers'], updated_at: new Date().toISOString() });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await install()).scopes, 'read_orders,write_discounts,read_customers,write_customers');
    assert.strictEqual((await prisma.session.findUnique({ where: { id: `offline_${shop}` } })).scope, 'read_orders,write_discounts,read_customers,write_customers');
    // Junk entries are dropped, a payload without "current" changes nothing, an unknown shop gets a row.
    await hook.send('app/scopes_update', shop, { current: ['read_orders', '<script>', 5, 'a b'] });
    assert.strictEqual((await install()).scopes, 'read_orders');
    await hook.send('app/scopes_update', shop, { previous: [] });
    assert.strictEqual((await install()).scopes, 'read_orders');
    const other = newShop();
    await hook.send('app/scopes_update', other, { current: ['read_orders'] });
    assert.strictEqual((await prisma.shopInstall.findUnique({ where: { shop: other } })).status, 'active');
  });

  test('an unsigned or wrongly signed event does nothing', async () => {
    assert.strictEqual((await hook.send('app/uninstalled', shop, { id: 1 }, { secret: 'wrong-secret-wrong-secret-wrong-secret' })).status, 401);
    assert.strictEqual((await hook.send('app/uninstalled', shop, { id: 1 }, { hmac: null })).status, 401);
    assert.strictEqual((await hook.send('app/scopes_update', shop, { current: [] }, { hmac: 'AAAA' })).status, 401);
    assert.strictEqual((await install()).status, 'active');
    assert.strictEqual((await install()).scopes, 'read_orders');
  });
});

describe('Every subscribed topic has a handler', () => {
  after(async () => { await prisma.$disconnect(); });

  const toml = readFileSync(new URL('../../shopify.app.production.toml', import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  const listIn = (re) => [...toml.matchAll(re)].flatMap((m) => m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean));
  const topics = [...listIn(/^\s*topics = \[([^\]]*)\]/gm), ...listIn(/compliance_topics = \[([^\]]*)\]/g)];

  test('the production config subscribes to 8 topics and webhookHandlers has a handler for each, as the library resolves them', async () => {
    assert.strictEqual(topics.length, 8, topics.join(', '));
    const shopify = await loadShopify();
    await startWebhookServer().then((s) => s.close()); // registers the handlers on the shopify instance, as web/index.js does
    for (const topic of topics) {
      const handlers = shopify.api.webhooks.getHandlers(topic);
      assert.ok(handlers && handlers.length >= 1, `no handler for ${topic}`);
    }
    const keys = Object.keys(webhookHandlers);
    for (const key of ['ORDERS_PAID', 'ORDERS_CANCELLED', 'REFUNDS_CREATE', 'APP_UNINSTALLED', 'APP_SCOPES_UPDATE', 'CUSTOMERS_DATA_REQUEST', 'CUSTOMERS_REDACT', 'SHOP_REDACT']) assert.ok(keys.includes(key), key);
  });

  test('the check can fail: a topic nobody handles is reported', async () => {
    const shopify = await loadShopify();
    assert.ok(!(shopify.api.webhooks.getHandlers('products/update') ?? []).length);
  });
});
