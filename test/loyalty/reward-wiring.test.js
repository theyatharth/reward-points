// test/loyalty/reward-wiring.test.js
//
// Task 6, the ledger side of redemption (fake gateway, fake clock):
//   * orders/paid carrying a reward code marks the Reward and Redemption 'used' and remembers the order
//   * a cancelled or FULLY refunded order returns the reward (restoreRewardOnFullRefund), once
//   * a code voided by a return (D4) is deleted in Shopify afterwards, retried on failure
//   * the redeem flow itself: value from config, customer-bound, single use, expiry from config,
//     replay, compensation when Shopify rejects (the existing paths, exercised end to end)
//
// Config: 500 points buy a 50.00 reward, codes valid 90 days, 1 point per 100 paise, hold 30 days.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import { activateDueLots, deleteVoidedCodes } from '../../web/loyalty/service/jobs.js';
import { redeem } from '../../web/loyalty/service/redemption.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { setFixedTime, restoreClock, now } from '../../web/loyalty/adapters/clock.js';
import { uniqueId } from '../helpers/ids.js';
import { assertLedgerBalances } from '../helpers/invariants.js';

const DAY = 24 * 60 * 60 * 1000;
const C = '10156980011205';

describe('Reward codes on orders and in Shopify', () => {
  let shop = '';
  let gw = null;
  const advance = (days) => setFixedTime(new Date(now().getTime() + days * DAY));

  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });

  beforeEach(async () => {
    shop = `wiring-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    setFixedTime(new Date('2026-09-01T10:00:00Z'));
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
    await prisma.loyaltyConfig.create({
      data: {
        shop, spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, rewardExpiryDays: 90,
        currency: 'INR', holdPeriodDays: 30, ledgerStartAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
  });

  after(async () => {
    restoreClock();
    await prisma.$disconnect();
  });

  // ---- helpers ----

  const acct = () => prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: C } } });
  const reward = () => prisma.reward.findFirst({ where: { shop }, orderBy: { createdAt: 'desc' } });
  const redemption = () => prisma.redemption.findFirst({ where: { shop }, orderBy: { createdAt: 'desc' } });
  const event = (id) => prisma.webhookEvent.findUnique({ where: { id } });
  const audits = (action) => prisma.auditLog.findMany({ where: { shop, action } });
  const ledgerTypes = async () => (await prisma.ledgerEntry.findMany({ where: { accountId: (await acct()).id } })).filter((e) => e.type !== 'activate').map((e) => `${e.type}:${e.points}`).sort();
  const send = async (topic, payload) => {
    const ev = await storeWebhook({ shop, topic, payload, shopifyWebhookId: crypto.randomUUID() });
    await processPendingWebhooks({ shop });
    return event(ev.id);
  };
  const paid = (orderId, over = {}) => ({
    id: orderId, customer: { id: C }, processed_at: now().toISOString(),
    line_items: [{ id: 1, quantity: 1, price: '500', title: 'Item' }], ...over,
  });

  /** Earns 500, activates it and redeems it: one active code, 0 points. */
  async function redeemedCode() {
    const orderId = uniqueId();
    await send('orders/paid', paid(orderId));
    gw.addOrder({ id: orderId, processed_at: now().toISOString(), refunds: [] });
    advance(31);
    assert.strictEqual((await activateDueLots({ shop })).activated, 1);
    const r = await redeem({ shop, shopifyCustomerId: C, idempotencyKey: crypto.randomUUID() });
    assert.strictEqual(r.ok, true);
    return { code: r.code, sourceOrderId: orderId };
  }
  /** A new order (units of 100.00 each) that pays with `code`. */
  async function orderUsing(code, { units = 1, lines, codes } = {}) {
    const orderId = uniqueId();
    const ev = await send('orders/paid', paid(orderId, {
      line_items: lines ?? [{ id: 11, quantity: units, price: '100', title: 'Item' }],
      discount_codes: codes ?? [{ code, amount: '50.00', type: 'fixed_amount' }],
    }));
    return { orderId, ev };
  }
  const refundOf = (orderId, lineId, quantity) => send('refunds/create', {
    id: uniqueId(), order_id: orderId, refund_line_items: [{ line_item_id: lineId, quantity }],
  });

  // ===================== the redeem flow =====================

  test('redeem: value from config, customer-bound, single use, expiry from config', async () => {
    await redeemedCode();
    const [d] = [...gw.discounts.values()];
    assert.strictEqual(d.amount, '50.00', 'rewardValue 5000 paise');
    assert.strictEqual(d.customerId, C, 'bound to the redeeming customer');
    assert.strictEqual(d.endsAt.getTime() - d.startsAt.getTime(), 90 * DAY, 'rewardExpiryDays');
    assert.match(d.code, /^WIRI-[A-Z2-9]{8}$/);
    const r = await reward();
    assert.strictEqual(r.discountCode, d.code);
    assert.strictEqual(r.status, 'active');
    assert.strictEqual(r.discountCodeId, d.id);
  });

  // ===================== marking a code used =====================

  test('orders/paid with the code marks Reward and Redemption used, remembers the order, and still earns points', async () => {
    const { code } = await redeemedCode();
    const { orderId, ev } = await orderUsing(code);
    assert.strictEqual(ev.status, 'processed', ev.lastError ?? '');
    const r = await reward();
    assert.deepStrictEqual([r.status, r.usedOrderId], ['used', String(orderId)]);
    assert.ok(r.usedAt);
    assert.strictEqual((await redemption()).status, 'used');
    assert.strictEqual((await acct()).pending, 100, 'the order earned its own 100 points');
    await assertLedgerBalances(prisma, (await acct()).id);
  });

  test('the code is matched case-insensitively, and a redelivered paid event changes nothing', async () => {
    const { code } = await redeemedCode();
    const { orderId } = await orderUsing(code, { codes: [{ code: code.toLowerCase(), amount: '50.00' }] });
    assert.strictEqual((await reward()).status, 'used');
    // The same order delivered again (different webhook id): skipped as a duplicate, reward unchanged.
    const again = await send('orders/paid', paid(orderId, { line_items: [{ id: 11, quantity: 1, price: '100' }], discount_codes: [{ code }] }));
    assert.strictEqual(again.status, 'skipped');
    assert.strictEqual((await reward()).usedOrderId, String(orderId));
    assert.strictEqual((await audits('reward_used_twice')).length, 0, 'the same order is not a second use');
  });

  test('an ordinary coupon is ignored; a 100% discounted order that earns nothing still marks the code used', async () => {
    const { code } = await redeemedCode();
    const plain = await orderUsing(null, { codes: [{ code: 'SUMMER10', amount: '10.00' }] });
    assert.strictEqual(plain.ev.status, 'processed');
    assert.strictEqual((await reward()).status, 'active', 'SUMMER10 is not ours');

    const free = await orderUsing(code, { lines: [{ id: 5, quantity: 1, price: '0.00' }] });
    assert.strictEqual(free.ev.status, 'skipped', 'zero eligible value earns nothing');
    assert.strictEqual((await reward()).status, 'used', 'but the code was used');
  });

  test('a code used by a different customer than its owner is not marked, and the anomaly is logged', async () => {
    const { code } = await redeemedCode();
    const orderId = uniqueId();
    await send('orders/paid', paid(orderId, { customer: { id: '999' }, discount_codes: [{ code }], line_items: [{ id: 1, quantity: 1, price: '100' }] }));
    assert.strictEqual((await reward()).status, 'active');
    assert.strictEqual((await audits('reward_used_by_other_customer')).length, 1);
  });

  test('a second order carrying an already used code is logged, and the first use stands', async () => {
    const { code } = await redeemedCode();
    const first = await orderUsing(code);
    await orderUsing(code);
    assert.strictEqual((await reward()).usedOrderId, String(first.orderId));
    assert.strictEqual((await audits('reward_used_twice')).length, 1);
  });

  test('a code used just after it expired or was voided is marked used and the anomaly is logged (no automatic claw-back)', async () => {
    const { code } = await redeemedCode();
    await prisma.reward.updateMany({ where: { shop }, data: { status: 'expired' } });
    await prisma.redemption.updateMany({ where: { shop }, data: { status: 'expired' } });
    await orderUsing(code);
    assert.strictEqual((await reward()).status, 'used');
    assert.strictEqual((await redemption()).status, 'used');
    assert.strictEqual((await audits('reward_used_after_expired')).length, 1);
  });

  // ===================== restoring on cancel / full refund =====================

  test('cancelling the order that used a code returns the reward: points back, Reward and Redemption returned', async () => {
    const { code } = await redeemedCode();
    const { orderId } = await orderUsing(code);
    assert.strictEqual((await acct()).available, 0);

    const ev = await send('orders/cancelled', { id: orderId });
    assert.strictEqual(ev.status, 'processed', ev.lastError ?? '');
    const a = await assertLedgerBalances(prisma, (await acct()).id);
    assert.deepStrictEqual([a.available, a.pending, a.debt], [500, 0, 0], 'the order\'s 100 pending points cancelled, the reward\'s 500 returned');
    assert.strictEqual((await reward()).status, 'returned');
    assert.strictEqual((await redemption()).status, 'returned');
    assert.deepStrictEqual(await ledgerTypes(), ['cancel:-100', 'earn:100', 'earn:500', 'redemption:-500', 'reward_return:500']);

    const again = await send('orders/cancelled', { id: orderId });
    assert.strictEqual(again.status, 'skipped');
    assert.strictEqual((await acct()).available, 500, 'returned once');
  });

  test('a FULL refund returns the reward; a partial one does not; the refund that completes it does', async () => {
    const { code } = await redeemedCode();
    const { orderId } = await orderUsing(code, { units: 2 });
    await refundOf(orderId, 11, 1);
    assert.strictEqual((await reward()).status, 'used', 'half the order refunded: not restored');
    assert.strictEqual((await acct()).available, 0);

    await refundOf(orderId, 11, 1);
    assert.strictEqual((await reward()).status, 'returned', 'the whole order is refunded now');
    const a = await assertLedgerBalances(prisma, (await acct()).id);
    assert.deepStrictEqual([a.available, a.pending, a.debt], [500, 0, 0]);
  });

  test('a full refund then a cancel (or the other way round) returns the reward only once', async () => {
    const { code } = await redeemedCode();
    const { orderId } = await orderUsing(code);
    await refundOf(orderId, 11, 1);
    await send('orders/cancelled', { id: orderId });
    assert.strictEqual((await prisma.ledgerEntry.count({ where: { accountId: (await acct()).id, type: 'reward_return' } })), 1);
    assert.strictEqual((await acct()).available, 500);
    await assertLedgerBalances(prisma, (await acct()).id);
  });

  test('"fully refunded" counts every line, a gift card included: refunding only the other line does not restore', async () => {
    const { code } = await redeemedCode();
    const lines = [{ id: 21, quantity: 1, price: '100' }, { id: 22, quantity: 1, price: '10', gift_card: true }];
    const { orderId } = await orderUsing(code, { lines });
    await refundOf(orderId, 21, 1);
    assert.strictEqual((await reward()).status, 'used');
    await refundOf(orderId, 22, 1);
    assert.strictEqual((await reward()).status, 'returned');
  });

  test('with restoreRewardOnFullRefund OFF nothing is returned', async () => {
    await prisma.loyaltyConfig.update({ where: { shop }, data: { restoreRewardOnFullRefund: false } });
    const { code } = await redeemedCode();
    const { orderId } = await orderUsing(code);
    await send('orders/cancelled', { id: orderId });
    assert.strictEqual((await reward()).status, 'used');
    assert.strictEqual((await acct()).available, 0);
  });

  test('a cancelled order that used no reward returns nothing', async () => {
    const orderId = uniqueId();
    await send('orders/paid', paid(orderId));
    await send('orders/cancelled', { id: orderId });
    assert.strictEqual(await prisma.ledgerEntry.count({ where: { accountId: (await acct()).id, type: 'reward_return' } }), 0);
  });

  test('the returned reward repays an owed balance first', async () => {
    const { code } = await redeemedCode();
    const { orderId } = await orderUsing(code);
    await prisma.loyaltyAccount.update({ where: { id: (await acct()).id }, data: { debt: 200 } });
    await send('orders/cancelled', { id: orderId });
    const a = await acct();
    assert.deepStrictEqual([a.available, a.debt], [300, 0]);
  });

  // ===================== a voided code is deleted in Shopify =====================

  /** A customer whose only code is unused and whose source order is then fully refunded (D4 voids the code). */
  async function voidedCode() {
    const { code, sourceOrderId } = await redeemedCode();
    const ev = await refundOf(sourceOrderId, 1, 1);
    assert.strictEqual(ev.status, 'processed', ev.lastError ?? '');
    return code;
  }

  test('D4 void: the code is flagged, then deleted in Shopify by the job, and the points are not owed', async () => {
    const code = await voidedCode();
    const r = await reward();
    assert.deepStrictEqual([r.status, r.needsShopifyDelete, r.shopifyDeletedAt], ['returned', true, null]);
    assert.ok(gw.discounts.has(code), 'still in Shopify until the job runs');
    const a = await assertLedgerBalances(prisma, (await acct()).id);
    assert.deepStrictEqual([a.available, a.debt], [0, 0]);

    assert.deepStrictEqual(await deleteVoidedCodes({ shop }), { due: 1, deleted: 1, failed: [] });
    assert.ok(!gw.discounts.has(code), 'deleted in Shopify');
    const after = await reward();
    assert.strictEqual(after.needsShopifyDelete, false);
    assert.ok(after.shopifyDeletedAt);
    assert.deepStrictEqual(await deleteVoidedCodes({ shop }), { due: 0, deleted: 0, failed: [] }, 'once');
  });

  test('a failed Shopify delete leaves the flag and is retried', async () => {
    const code = await voidedCode();
    gw.injectFailure(new Error('Shopify is down'));
    const r1 = await deleteVoidedCodes({ shop });
    assert.strictEqual(r1.deleted, 0);
    assert.match(r1.failed[0].reason, /Shopify is down/);
    assert.strictEqual((await reward()).needsShopifyDelete, true);
    assert.ok(gw.discounts.has(code));

    assert.strictEqual((await deleteVoidedCodes({ shop })).deleted, 1);
    assert.ok(!gw.discounts.has(code));
  });

  test('a code that was never created in Shopify (no id) is just cleared', async () => {
    await voidedCode();
    await prisma.reward.updateMany({ where: { shop }, data: { discountCodeId: '' } });
    assert.strictEqual((await deleteVoidedCodes({ shop })).deleted, 1);
    assert.strictEqual((await reward()).needsShopifyDelete, false);
    assert.strictEqual(gw.deletedDiscountIds, undefined, 'no Shopify call');
  });

  // ===================== compensation (existing paths, end to end) =====================

  test('Shopify rejects the discount: no code, points returned, a replay says so', async () => {
    const orderId = uniqueId();
    await send('orders/paid', paid(orderId));
    gw.addOrder({ id: orderId, processed_at: now().toISOString(), refunds: [] });
    advance(31);
    await activateDueLots({ shop });
    const rejection = new Error('Shopify rejected the discount: code must be unique');
    rejection.definitive = true;
    gw.injectFailure(rejection);
    const key = crypto.randomUUID();
    const r = await redeem({ shop, shopifyCustomerId: C, idempotencyKey: key });
    assert.strictEqual(r.reason, 'DISCOUNT_FAILED');
    const a = await assertLedgerBalances(prisma, (await acct()).id);
    assert.strictEqual(a.available, 500);
    assert.strictEqual(gw.discounts.size, 0);
    assert.strictEqual((await redeem({ shop, shopifyCustomerId: C, idempotencyKey: key })).reason, 'DISCOUNT_FAILED');
  });

  test('replaying a used or returned redemption never hands the code out again', async () => {
    const { code } = await redeemedCode();
    const key = (await redemption()).idempotencyKey;
    const { orderId } = await orderUsing(code);
    const used = await redeem({ shop, shopifyCustomerId: C, idempotencyKey: key });
    assert.strictEqual(used.reason, 'REWARD_USED');
    assert.strictEqual(used.code, undefined);
    await send('orders/cancelled', { id: orderId });
    assert.strictEqual((await redeem({ shop, shopifyCustomerId: C, idempotencyKey: key })).reason, 'REWARD_RETURNED');
  });
});
