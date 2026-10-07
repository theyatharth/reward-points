// test/loyalty/redemption.test.js
//
// T3.1 / T3.7: redemption service tests. Each test gets its own shop (ledger
// rows cannot be deleted, so isolation is by shop name) and a fake gateway.
//
// Config used throughout: 500 points buy ₹50 (pointsPerReward 500,
// rewardValue 5000 paise), matching the "500 points for ₹50" plan scenarios.

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

const DAY = 24 * 60 * 60 * 1000;

let shop = '';
let gw = null;
let clock = new Date('2026-09-01T10:00:00Z');

function advance(days) {
  clock = new Date(clock.getTime() + days * DAY);
  setFixedTime(clock);
}

const key = () => crypto.randomUUID();

// ---- Helpers ----

/** An account whose points are already spendable, in active lots of the given ages. */
async function seedAccount(customerId, lots) {
  const total = lots.reduce((s, l) => s + l.points, 0);
  const account = await prisma.loyaltyAccount.create({
    data: { shop, shopifyCustomerId: String(customerId), available: total },
  });
  const created = [];
  for (const l of lots) {
    const lot = await prisma.pointLot.create({
      data: {
        accountId: account.id,
        originalPoints: l.points,
        remaining: l.points,
        status: 'active',
        shopifyOrderId: `seed-${crypto.randomUUID()}`,
        activatesAt: new Date(now().getTime() - l.ageDays * DAY),
      },
    });
    await prisma.ledgerEntry.create({
      data: {
        accountId: account.id,
        type: 'earn',
        points: l.points,
        status: 'active',
        dedupeKey: `seed:${crypto.randomUUID()}`,
        lotId: lot.id,
      },
    });
    created.push(lot);
  }
  return { account, lots: created };
}

async function acct(customerId) {
  return prisma.loyaltyAccount.findUnique({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: String(customerId) } },
  });
}

async function entries(customerId, type) {
  const a = await acct(customerId);
  return prisma.ledgerEntry.findMany({
    where: { accountId: a.id, ...(type ? { type } : {}) },
    orderBy: { createdAt: 'asc' },
  });
}

async function orderEarning(customerId, orderId, price) {
  const payload = {
    id: orderId,
    customer: { id: customerId },
    processed_at: now().toISOString(),
    total_price: String(price),
    subtotal_price: String(price),
    line_items: [{ id: 1, product_id: 'p1', quantity: 1, price: String(price), title: 'Item' }],
    discount_allocations: [],
    tax_lines: [],
  };
  await storeWebhook({ shop, topic: 'orders/paid', payload, shopifyWebhookId: key() });
  await processPendingWebhooks({ shop });
}

async function refundAmount(orderId, amount) {
  await storeWebhook({
    shop,
    topic: 'refunds/create',
    payload: {
      id: uniqueId(),
      order_id: orderId,
      refund_line_items: [{ subtotalSet: { shopMoney: { amount: `${amount}.00` } } }],
    },
    shopifyWebhookId: key(),
  });
  await processPendingWebhooks({ shop });
}

