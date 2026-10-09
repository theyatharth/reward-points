// test/loyalty/code-expiry.test.js
//
// Task 4b: processDue's "expire codes" step (docs/reference/engine.js). An unused reward code
// past expiresAt makes the Reward and the Redemption 'expired'. Its points are returned only when
// config.returnPointsOnCodeExpiry is true: a reward_return entry and a fresh active lot, repaying
// debt first. Lot expiry (points expiring with age) stays off. Driven by the fake clock.
//
// Config: 500 points buy a 50.00 reward, codes valid 90 days.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import { expireUnusedCodes, activateDueLots } from '../../web/loyalty/service/jobs.js';
import { createWorkerWork, runTick } from '../../web/loyalty/service/worker.js';
import { redeem } from '../../web/loyalty/service/redemption.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { setFixedTime, restoreClock, now } from '../../web/loyalty/adapters/clock.js';
import { uniqueId, uniqueKey } from '../helpers/ids.js';
import { assertLedgerInvariants, assertLedgerBalances } from '../helpers/invariants.js';

const DAY = 24 * 60 * 60 * 1000;
const C = 'cx1';

describe('Expiry of unused reward codes', () => {
  let shop = '';
  let gw = null;
  const advanceMs = (ms) => setFixedTime(new Date(now().getTime() + ms));

  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });

  beforeEach(async () => {
    shop = `expiry-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    setFixedTime(new Date('2026-09-01T10:00:00Z'));
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
    await prisma.loyaltyConfig.create({
      data: {
        shop, spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, rewardExpiryDays: 90,
        currency: 'INR', holdPeriodDays: 30, ledgerStartAt: new Date('2026-01-01T00:00:00Z'), returnPointsOnCodeExpiry: true,
      },
    });
  });

  after(async () => {
    restoreClock();
    await prisma.$disconnect();
  });

  const acct = () => prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: C } } });
  const reward = () => prisma.reward.findFirst({ where: { shop } });
  const redemption = () => prisma.redemption.findFirst({ where: { shop } });
  const setReturn = (v) => prisma.loyaltyConfig.update({ where: { shop }, data: { returnPointsOnCodeExpiry: v } });

  /** Earns 500, lets it activate, redeems it: one active code worth 50.00, 0 points left. Returns the order id. */
  async function redeemedCode() {
    const orderId = uniqueId();
    const payload = { id: orderId, customer: { id: C }, processed_at: now().toISOString(), line_items: [{ id: 1, quantity: 1, price: '500', title: 'Item' }] };
    await storeWebhook({ shop, topic: 'orders/paid', payload, shopifyWebhookId: crypto.randomUUID() });
    await processPendingWebhooks({ shop });
    gw.addOrder({ id: orderId, processed_at: payload.processed_at, refunds: [] });
    advanceMs(31 * DAY);
    assert.strictEqual((await activateDueLots({ shop })).activated, 1);
    const r = await redeem({ shop, shopifyCustomerId: C, idempotencyKey: crypto.randomUUID() });
    assert.strictEqual(r.ok, true);
    assert.strictEqual((await acct()).available, 0);
    return orderId;
  }

  test('a code is untouched until the instant it expires; then Reward and Redemption are expired and the points return', async () => {
    await redeemedCode();
    const expiresAt = (await reward()).expiresAt;
    assert.strictEqual(expiresAt.getTime(), now().getTime() + 90 * DAY);

    advanceMs(90 * DAY - 1);
    assert.deepStrictEqual(await expireUnusedCodes({ shop }), { due: 0, expired: 0, pointsReturned: 0 }, '1 ms early');
    assert.strictEqual((await reward()).status, 'active');

    advanceMs(1);
    assert.deepStrictEqual(await expireUnusedCodes({ shop }), { due: 1, expired: 1, pointsReturned: 500 });
    assert.strictEqual((await reward()).status, 'expired');
    assert.strictEqual((await redemption()).status, 'expired');

    const a = await assertLedgerBalances(prisma, (await acct()).id);
    assert.deepStrictEqual([a.available, a.pending, a.debt], [500, 0, 0]);
    const entries = await prisma.ledgerEntry.findMany({ where: { accountId: a.id, type: 'reward_return' } });
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].points, 500);
    assert.strictEqual(entries[0].rewardId, (await reward()).id);
    const lot = await prisma.pointLot.findFirst({ where: { id: entries[0].lotId } });
    assert.deepStrictEqual([lot.status, lot.remaining], ['active', 500], 'a fresh active lot, spendable at once');

    assert.deepStrictEqual(await expireUnusedCodes({ shop }), { due: 0, expired: 0, pointsReturned: 0 }, 'repeating it changes nothing');
  });

  test('with returnPointsOnCodeExpiry OFF the code expires but the points stay spent', async () => {
    await redeemedCode();
    await setReturn(false);
    advanceMs(91 * DAY);
    assert.deepStrictEqual(await expireUnusedCodes({ shop }), { due: 1, expired: 1, pointsReturned: 0 });
    assert.strictEqual((await reward()).status, 'expired');
    assert.strictEqual((await redemption()).status, 'expired');
    const a = await assertLedgerBalances(prisma, (await acct()).id);
    assert.deepStrictEqual([a.available, a.debt], [0, 0]);
    assert.strictEqual(await prisma.ledgerEntry.count({ where: { accountId: a.id, type: 'reward_return' } }), 0);
  });

  test('returned points repay an owed balance first', async () => {
    await redeemedCode();
    const a0 = await acct();
    await prisma.loyaltyAccount.update({ where: { id: a0.id }, data: { debt: 200 } }); // owed from an earlier return
    advanceMs(91 * DAY);
    assert.deepStrictEqual(await expireUnusedCodes({ shop }), { due: 1, expired: 1, pointsReturned: 500 });
    const a = await assertLedgerInvariants(prisma, a0.id);
    assert.deepStrictEqual([a.available, a.debt], [300, 0]);
    const lot = await prisma.pointLot.findFirst({ where: { accountId: a0.id, status: 'active' } });
    assert.strictEqual(lot.remaining, 300);
    const entry = await prisma.ledgerEntry.findFirst({ where: { accountId: a0.id, type: 'reward_return' } });
    assert.strictEqual(entry.points, 500);
    assert.match(entry.note, /200 used to repay the owed balance/);
  });

  test('a used, a voided and a replaced code are never expired', async () => {
    await redeemedCode();
    await prisma.reward.updateMany({ where: { shop }, data: { status: 'used', usedAt: now() } });
    advanceMs(91 * DAY);
    assert.deepStrictEqual(await expireUnusedCodes({ shop }), { due: 0, expired: 0, pointsReturned: 0 });
    assert.strictEqual((await reward()).status, 'used');
    assert.strictEqual((await redemption()).status, 'active');

    await prisma.reward.updateMany({ where: { shop }, data: { status: 'returned' } }); // voided to cover a refund
    assert.deepStrictEqual(await expireUnusedCodes({ shop }), { due: 0, expired: 0, pointsReturned: 0 });
  });

  test('a customer replaying the request for an expired code is told it expired, and sees no code', async () => {
    await redeemedCode();
    const key = (await redemption()).idempotencyKey;
    advanceMs(91 * DAY);
    await expireUnusedCodes({ shop });
    const again = await redeem({ shop, shopifyCustomerId: C, idempotencyKey: key });
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.reason, 'REWARD_EXPIRED');
    assert.strictEqual(again.code, undefined);
  });

  test('the returned points can be redeemed again, and a second code expires on its own date', async () => {
    await redeemedCode();
    advanceMs(91 * DAY);
    await expireUnusedCodes({ shop });
    const second = await redeem({ shop, shopifyCustomerId: C, idempotencyKey: crypto.randomUUID() });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.pointsUsed, 500);
    advanceMs(89 * DAY);
    assert.strictEqual((await expireUnusedCodes({ shop })).expired, 0);
    advanceMs(2 * DAY);
    assert.strictEqual((await expireUnusedCodes({ shop })).expired, 1);
    const a = await assertLedgerBalances(prisma, (await acct()).id);
    assert.strictEqual(a.available, 500);
  });

  test('the worker tick runs the expiry and records a JobRun', async () => {
    await redeemedCode();
    advanceMs(91 * DAY);
    const jobType = uniqueKey('tick');
    await runTick({ work: createWorkerWork({ shop }), jobType });
    assert.strictEqual((await reward()).status, 'expired');
    const runs = await prisma.jobRun.findMany({ where: { jobType: 'expire_codes', shop } });
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].result.expired, 1);
  });
});
