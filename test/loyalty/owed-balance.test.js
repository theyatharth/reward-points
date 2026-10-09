// test/loyalty/owed-balance.test.js
//
// Decision D4: what a customer owes is the debt column; available is never below 0.
// A reversal larger than the balance takes from lots first, voids UNUSED reward codes
// (returning their points) next, and only then adds to debt. New activated points repay
// debt first. Redemption is refused while debt > 0.
//
// Config: 500 points buy a 50.00 reward (pointsPerReward 500, rewardValue 5000), 1 point
// per 100 paise (so an order of 500.00 earns 500 points), 30-day hold.
// Every step ends with the ledger invariants (test/helpers/invariants.js).

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import { redeem, resolveRedemption } from '../../web/loyalty/service/redemption.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { setFixedTime, restoreClock, now } from '../../web/loyalty/adapters/clock.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { uniqueId } from '../helpers/ids.js';
import { assertLedgerInvariants, assertLedgerBalances } from '../helpers/invariants.js';

const DAY = 24 * 60 * 60 * 1000;
const C = 'c1';

describe('Owed balance (D4)', () => {
  let shop = '';
  let gw = null;
  let clock = new Date('2026-09-01T10:00:00Z');

  const advance = (days) => { clock = new Date(clock.getTime() + days * DAY); setFixedTime(clock); };
  const key = () => crypto.randomUUID();

  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });

  beforeEach(async () => {
    shop = `owed-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    await prisma.loyaltyConfig.create({
      data: {
        shop, spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, rewardExpiryDays: 90,
        currency: 'INR', ledgerStartAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    clock = new Date('2026-09-01T10:00:00Z');
    setFixedTime(clock);
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
  });

  after(async () => {
    restoreClock();
    await prisma.$disconnect();
  });

  // ---- helpers ----

  const acct = () => prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: C } } });
  const check = async (label) => assertLedgerBalances(prisma, (await acct()).id, label);
  const entries = async (type) => prisma.ledgerEntry.findMany({ where: { accountId: (await acct()).id, ...(type ? { type } : {}) } });
  const types = async () => (await entries()).map((e) => `${e.type}:${e.points}`).sort();

  /** An order of `points` points in `units` units (one line, id 1). Earned and processed. */
  async function earnOrder(points, units = 1) {
    const orderId = uniqueId();
    const payload = {
      id: orderId, customer: { id: C }, processed_at: now().toISOString(),
      line_items: [{ id: 1, quantity: units, price: String(points / units), title: 'Item' }],
    };
    await storeWebhook({ shop, topic: 'orders/paid', payload, shopifyWebhookId: key() });
    await processPendingWebhooks({ shop });
    gw.addOrder({ id: orderId, processed_at: payload.processed_at, refunds: [] });
    return orderId;
  }

  /** Earns an order and lets its points become available (hold period passed, J3 clean). */
  async function earnActive(points, units = 1) {
    const orderId = await earnOrder(points, units);
    advance(31);
    const lot = await prisma.pointLot.findFirst({ where: { shopifyOrderId: String(orderId) } });
    assert.strictEqual(await ledgerService.activatePendingLot(lot.id, shop), true);
    return orderId;
  }

  async function refundUnits(orderId, units = 1) {
    const ev = await storeWebhook({
      shop, topic: 'refunds/create', shopifyWebhookId: key(),
      payload: { id: uniqueId(), order_id: orderId, refund_line_items: [{ line_item_id: 1, quantity: units }] },
    });
    await processPendingWebhooks({ shop });
    return prisma.webhookEvent.findUnique({ where: { id: ev.id } });
  }
  async function cancelOrder(orderId) {
    const ev = await storeWebhook({ shop, topic: 'orders/cancelled', shopifyWebhookId: key(), payload: { id: orderId } });
    await processPendingWebhooks({ shop });
    return prisma.webhookEvent.findUnique({ where: { id: ev.id } });
  }
  const doRedeem = () => redeem({ shop, shopifyCustomerId: C, idempotencyKey: key() });

  // ---- voiding an unused reward before owing ----

  test('[Returns 6/6] an unused reward is voided before an owed balance is created', async () => {
    const orderId = await earnActive(500);
    const r = await doRedeem();
    assert.strictEqual(r.ok, true);
    assert.strictEqual((await acct()).available, 0);
    await check('after redeem');

    const ev = await refundUnits(orderId, 1);
    assert.strictEqual(ev.status, 'processed', ev.lastError ?? '');

    const a = await check('after refund');
    assert.deepStrictEqual([a.available, a.pending, a.debt], [0, 0, 0], 'nothing owed');
    const reward = await prisma.reward.findFirst({ where: { shop } });
    assert.strictEqual(reward.status, 'returned');
    assert.ok(reward.returnedAt);
    const redemption = await prisma.redemption.findFirst({ where: { shop } });
    assert.strictEqual(redemption.status, 'voided');
    assert.deepStrictEqual(await types(), ['earn:500', 'redemption:-500', 'refund:-500', 'reward_return:500']);

    // Replaying the voided redemption does not hand the dead code out again.
    const again = await redeem({ shop, shopifyCustomerId: C, idempotencyKey: redemption.idempotencyKey });
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.reason, 'REWARD_VOIDED');
  });

  test('a voided reward bigger than the reversal leaves the surplus with the customer as a fresh active lot', async () => {
    const orderId = await earnActive(1000, 2);
    const r = await doRedeem();
    assert.strictEqual(r.pointsUsed, 1000, 'both chunks in one code');

    await refundUnits(orderId, 1); // 500 points to take back, the code is worth 1000
    const a = await check('after refund');
    assert.deepStrictEqual([a.available, a.pending, a.debt], [500, 0, 0]);
    const lots = await prisma.pointLot.findMany({ where: { accountId: a.id, status: 'active' } });
    assert.deepStrictEqual(lots.map((l) => l.remaining), [500]);
    assert.deepStrictEqual(await types(), ['earn:1000', 'redemption:-1000', 'refund:-500', 'reward_return:1000']);
    assert.strictEqual((await prisma.reward.findFirst({ where: { shop } })).status, 'returned');
  });

  test('a cancellation voids an unused reward the same way', async () => {
    const orderId = await earnActive(500);
    await doRedeem();
    const ev = await cancelOrder(orderId);
    assert.strictEqual(ev.status, 'processed', ev.lastError ?? '');
    const a = await check('after cancel');
    assert.deepStrictEqual([a.available, a.pending, a.debt], [0, 0, 0]);
    assert.strictEqual((await prisma.reward.findFirst({ where: { shop } })).status, 'returned');
    assert.deepStrictEqual(await types(), ['cancel:-500', 'earn:500', 'redemption:-500', 'reward_return:500']);
  });

  // ---- when nothing can be voided, the customer owes ----

  test('a USED reward is not voided: the points are owed (debt), available stays 0', async () => {
    const orderId = await earnActive(500);
    await doRedeem();
    await prisma.reward.updateMany({ where: { shop }, data: { status: 'used', usedAt: now() } });

    const ev = await refundUnits(orderId, 1);
    assert.strictEqual(ev.status, 'processed', ev.lastError ?? '');
    const a = await check('after refund');
    assert.deepStrictEqual([a.available, a.pending, a.debt], [0, 0, 500]);
    assert.strictEqual((await prisma.reward.findFirst({ where: { shop } })).status, 'used');
    assert.match((await entries('refund'))[0].note, /500 added to the owed balance/);
  });

  test('an EXPIRED unused reward is not voided either', async () => {
    const orderId = await earnActive(500);
    await doRedeem();
    await prisma.reward.updateMany({ where: { shop }, data: { expiresAt: new Date(now().getTime() - DAY) } });
    await refundUnits(orderId, 1);
    const a = await check('after refund');
    assert.strictEqual(a.debt, 500);
    assert.strictEqual((await prisma.reward.findFirst({ where: { shop } })).status, 'active');
  });

  test('a redemption still in "creating" (no code yet) cannot be voided: debt, then the compensation repays it', async () => {
    const orderId = await earnActive(500);
    // The code cannot be created and Shopify cannot be asked afterwards: the redemption stays 'creating'.
    gw.injectFailure(new Error('timeout talking to Shopify'));
    gw.injectFailure(new Error('timeout talking to Shopify'));
    const r = await doRedeem();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 'creating');
    const redemption = await prisma.redemption.findFirst({ where: { shop } });

    await refundUnits(orderId, 1);
    let a = await check('refund while creating');
    assert.deepStrictEqual([a.available, a.debt], [0, 500]);

    // Shopify now says the code does not exist: the points come back, and go to the debt first.
    const settled = await resolveRedemption(redemption.id);
    assert.strictEqual(settled.reason, 'DISCOUNT_FAILED');
    a = await check('after compensation');
    assert.deepStrictEqual([a.available, a.pending, a.debt], [0, 0, 0]);
    assert.deepStrictEqual(await types(), ['earn:500', 'redemption:-500', 'refund:-500', 'reward_return:500']);
  });

  test('a reversal bigger than what the rewards can cover: they are voided, the rest is owed', async () => {
    const orderId = await earnActive(800);
    // The customer spent 500 on a code that is still unused...
    const r = await doRedeem();
    assert.strictEqual(r.pointsUsed, 500);
    // ...and the other 300 are spent too (a lot emptied elsewhere, simulated directly).
    const a0 = await acct();
    await prisma.pointLot.updateMany({ where: { accountId: a0.id, status: 'active' }, data: { remaining: 0, status: 'exhausted' } });
    await prisma.loyaltyAccount.update({ where: { id: a0.id }, data: { available: 0 } });
    await assertLedgerInvariants(prisma, a0.id, 'after simulated spend');

    await refundUnits(orderId, 1); // 800 to take back
    const a = await assertLedgerInvariants(prisma, a0.id, 'after refund');
    assert.deepStrictEqual([a.available, a.debt], [0, 300], '500 covered by voiding the code, 300 owed');
    assert.strictEqual((await prisma.reward.findFirst({ where: { shop } })).status, 'returned');
  });

  test('when the order\'s own lot is spent, the missing points come from other active lots first, and only the rest is owed', async () => {
    const first = await earnActive(300);
    const second = await earnActive(500); // two active lots: 300 and 500
    // The second order's lot is spent elsewhere (simulated directly): available 800 -> 300.
    const a0 = await acct();
    await prisma.pointLot.updateMany({ where: { shopifyOrderId: String(second) }, data: { remaining: 0, status: 'exhausted' } });
    await prisma.loyaltyAccount.update({ where: { id: a0.id }, data: { available: 300 } });
    await assertLedgerInvariants(prisma, a0.id, 'after simulated spend');

    await refundUnits(second, 1); // 500 to take back: 300 from the first order's lot, 200 owed
    const a = await assertLedgerInvariants(prisma, a0.id, 'after refund');
    assert.deepStrictEqual([a.available, a.debt], [0, 200]);
    const firstLot = await prisma.pointLot.findFirst({ where: { shopifyOrderId: String(first) } });
    assert.deepStrictEqual([firstLot.remaining, firstLot.status], [0, 'exhausted']);
  });

  // ---- repaying and refusing ----

  test('new activated points repay the debt first, across two orders, then become available', async () => {
    const orderId = await earnActive(500);
    await doRedeem();
    await prisma.reward.updateMany({ where: { shop }, data: { status: 'used', usedAt: now() } });
    await refundUnits(orderId, 1);
    assert.strictEqual((await acct()).debt, 500);

    await earnActive(300);
    let a = await check('after 300 activated');
    assert.deepStrictEqual([a.available, a.debt], [0, 200], '300 repaid 300 of the 500');
    assert.match((await entries('activate')).map((e) => e.note).join('|'), /300 used to repay the owed balance/);

    await earnActive(700);
    a = await check('after 700 activated');
    assert.deepStrictEqual([a.available, a.debt], [500, 0], '200 repaid the rest, 500 are spendable');
    const exhausted = await prisma.pointLot.findMany({ where: { accountId: a.id, status: 'exhausted' } });
    assert.ok(exhausted.some((l) => l.originalPoints === 300), 'the lot fully used for repayment is exhausted');
  });

  test('redemption is refused while debt > 0, even with enough available, and no code is created', async () => {
    await earnActive(500);
    const a0 = await acct();
    await prisma.loyaltyAccount.update({ where: { id: a0.id }, data: { debt: 100 } });
    const r = await doRedeem();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'OWED');
    assert.strictEqual(r.owed, 100);
    assert.strictEqual(gw.discounts.size, 0);
    assert.strictEqual((await acct()).available, 500, 'nothing was taken');
  });

  test('available can never be written below 0: the database refuses it', async () => {
    await earnActive(500);
    const a0 = await acct();
    await assert.rejects(prisma.loyaltyAccount.update({ where: { id: a0.id }, data: { available: -1 } }), /LoyaltyAccount_available_non_negative|check constraint/i);
    await assert.rejects(prisma.loyaltyAccount.update({ where: { id: a0.id }, data: { debt: -1 } }), /check constraint|non_negative/i);
  });

  test('refunding an order twice over in different parts never drives a balance below 0 or loses points', async () => {
    const orderId = await earnActive(1000, 2);
    await doRedeem(); // 1000 points into one code
    await prisma.reward.updateMany({ where: { shop }, data: { status: 'used', usedAt: now() } });
    await refundUnits(orderId, 1);
    let a = await check('first unit');
    assert.deepStrictEqual([a.available, a.debt], [0, 500]);
    await refundUnits(orderId, 1);
    a = await check('second unit');
    assert.deepStrictEqual([a.available, a.debt], [0, 1000]);
  });
});