// Hooks live inside a describe so they apply to THIS file's tests only (see the
// note in client.test.js): top-level hooks would run before every test in every file.
describe('Redemption service', () => {
  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });

  beforeEach(async () => {
    shop = `redeem-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    await prisma.loyaltyConfig.create({
      data: {
        shop,
        pointsPerUnit: 1,
        pointsPerReward: 500,
        rewardValue: 5000,
        rewardExpiryDays: 90,
        currency: 'INR',
        ledgerStartAt: new Date('2026-01-01T00:00:00Z'),
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

  // ---- Happy path and thresholds ----

  test('[Redeem] exactly 500 points redeems ₹50 into a customer-bound, single-use, 90-day code', async () => {
    const { lots } = await seedAccount('c1', [{ points: 500, ageDays: 5 }]);
    const r = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 'active');
    assert.strictEqual(r.pointsUsed, 500);
    assert.strictEqual(r.valuePaise, 5000);
    assert.strictEqual(r.available, 0);
    assert.match(r.code, /^REDE-[A-HJ-NP-Z2-9]{8}$/);

    const discount = gw.discounts.get(r.code);
    assert.ok(discount, 'discount exists in Shopify');
    assert.strictEqual(discount.amount, '50.00');
    assert.strictEqual(discount.customerId, 'c1');
    assert.strictEqual(discount.endsAt.toISOString(), new Date(clock.getTime() + 90 * DAY).toISOString());

    const redemption = await prisma.redemption.findFirst({ where: { shop } });
    assert.strictEqual(redemption.status, 'active');
    assert.strictEqual(redemption.discountCodeId, discount.id);

    const reward = await prisma.reward.findFirst({ where: { shop } });
    assert.strictEqual(reward.discountCode, r.code);
    assert.strictEqual(reward.valueInPaise, 5000);

    const [entry] = await entries('c1', 'redemption');
    assert.strictEqual(entry.points, -500);
    assert.strictEqual(entry.redemptionId, redemption.id);

    const lot = await prisma.pointLot.findUnique({ where: { id: lots[0].id } });
    assert.strictEqual(lot.remaining, 0);
    assert.strictEqual(lot.status, 'exhausted');
  });

  test('[Redeem] 499 points is refused with "1 more point" and writes nothing', async () => {
    await seedAccount('c1', [{ points: 499, ageDays: 5 }]);
    const r = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'SHORT');
    assert.match(r.message, /1 more point\b/);
    assert.strictEqual(r.needed, 1);
    assert.strictEqual(await prisma.redemption.count({ where: { shop } }), 0);
    assert.strictEqual((await entries('c1', 'redemption')).length, 0);
    assert.strictEqual(gw.discounts.size, 0);
    assert.strictEqual((await acct('c1')).available, 499);
  });

  test('[Redeem] a customer with no account is refused as short', async () => {
    const r = await redeem({ shop, shopifyCustomerId: 'nobody', idempotencyKey: key() });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'SHORT');
    assert.match(r.message, /500 more points/);
  });

  test('[Redeem] all whole rewards are redeemed into one code; the remainder stays', async () => {
    await seedAccount('c1', [{ points: 1300, ageDays: 5 }]);
    const r = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() });
    assert.strictEqual(r.pointsUsed, 1000);
    assert.strictEqual(r.valuePaise, 10000);
    assert.strictEqual(r.available, 300);
  });

  test('[Redeem] J1: 1000 points at 500 per reward redeems BOTH rewards in one code and leaves 0', async () => {
    // J1 as built: a redeem spends every whole reward the balance covers. It does
    // not take one reward and leave the rest; one request, one code, full value.
    await seedAccount('c1', [{ points: 1000, ageDays: 5 }]);
    const r = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pointsUsed, 1000);
    assert.strictEqual(r.valuePaise, 10000);
    assert.strictEqual(r.available, 0);
    assert.strictEqual(gw.discounts.size, 1, 'a single code');
    assert.strictEqual(gw.discounts.get(r.code).amount, '100.00');
    assert.strictEqual((await entries('c1', 'redemption')).length, 1);
  });

  test('[Redeem] a missing or oversized idempotency key is refused before anything is read', async () => {
    for (const bad of [undefined, null, '', 'x'.repeat(129), 42]) {
      const r = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: bad });
      assert.strictEqual(r.reason, 'INVALID_KEY');
    }
  });

  test('[Redeem] points are taken from the earliest-activated lot first', async () => {
    const { lots } = await seedAccount('c1', [
      { points: 300, ageDays: 20 }, // older
      { points: 400, ageDays: 2 },
    ]);
    const r = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() }); // 700 -> 1 reward, 500 points
    assert.strictEqual(r.pointsUsed, 500);

    const older = await prisma.pointLot.findUnique({ where: { id: lots[0].id } });
    const newer = await prisma.pointLot.findUnique({ where: { id: lots[1].id } });
    assert.strictEqual(older.remaining, 0);
    assert.strictEqual(older.status, 'exhausted');
    assert.strictEqual(newer.remaining, 200);
    assert.strictEqual(newer.status, 'active');
  });

  // ---- Idempotency ----

  test('[Redeem] double-tap with the same key redeems once and returns the same code', async () => {
    // 700 points at 500 per reward: one reward is affordable, 200 remain.
    await seedAccount('c1', [{ points: 700, ageDays: 5 }]);
    const k = key();
    const first = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: k });
    const second = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: k });

    assert.strictEqual(first.replayed, false);
    assert.strictEqual(second.replayed, true);
    assert.strictEqual(second.code, first.code);
    assert.strictEqual(second.redemptionId, first.redemptionId);
    assert.strictEqual((await acct('c1')).available, 200, 'deducted once, not twice');
    assert.strictEqual((await entries('c1', 'redemption')).length, 1);
    assert.strictEqual(gw.discounts.size, 1);
  });

  test('[Redeem] simultaneous redeem from two connections with different keys: exactly one wins', async () => {
    await seedAccount('c1', [{ points: 500, ageDays: 5 }]);
    const results = await Promise.all([
      redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() }),
      redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() }),
    ]);

    assert.strictEqual(results.filter((r) => r.ok).length, 1);
    assert.strictEqual(results.filter((r) => !r.ok && r.reason === 'SHORT').length, 1);
    assert.strictEqual((await acct('c1')).available, 0);
    assert.strictEqual(gw.discounts.size, 1);
  });

  test('[Redeem] simultaneous redeem with the SAME key: both succeed with one redemption', async () => {
    await seedAccount('c1', [{ points: 700, ageDays: 5 }]);
    const k = key();
    const [a, b] = await Promise.all([
      redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: k }),
      redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: k }),
    ]);

    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, true);
    assert.strictEqual(a.redemptionId, b.redemptionId);
    assert.strictEqual((await acct('c1')).available, 200);
    assert.strictEqual(gw.discounts.size, 1);
  });

  test('[Redeem] the idempotency key is scoped to the account: two customers can use the same key', async () => {
    await seedAccount('c1', [{ points: 500, ageDays: 5 }]);
    await seedAccount('c2', [{ points: 500, ageDays: 5 }]);
    const k = 'same-key-from-two-customers';
    const [a, b] = await Promise.all([
      redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: k }),
      redeem({ shop, shopifyCustomerId: 'c2', idempotencyKey: k }),
    ]);

    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.ok, true);
    assert.notStrictEqual(a.redemptionId, b.redemptionId);
    assert.notStrictEqual(a.code, b.code);
    assert.strictEqual((await acct('c1')).available, 0);
    assert.strictEqual((await acct('c2')).available, 0);
  });

  // ---- Activation first, J3 ----

  test('[Redeem] due pending points are activated first, then redeemed', async () => {
    const orderId = uniqueId();
    await orderEarning('c1', orderId, 500);
    assert.strictEqual((await acct('c1')).pending, 500);

    advance(31);
    gw.addOrder({ id: orderId, processed_at: '2026-09-01T10:00:00Z', refunds: [] });

    const r = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() });
    assert.strictEqual(r.ok, true);

    const a = await acct('c1');
    assert.strictEqual(a.pending, 0);
    assert.strictEqual(a.available, 0);
    assert.strictEqual((await entries('c1', 'activate')).length, 1);
  });

  test('[Redeem] points still inside the holding period are not spendable', async () => {
    const orderId = uniqueId();
    await orderEarning('c1', orderId, 500);
    advance(10);
    gw.addOrder({ id: orderId, processed_at: '2026-09-01T10:00:00Z', refunds: [] });

    const r = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'SHORT');
    assert.strictEqual((await acct('c1')).pending, 500);
  });

  test('[Redeem] J3: an unapplied Shopify refund blocks activation and the redeem is paused', async () => {
    const orderId = uniqueId();
    await orderEarning('c1', orderId, 500);
    advance(31);
    gw.addOrder({ id: orderId, processed_at: '2026-09-01T10:00:00Z', refunds: [{ id: 555 }] });

    const r = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'RECOVERING');

    const a = await acct('c1');
    assert.strictEqual(a.pending, 500, 'lot is left pending');
    assert.strictEqual(a.available, 0);
    assert.strictEqual(gw.discounts.size, 0);
  });

  test('[Redeem] J3: a failed Shopify order lookup also pauses the redeem instead of guessing', async () => {
    const orderId = uniqueId();
    await orderEarning('c1', orderId, 500);
    advance(31);
    // No order registered in the fake: getOrder answers 404.

    const r = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'RECOVERING');
    assert.strictEqual((await acct('c1')).pending, 500);
  });

  test('[Redeem] a refund already applied in the ledger does not trip J3', async () => {
    const orderId = uniqueId();
    await orderEarning('c1', orderId, 1000);
    await refundAmount(orderId, 500); // refunds half: 500 points reversed from the pending lot
    const refund = await prisma.loyaltyRefund.findFirst({ where: { shopifyOrderId: String(orderId) } });
    advance(31);
    gw.addOrder({ id: orderId, processed_at: '2026-09-01T10:00:00Z', refunds: [{ id: Number(refund.shopifyRefundId) }] });

    const r = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pointsUsed, 500);
  });

  // ---- Owed balance ----

  test('[Redeem] owed balance after a used reward: refused, then cleared by new points', async () => {
    // Earn 500, activate and redeem it all for ₹50...
    const firstOrderId = uniqueId();
    await orderEarning('c1', firstOrderId, 500);
    advance(31);
    gw.addOrder({ id: firstOrderId, processed_at: '2026-09-01T10:00:00Z', refunds: [] });
    const first = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() });
    assert.strictEqual(first.ok, true);
    assert.strictEqual((await acct('c1')).available, 0);

    // ...then the order is refunded: the points are already spent, so they are owed.
    await refundAmount(firstOrderId, 500);
    assert.strictEqual((await acct('c1')).available, -500);

    const refused = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.reason, 'OWED');
    assert.strictEqual(refused.owed, 500);
    assert.strictEqual(gw.discounts.size, 1, 'no second code was created');

    // New points repay the debt first (activation happens even though the redeem is refused).
    const secondOrderId = uniqueId();
    await orderEarning('c1', secondOrderId, 700);
    advance(31);
    gw.addOrder({ id: secondOrderId, processed_at: '2026-10-02T10:00:00Z', refunds: [] });
    const short = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() });
    assert.strictEqual(short.ok, false);
    assert.strictEqual(short.reason, 'SHORT');
    assert.strictEqual(short.needed, 300);

    const a = await acct('c1');
    assert.strictEqual(a.available, 200, '700 activated, 500 owed cleared');
    assert.strictEqual(a.pending, 0);
  });

  // ---- Discount creation failures ----

  test('[Redeem] Shopify rejects the discount: points are returned with a reward_return entry', async () => {
    await seedAccount('c1', [{ points: 500, ageDays: 5 }]);
    const rejection = new Error('Shopify rejected the discount: code must be unique');
    rejection.definitive = true;
    gw.injectFailure(rejection);

    const k = key();
    const r = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: k });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'DISCOUNT_FAILED');

    assert.strictEqual((await acct('c1')).available, 500, 'balance restored');
    const redemption = await prisma.redemption.findFirst({ where: { shop } });
    assert.strictEqual(redemption.status, 'failed');
    assert.strictEqual(await prisma.reward.count({ where: { shop } }), 0);

    const types = (await entries('c1')).map((e) => `${e.type}:${e.points}`);
    assert.deepStrictEqual(types, ['earn:500', 'redemption:-500', 'reward_return:500']);

    // The returned points are spendable again, in a fresh lot.
    const returned = await prisma.pointLot.findFirst({ where: { shopifyOrderId: `reward:${redemption.id}` } });
    assert.strictEqual(returned.status, 'active');
    assert.strictEqual(returned.remaining, 500);

    // The failed attempt's key replays the failure; a new key succeeds.
    const replay = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: k });
    assert.strictEqual(replay.reason, 'DISCOUNT_FAILED');
    const retry = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() });
    assert.strictEqual(retry.ok, true);
  });

  test('[Redeem] ambiguous failure and Shopify has no such code: compensated after the lookup', async () => {
    await seedAccount('c1', [{ points: 500, ageDays: 5 }]);
    gw.injectFailure(new Error('socket hang up')); // create fails; the lookup then works and finds nothing

    const r = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() });
    assert.strictEqual(r.reason, 'DISCOUNT_FAILED');
    assert.strictEqual((await acct('c1')).available, 500);
    assert.strictEqual((await entries('c1', 'reward_return')).length, 1);
  });

  test('[Redeem] response lost but Shopify created the code: completed, NOT compensated', async () => {
    await seedAccount('c1', [{ points: 500, ageDays: 5 }]);
    gw.loseNextCreateResponseOnce();

    const r = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 'active');
    assert.ok(gw.discounts.has(r.code));
    assert.strictEqual((await acct('c1')).available, 0, 'points stay spent');
    assert.strictEqual((await entries('c1', 'reward_return')).length, 0);
  });

  test('[Redeem] Shopify unreachable for both the create and the lookup: stays creating, no code shown', async () => {
    await seedAccount('c1', [{ points: 500, ageDays: 5 }]);
    gw.injectFailure(new Error('timeout')); // create
    gw.injectFailure(new Error('timeout')); // lookup

    const r = await redeem({ shop, shopifyCustomerId: 'c1', idempotencyKey: key() });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 'creating');
    assert.strictEqual(r.code, null);
    assert.strictEqual((await acct('c1')).available, 0);
    assert.strictEqual((await prisma.redemption.findFirst({ where: { shop } })).status, 'creating');

    // The resolver settles it once Shopify answers: no code exists -> points back.
    const settled = await resolveRedemption(r.redemptionId);
    assert.strictEqual(settled.reason, 'DISCOUNT_FAILED');
    assert.strictEqual((await acct('c1')).available, 500);
  });

  test('[Redeem] resolver after a crash between commit and the Shopify call: completes if the code exists', async () => {
    // Simulate the crash: committed 'creating' redemption whose code is already in Shopify.
    const { account } = await seedAccount('c1', [{ points: 1, ageDays: 5 }]);
    const redemption = await prisma.redemption.create({
      data: {
        accountId: account.id,
        shop,
        idempotencyKey: key(),
        pointsUsed: 500,
        rewardValuePaise: 5000,
        status: 'creating',
        discountCode: 'REDE-CRASHED1',
        expiresAt: new Date(clock.getTime() + 90 * DAY),
      },
    });
    gw.discounts.set('REDE-CRASHED1', { id: 'gid://shopify/DiscountCodeNode/99' });

    const settled = await resolveRedemption(redemption.id);
    assert.strictEqual(settled.ok, true);
    assert.strictEqual(settled.status, 'active');
    assert.strictEqual(settled.code, 'REDE-CRASHED1');
    assert.strictEqual(await prisma.reward.count({ where: { shop, discountCode: 'REDE-CRASHED1' } }), 1);

    // Settling again changes nothing.
    await resolveRedemption(redemption.id);
    assert.strictEqual(await prisma.reward.count({ where: { shop, discountCode: 'REDE-CRASHED1' } }), 1);
  });

  test('[Redeem] concurrent resolvers compensate once', async () => {
    const { account } = await seedAccount('c1', [{ points: 1, ageDays: 5 }]);
    const redemption = await prisma.redemption.create({
      data: {
        accountId: account.id,
        shop,
        idempotencyKey: key(),
        pointsUsed: 500,
        rewardValuePaise: 5000,
        status: 'creating',
        discountCode: 'REDE-NEVERMADE',
        expiresAt: new Date(clock.getTime() + 90 * DAY),
      },
    });

    await Promise.all([resolveRedemption(redemption.id), resolveRedemption(redemption.id)]);

    assert.strictEqual((await entries('c1', 'reward_return')).length, 1);
    assert.strictEqual((await acct('c1')).available, 1 + 500);
  });
});
