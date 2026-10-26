// test/loyalty/metafield-sync.test.js
//
// Task 7a: the worker pushes the ledger to the storefront metafields. Dirty tracking is done by database
// triggers (migration 8), so the tests change the ledger the ordinary way (webhooks, redemption, adjustment,
// expiry) and check that the right accounts become dirty and that the sync is lossless:
// a change during a sync stays dirty. Fake gateway, fake clock.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import { syncDirtyAccounts, syncRuleMetafields, markAllAccountsDirty } from '../../web/loyalty/service/metafield-sync.js';
import { activateDueLots, expireUnusedCodes } from '../../web/loyalty/service/jobs.js';
import { createWorkerWork, runTick } from '../../web/loyalty/service/worker.js';
import { adjustPoints } from '../../web/loyalty/service/adjustment.js';
import { redeem } from '../../web/loyalty/service/redemption.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { setFixedTime, restoreClock, now } from '../../web/loyalty/adapters/clock.js';
import { uniqueId, uniqueKey } from '../helpers/ids.js';

const DAY = 24 * 60 * 60 * 1000;

describe('Storefront metafield sync', () => {
  let shop = '';
  let gw = null;
  let adminId = '';
  const advance = (days) => setFixedTime(new Date(now().getTime() + days * DAY));

  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });

  beforeEach(async () => {
    shop = `mfsync-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    setFixedTime(new Date('2026-09-01T10:00:00Z'));
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
    await prisma.loyaltyConfig.create({
      data: { shop, spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, rewardExpiryDays: 90, currency: 'INR', holdPeriodDays: 30, ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
    });
    adminId = (await prisma.adminUser.create({ data: { shop, email: `a-${crypto.randomUUID()}@example.test`, passwordHash: 'x' } })).id;
  });

  after(async () => {
    restoreClock();
    await prisma.$disconnect();
  });

  // ---- helpers ----

  const acct = (id) => prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: id } } });
  const isDirty = async (id) => { const a = await acct(id); return a.metafieldSeq > a.metafieldSyncedSeq; };
  const meta = (id) => gw.customerMetafields?.get(id);
  const sync = (over = {}) => syncDirtyAccounts({ shop, ...over });

  async function earn(customer, points) {
    const orderId = uniqueId();
    await storeWebhook({
      shop, topic: 'orders/paid', shopifyWebhookId: crypto.randomUUID(),
      payload: { id: orderId, customer: { id: customer }, processed_at: now().toISOString(), line_items: [{ id: 1, quantity: 1, price: String(points), title: 'Item' }] },
    });
    await processPendingWebhooks({ shop });
    gw.addOrder({ id: orderId, processed_at: now().toISOString(), refunds: [] });
    return orderId;
  }
  const grant = (customer, points, reason = 'Customer service goodwill') => adjustPoints({
    shop, shopifyCustomerId: customer, points, reason, note: 'for the sync tests', adminId, idempotencyKey: crypto.randomUUID(),
  });

  // ===================== what is written =====================

  test('a new account becomes dirty by itself (trigger); the sync writes the four metafields and cleans it', async () => {
    const c = String(uniqueId());
    await earn(c, 300);
    assert.strictEqual(await isDirty(c), true, 'an earn changed the balances');

    assert.deepStrictEqual(await sync(), { dirty: 1, synced: 1, gone: 0, failed: [] });
    assert.deepStrictEqual(meta(c), {
      reward_points: 0, pending_points: 300,
      pending_points_available_at: new Date('2026-10-01T10:00:00Z').toISOString(), earned_discount_code: 'NONE',
    });
    assert.strictEqual(await isDirty(c), false);
    assert.ok((await acct(c)).metafieldSyncedAt);

    assert.deepStrictEqual(await sync(), { dirty: 0, synced: 0, gone: 0, failed: [] }, 'nothing dirty: no call');
    assert.strictEqual(gw.metafieldCalls.length, 1);
  });

  test('every kind of ledger change makes the account dirty: activation, adjustment, refund, redemption, code expiry', async () => {
    const c = String(uniqueId());
    const orderId = await earn(c, 500);
    await sync();

    advance(31);
    await activateDueLots({ shop });
    assert.strictEqual(await isDirty(c), true, 'activation');
    await sync();
    assert.deepStrictEqual([meta(c).reward_points, meta(c).pending_points, meta(c).pending_points_available_at], [500, 0, 'NONE']);

    await grant(c, 100);
    assert.strictEqual(await isDirty(c), true, 'adjustment');
    await sync();
    assert.strictEqual(meta(c).reward_points, 600);

    const r = await redeem({ shop, shopifyCustomerId: c, idempotencyKey: crypto.randomUUID() });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(await isDirty(c), true, 'redemption');
    await sync();
    assert.deepStrictEqual([meta(c).reward_points, meta(c).earned_discount_code], [100, r.code]);

    await prisma.reward.updateMany({ where: { shop }, data: { status: 'used' } });
    assert.strictEqual(await isDirty(c), true, 'a reward changing status alone (balances unchanged)');
    await sync();
    assert.strictEqual(meta(c).earned_discount_code, 'NONE');
    void orderId;
  });

  test('an unused code that expires is cleared from the storefront, before and after the expiry job', async () => {
    const c = String(uniqueId());
    await earn(c, 500);
    advance(31);
    await activateDueLots({ shop });
    const r = await redeem({ shop, shopifyCustomerId: c, idempotencyKey: crypto.randomUUID() });
    await sync();
    assert.strictEqual(meta(c).earned_discount_code, r.code);

    // Past expiry but the job has not run yet: the account is not dirty, but a sync (for another reason) already hides it.
    advance(91);
    await grant(c, 1);
    await sync();
    assert.strictEqual(meta(c).earned_discount_code, 'NONE', 'an expired code is never shown');

    await expireUnusedCodes({ shop });
    assert.strictEqual(await isDirty(c), true, 'the status change marks it dirty');
    await sync();
    assert.strictEqual(meta(c).earned_discount_code, 'NONE');
  });

  test('the newest live code is shown when there are several', async () => {
    const c = String(uniqueId());
    await earn(c, 1000);
    advance(31);
    await activateDueLots({ shop });
    const first = await redeem({ shop, shopifyCustomerId: c, idempotencyKey: crypto.randomUUID() });
    assert.strictEqual(first.pointsUsed, 1000, 'both chunks in one code');
    await grant(c, 500);
    advance(1);
    const second = await redeem({ shop, shopifyCustomerId: c, idempotencyKey: crypto.randomUUID() });
    await sync();
    assert.strictEqual(meta(c).earned_discount_code, second.code);
  });

  // ===================== lossless =====================

  test('a change that lands DURING the sync leaves the account dirty and is synced next time', async () => {
    const c = String(uniqueId());
    await earn(c, 300);
    advance(31);
    await activateDueLots({ shop });
    await sync();

    await grant(c, 100); // dirty
    let injected = false;
    gw.onSetCustomerMetafields = async () => {
      if (injected) return;
      injected = true;
      await grant(c, 50); // lands after the sync read the account, before it is marked clean
    };
    const first = await sync();
    assert.strictEqual(first.synced, 1);
    assert.strictEqual(meta(c).reward_points, 400, 'what was read before the change');
    assert.strictEqual(await isDirty(c), true, 'the change made during the sync is not lost');

    gw.onSetCustomerMetafields = null;
    assert.strictEqual((await sync()).synced, 1);
    assert.strictEqual(meta(c).reward_points, 450);
    assert.strictEqual(await isDirty(c), false);
  });

  test('syncing does not mark anything dirty by itself (no loop)', async () => {
    const c = String(uniqueId());
    await earn(c, 300);
    await sync();
    const a = await acct(c);
    assert.strictEqual(a.metafieldSeq, a.metafieldSyncedSeq);
    assert.deepStrictEqual(await sync(), { dirty: 0, synced: 0, gone: 0, failed: [] });
  });

  // ===================== batching and failures =====================

  test('accounts are written six to a call', async () => {
    const customers = Array.from({ length: 14 }, () => String(uniqueId()));
    for (const c of customers) await earn(c, 100);
    const r = await sync();
    assert.deepStrictEqual([r.dirty, r.synced], [14, 14]);
    assert.deepStrictEqual(gw.metafieldCalls.map((call) => call.length), [6, 6, 2]);
    for (const c of customers) assert.strictEqual(meta(c).pending_points, 100);
  });

  test('a failed batch is retried one by one; a customer that no longer exists is marked synced, a transient failure stays dirty', async () => {
    const [good, gone, flaky] = [String(uniqueId()), String(uniqueId()), String(uniqueId())];
    for (const c of [good, gone, flaky]) await earn(c, 100);
    gw.onSetCustomerMetafields = async (items) => {
      if (items.some((i) => i.customerId === gone)) { const e = new Error('Shopify refused the metafields: Owner does not exist'); e.userErrors = [{ message: 'Owner does not exist' }]; throw e; }
      if (items.some((i) => i.customerId === flaky)) throw new Error('timeout');
    };
    const r = await sync();
    assert.deepStrictEqual([r.dirty, r.synced, r.gone], [3, 1, 1]);
    assert.deepStrictEqual(r.failed.map((f) => f.customerId), [flaky]);
    assert.strictEqual(await isDirty(good), false);
    assert.strictEqual(await isDirty(gone), false, 'it can never succeed: not retried forever');
    assert.strictEqual(await isDirty(flaky), true);
    assert.ok(meta(good));

    gw.onSetCustomerMetafields = null;
    assert.strictEqual((await sync()).synced, 1, 'the flaky one is retried next run');
    assert.strictEqual(await isDirty(flaky), false);
  });

  test('the run is capped, and the rest waits for the next run', async () => {
    for (let i = 0; i < 5; i++) await earn(String(uniqueId()), 100);
    assert.strictEqual((await sync({ limit: 3 })).synced, 3);
    assert.strictEqual((await sync({ limit: 3 })).synced, 2);
  });

  test('markAllAccountsDirty re-syncs everything (after the metafields were wiped)', async () => {
    const c = String(uniqueId());
    await earn(c, 300);
    await sync();
    assert.strictEqual(await markAllAccountsDirty(shop), 1);
    assert.strictEqual((await sync()).synced, 1);
  });

  // ===================== the rule metafield =====================

  test('the redeem rule is written once, again only when pointsPerReward, rewardValue, hold period or currency change', async () => {
    assert.deepStrictEqual(await syncRuleMetafields({ shop }), { dirty: 1, synced: 1, failed: [] });
    assert.deepStrictEqual(gw.ruleMetafields, [{ pointsPerReward: 500, rewardValue: '50.00', currency: 'INR', holdPeriodDays: 30, programName: 'Reward Points' }]);
    assert.deepStrictEqual(await syncRuleMetafields({ shop }), { dirty: 0, synced: 0, failed: [] });

    await prisma.loyaltyConfig.update({ where: { shop }, data: { rewardExpiryDays: 60 } }); // not part of the rule
    assert.strictEqual((await syncRuleMetafields({ shop })).dirty, 0);

    await prisma.loyaltyConfig.update({ where: { shop }, data: { pointsPerReward: 250, rewardValue: 2500 } });
    assert.strictEqual((await syncRuleMetafields({ shop })).synced, 1);
    assert.deepStrictEqual(gw.ruleMetafields.at(-1), { pointsPerReward: 250, rewardValue: '25.00', currency: 'INR', holdPeriodDays: 30, programName: 'Reward Points' });
    await prisma.loyaltyConfig.update({ where: { shop }, data: { holdPeriodDays: 14 } });
    await syncRuleMetafields({ shop });
    assert.strictEqual(gw.ruleMetafields.at(-1).holdPeriodDays, 14);
  });

  test('a failed rule sync stays dirty and is retried', async () => {
    gw.injectFailure(new Error('Shopify is down'));
    const r = await syncRuleMetafields({ shop });
    assert.strictEqual(r.synced, 0);
    assert.match(r.failed[0].reason, /Shopify is down/);
    assert.strictEqual((await syncRuleMetafields({ shop })).synced, 1);
  });

  // ===================== in the worker =====================

  test('the worker tick syncs the storefront and records a JobRun; a failing sync is recorded once, not every tick', async () => {
    const c = String(uniqueId());
    await earn(c, 300);
    const jobType = uniqueKey('tick');
    await runTick({ work: createWorkerWork({ shop }), jobType });
    assert.strictEqual(meta(c).pending_points, 300);
    assert.strictEqual(gw.ruleMetafields.length, 1);
    const runs = await prisma.jobRun.findMany({ where: { jobType: 'sync_metafields', shop } });
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].status, 'completed');
    assert.strictEqual(runs[0].result.accounts.synced, 1);

    // Now Shopify is down for a while: failures are recorded once per 10 minutes.
    await grant(c, 10);
    gw.onSetCustomerMetafields = async () => { throw new Error('down'); };
    await runTick({ work: createWorkerWork({ shop }), jobType });
    await runTick({ work: createWorkerWork({ shop }), jobType });
    const failedRuns = (await prisma.jobRun.findMany({ where: { jobType: 'sync_metafields', shop } })).filter((r) => r.status === 'failed');
    assert.strictEqual(failedRuns.length, 1);
    assert.strictEqual(await isDirty(c), true);
  });
});
