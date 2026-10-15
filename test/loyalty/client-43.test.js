// test/loyalty/client-43.test.js
//
// The client's 43 edge-case tests (docs/reference/tests.js, BRD section 73), one test each, with the client's own group
// and name, run against THIS system. Status after each name (also in docs/CLIENT-TESTS.md):
//   WORKING  the behaviour exists and the test checks the client's scenario with the client's numbers
//   PARTIAL  it exists in a different form (the comment says how); the test checks our form
//   NOT BUILT  skipped, with the reason
// Counts: 31 working, 5 partial, 7 not built.
//
// Config used unless a test changes it: 1 point per 100 paise (INR), 500 points = 50.00 (client's 500/₹50 case),
// 30-day hold, codes valid 90 days. Orders are built the way Shopify sends them (line ids, quantities).

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import { activateDueLots, expireUnusedCodes } from '../../web/loyalty/service/jobs.js';
import { redeem } from '../../web/loyalty/service/redemption.js';
import { adjustPoints } from '../../web/loyalty/service/adjustment.js';
import { saveRules } from '../../web/admin/data/rules.js';
import { reconcileAccount, rebuildCache } from '../../web/loyalty/service/reconcile.js';
import { customerView } from '../../web/loyalty/service/storefront.js';
import { multiplyPoints } from '../../web/loyalty/rules/money.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { setFixedTime, restoreClock, now } from '../../web/loyalty/adapters/clock.js';
import { uniqueId } from '../helpers/ids.js';
import { assertLedgerBalances, assertShopInvariants } from '../helpers/invariants.js';

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const U1 = 'u1';

describe('The client\'s 43 edge-case tests', () => {
  let shop;
  let gw;
  let adminId;

  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });
  after(async () => {
    restoreClock();
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    shop = `c43-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    setFixedTime(new Date('2026-09-01T10:00:00Z'));
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
    await prisma.loyaltyConfig.create({
      data: { shop, spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, rewardExpiryDays: 90, currency: 'INR', holdPeriodDays: 30, ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
    });
    adminId = (await prisma.adminUser.create({ data: { shop, email: `qa-${crypto.randomUUID()}@example.test`, passwordHash: 'x' } })).id;
  });

  // ---- helpers ----

  const config = (data) => prisma.loyaltyConfig.update({ where: { shop }, data });
  const advance = (ms) => setFixedTime(new Date(now().getTime() + ms));
  const acct = (id = U1) => prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: id } } });
  const balances = async (id = U1) => { const a = await acct(id); return a ? { available: a.available, pending: a.pending, debt: a.debt } : { available: 0, pending: 0, debt: 0 }; };
  const entries = async (id = U1, type) => prisma.ledgerEntry.findMany({ where: { accountId: (await acct(id)).id, ...(type ? { type } : {}) }, orderBy: { createdAt: 'asc' } });
  const send = (topic, payload, webhookId = crypto.randomUUID()) => storeWebhook({ shop, topic, payload, shopifyWebhookId: webhookId });
  const run = () => processPendingWebhooks({ shop });

  /** An order as Shopify sends it. lines: [{ id, qty, price, giftCard, discount, tax }] */
  async function paid(customer, lines, over = {}) {
    const orderId = over.orderId ?? uniqueId();
    const payload = {
      id: orderId, name: `#${orderId % 10000}`, customer: customer ? { id: customer } : undefined, processed_at: now().toISOString(), taxes_included: false,
      line_items: lines.map((l, i) => ({
        id: l.id ?? i + 1, quantity: l.qty ?? 1, price: String(l.price), title: 'Item', gift_card: l.giftCard === true,
        discount_allocations: l.discount ? [{ amount: String(l.discount) }] : [], tax_lines: l.tax ? [{ price: String(l.tax), title: 'GST', rate: 0.05 }] : [],
      })),
      discount_codes: over.codes ?? [],
      ...over.extra,
    };
    const ev = await send('orders/paid', payload, over.webhookId);
    await run();
    gw.addOrder({ id: orderId, processed_at: payload.processed_at, refunds: [] });
    return { orderId, payload, event: ev };
  }
  const activate = async () => { advance(31 * DAY); return activateDueLots({ shop }); };
  async function earnActive(points, customer = U1) { const o = await paid(customer, [{ price: points }]); await activate(); return o; }
  const refund = async (orderId, lineId, qty, id = uniqueId()) => {
    const ev = await send('refunds/create', { id, order_id: orderId, refund_line_items: [{ line_item_id: lineId, quantity: qty }] });
    await run();
    return { id, ev };
  };
  const doRedeem = (customer = U1, key = crypto.randomUUID()) => redeem({ shop, shopifyCustomerId: customer, idempotencyKey: key });
  const adjust = (points, reason, note, over = {}) => adjustPoints({ shop, shopifyCustomerId: U1, points, reason, note, adminId, idempotencyKey: crypto.randomUUID(), ...over });
  const eventRow = (id) => prisma.webhookEvent.findUnique({ where: { id } });

  // ================================ Customers ================================

  test('[Customers] New customer gets exactly one loyalty account — WORKING', async () => {
    await paid(U1, [{ price: 100 }]);
    await paid(U1, [{ price: 100 }]);
    assert.strictEqual(await prisma.loyaltyAccount.count({ where: { shop, shopifyCustomerId: U1 } }), 1);
  });

  test('[Customers] Returning customer: each order earns its own ledger entry — WORKING', async () => {
    await paid(U1, [{ price: 659 }]);
    await paid(U1, [{ price: 659 }]);
    assert.strictEqual((await entries(U1, 'earn')).length, 2);
    assert.strictEqual((await balances()).pending, 1318);
  });

  test('[Customers] Zero points: no rewards affordable, next reward is the smallest — PARTIAL (one reward rule, no catalogue: the "next reward" is that rule)', async () => {
    const view = await customerView({ shop, shopifyCustomerId: U1 });
    assert.deepStrictEqual(view.balance, { available: 0, pending: 0, owed: 0 });
    assert.strictEqual(Math.floor(view.balance.available / view.rule.pointsPerReward), 0, 'nothing affordable');
    assert.strictEqual(view.rule.pointsPerReward - view.balance.available, 500, 'the gap to the (only) reward');
  });

  test.skip('[Customers] Duplicate customer (same email) reuses the existing account — NOT BUILT (decision D5: no e-mail anywhere; identity is the Shopify customer id)');

  test.skip('[Customers] Guest checkout holds points; account creation claims them with the original date — NOT BUILT (decision D5: a guest order has no customer id and earns nothing)');

  // ================================== Earning ================================

  test('[Earning] Earning rule is configurable (₹100 → 50 points) — WORKING', async () => {
    await config({ spendAmountPaise: 10000, pointsPerUnit: 50 });
    await paid(U1, [{ price: 659 }]);
    assert.strictEqual((await balances()).pending, 329, '₹659 -> 329');
  });

  test('[Earning] Rounding: ₹149 → 149 (proportional), 100 (per full ₹100 block), 150 when ₹149.5 rounds — WORKING', () => {
    assert.strictEqual(multiplyPoints(14900, 100, 10000, 'floor'), 149);
    assert.strictEqual(multiplyPoints(14900, 100, 10000, 'block'), 100);
    assert.strictEqual(multiplyPoints(14950, 100, 10000, 'round'), 150);
  });

  test('[Earning] Eligible value excludes gift cards, shipping and GST; uses price after discount — PARTIAL (we use Shopify\'s real discount allocations, which never touch a gift card: 559, not the client\'s proportional 619; documented in COMPARISON.md)', async () => {
    // ₹659 shears + ₹1,000 gift card, a ₹100 discount (Shopify allocates it to the shears only), ₹79 shipping.
    await paid(U1, [{ id: 1, price: 659, discount: 100 }, { id: 2, price: 1000, giftCard: true }], { extra: { shipping_lines: [{ price: '79.00' }] } });
    assert.strictEqual((await balances()).pending, 559);
  });

  test('[Earning] GST-inclusive price: ₹419 at 5% GST earns on ₹399.05 — WORKING', async () => {
    await config({ taxHandling: 'inclusive' });
    await paid(U1, [{ price: 419, tax: '19.95' }], { extra: { taxes_included: true } });
    assert.strictEqual((await balances()).pending, 399);
  });

  // ================================= Lifecycle ===============================

  test('[Lifecycle] Purchase points start pending with the holding-period date — WORKING', async () => {
    await paid(U1, [{ price: 659 }]);
    const b = await balances();
    assert.deepStrictEqual([b.pending, b.available], [659, 0]);
    const lot = await prisma.pointLot.findFirst({ where: { account: { shop } } });
    assert.strictEqual(lot.activatesAt.toISOString(), '2026-10-01T10:00:00.000Z', '30 days after the order');
  });

  test('[Lifecycle] Points activate after the holding period (not a day before) — WORKING', async () => {
    await paid(U1, [{ price: 659 }]);
    advance(29 * DAY);
    assert.strictEqual((await activateDueLots({ shop })).activated, 0, 'day 29');
    advance(DAY + MIN);
    assert.strictEqual((await activateDueLots({ shop })).activated, 1, 'day 30');
    assert.deepStrictEqual(await balances(), { available: 659, pending: 0, debt: 0 });
  });

  test('[Lifecycle] Holding period 0 days → available immediately — PARTIAL (the order still starts pending; the worker activates it on its next tick, within a minute)', async () => {
    await config({ holdPeriodDays: 0 });
    await paid(U1, [{ price: 659 }]);
    assert.strictEqual((await balances()).pending, 659);
    assert.strictEqual((await activateDueLots({ shop })).activated, 1);
    assert.deepStrictEqual(await balances(), { available: 659, pending: 0, debt: 0 });
  });

  test.skip('[Lifecycle] Expired points: expire 12 months after activation, with a ledger entry — NOT BUILT (lot expiry stays off by decision)');

  test.skip('[Lifecycle] Expiry takes oldest points first; redeemed points are not expired again — NOT BUILT (lot expiry stays off by decision)');

  // ============================ Returns & refunds ============================

  test('[Returns & refunds] Full return before activation cancels pending points — WORKING', async () => {
    const o = await paid(U1, [{ price: 659 }]);
    await refund(o.orderId, 1, 1);
    assert.deepStrictEqual(await balances(), { available: 0, pending: 0, debt: 0 });
  });

  test('[Returns & refunds] Full return after activation creates a linked reversal — WORKING', async () => {
    const o = await earnActive(659);
    const r = await refund(o.orderId, 1, 1);
    assert.deepStrictEqual(await balances(), { available: 0, pending: 0, debt: 0 });
    const [e] = await entries(U1, 'refund');
    assert.strictEqual(e.points, -659);
    const lo = await prisma.loyaltyOrder.findFirst({ where: { shop, shopifyOrderId: String(o.orderId) } });
    const lr = await prisma.loyaltyRefund.findFirst({ where: { shop, shopifyRefundId: String(r.id) } });
    assert.deepStrictEqual([e.orderId, e.refundId], [lo.id, lr.id], 'linked to its order and its refund');
  });

  test('[Returns & refunds] Partial return reverses only the returned share (₹500 of ₹2,000) — WORKING (by line identity, D1: one of four ₹500 units)', async () => {
    const o = await paid(U1, [{ qty: 4, price: 500 }]);
    await refund(o.orderId, 1, 1);
    assert.strictEqual((await balances()).pending, 1500, '500 of 2,000 reversed');
  });

  test('[Returns & refunds] Multiple refunds (3 × ₹333 on ₹999) reverse exactly the points earned — WORKING (three units of ₹333)', async () => {
    const o = await paid(U1, [{ qty: 3, price: 333 }]);
    const left = [];
    for (let i = 0; i < 3; i++) { await refund(o.orderId, 1, 1); left.push((await balances()).pending); }
    assert.deepStrictEqual(left, [666, 333, 0]);
  });

  test('[Returns & refunds] Same refund delivered twice is applied once — WORKING', async () => {
    const o = await paid(U1, [{ qty: 2, price: 100 }]);
    const id = uniqueId();
    await refund(o.orderId, 1, 1, id);
    await refund(o.orderId, 1, 1, id); // a second delivery of the same refund
    assert.strictEqual((await balances()).pending, 100);
  });

  test('[Returns & refunds] Cancellation cancels pending points — WORKING', async () => {
    const o = await paid(U1, [{ price: 659 }]);
    await send('orders/cancelled', { id: o.orderId });
    await run();
    assert.strictEqual((await balances()).pending, 0);
  });

  test('[Returns & refunds] Negative balance: reward already used, return creates an owed balance that later earnings repay — WORKING', async () => {
    const first = await earnActive(500);
    await doRedeem();
    await prisma.reward.updateMany({ where: { shop }, data: { status: 'used', usedAt: now() } }); // the code was used on an order
    await refund(first.orderId, 1, 1);
    assert.deepStrictEqual(await balances(), { available: 0, pending: 0, debt: 500 }, 'owed, never negative');
    const refused = await doRedeem();
    assert.strictEqual(refused.reason, 'OWED');
    await earnActive(700);
    assert.deepStrictEqual(await balances(), { available: 200, pending: 0, debt: 0 }, '700 earned: 500 repaid the debt first');
    await assertLedgerBalances(prisma, (await acct()).id);
  });

  test('[Returns & refunds] Unused reward is voided before creating an owed balance — WORKING', async () => {
    const first = await earnActive(500);
    await doRedeem();
    await refund(first.orderId, 1, 1);
    assert.deepStrictEqual(await balances(), { available: 0, pending: 0, debt: 0 }, 'nothing owed');
    assert.strictEqual((await prisma.reward.findFirst({ where: { shop } })).status, 'returned');
    await assertLedgerBalances(prisma, (await acct()).id);
  });

  // ================================= Webhooks ================================

  test('[Webhooks] Duplicate webhook (same event id) awards points once — WORKING', async () => {
    const webhookId = `wh-${crypto.randomUUID()}`; // unique per run: webhook ids are global and the database persists
    const o = await paid(U1, [{ price: 659 }], { webhookId });
    const again = await send('orders/paid', o.payload, webhookId);
    assert.strictEqual(again.id, o.event.id, 'the same stored event');
    await run();
    assert.strictEqual((await balances()).pending, 659);
  });

  test('[Webhooks] Same order via a different event id is still awarded once — WORKING', async () => {
    const o = await paid(U1, [{ price: 659 }]);
    const dup = await send('orders/paid', o.payload);
    await run();
    assert.strictEqual((await eventRow(dup.id)).status, 'skipped');
    assert.strictEqual((await balances()).pending, 659);
  });

  test('[Webhooks] Failed webhook is kept, visible, and retried without duplicates — WORKING', async () => {
    await config({ excludedCollectionIds: ['900001'] });
    gw.injectFailure(new Error('Simulated Shopify outage')); // the collection lookup fails once
    const o = await paid(U1, [{ price: 659 }]);
    let ev = await eventRow(o.event.id);
    assert.deepStrictEqual([ev.status, ev.attempts], ['failed', 1]);
    assert.match(ev.lastError, /Collection lookup failed/, 'visible');
    assert.ok(ev.nextRetryAt > now());
    advance(2 * MIN);
    await run();
    ev = await eventRow(o.event.id);
    assert.strictEqual(ev.status, 'processed');
    assert.strictEqual((await entries(U1, 'earn')).length, 1, 'one entry, not two');
    assert.strictEqual((await balances()).pending, 659);
  });

  test('[Webhooks] Refund arriving before its order is queued, then applied on retry — WORKING', async () => {
    const orderId = uniqueId();
    gw.addOrder({ id: orderId, processed_at: now().toISOString() });
    const ev = await send('refunds/create', { id: uniqueId(), order_id: orderId, refund_line_items: [{ line_item_id: 1, quantity: 1 }] });
    await run();
    assert.strictEqual((await eventRow(ev.id)).status, 'failed', 'queued, not skipped');
    await paid(U1, [{ qty: 2, price: 100 }], { orderId });
    advance(2 * MIN);
    await run();
    assert.strictEqual((await eventRow(ev.id)).status, 'processed');
    assert.strictEqual((await balances()).pending, 100);
  });

  // =============================== Redemption ================================

  test('[Redemption] Exactly enough points (500) redeems ₹50 OFF and leaves 0 — WORKING', async () => {
    await earnActive(500);
    const r = await doRedeem();
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual([r.pointsUsed, r.valuePaise, r.available], [500, 5000, 0]);
    const [d] = [...gw.discounts.values()];
    assert.strictEqual(d.amount, '50.00');
  });

  test('[Redemption] Insufficient points (499) is refused with the gap — WORKING', async () => {
    await earnActive(499);
    const r = await doRedeem();
    assert.deepStrictEqual([r.ok, r.reason, r.needed], [false, 'SHORT', 1]);
    assert.strictEqual(gw.discounts.size, 0);
  });

  test('[Redemption] Double-tap on Redeem (same request key) debits once — WORKING', async () => {
    await earnActive(1000);
    const key = crypto.randomUUID();
    const a = await doRedeem(U1, key);
    const b = await doRedeem(U1, key);
    assert.strictEqual(a.code, b.code);
    assert.strictEqual(gw.discounts.size, 1);
    assert.strictEqual((await balances()).available, 0, 'debited once (both chunks, one code)');
    assert.strictEqual((await entries(U1, 'redemption')).length, 1);
  });

  test('[Redemption] Simultaneous redemptions from two browser sessions: only one succeeds — WORKING', async () => {
    await earnActive(500);
    const [a, b] = await Promise.all([doRedeem(), doRedeem()]);
    assert.deepStrictEqual([a.ok, b.ok].sort(), [false, true]);
    assert.strictEqual(gw.discounts.size, 1);
    assert.strictEqual((await balances()).available, 0);
  });

  test('[Redemption] Reward already used cannot be applied again — PARTIAL (we mark the reward used from orders/paid and refuse a replay; refusing a second CHECKOUT is Shopify\'s: the code is created single use)', async () => {
    const r = await earnActive(500).then(() => doRedeem());
    const used = await paid(U1, [{ price: 100 }], { codes: [{ code: r.code, amount: '50.00' }] });
    assert.strictEqual((await prisma.reward.findFirst({ where: { shop } })).status, 'used');
    const second = await paid(U1, [{ price: 100 }], { codes: [{ code: r.code, amount: '50.00' }] });
    assert.strictEqual((await prisma.reward.findFirst({ where: { shop } })).usedOrderId, String(used.orderId), 'the first use stands');
    assert.strictEqual(await prisma.auditLog.count({ where: { shop, action: 'reward_used_twice' } }), 1, 'the second is logged');
    void second;
    const key = (await prisma.redemption.findFirst({ where: { shop } })).idempotencyKey;
    assert.strictEqual((await doRedeem(U1, key)).reason, 'REWARD_USED');
  });

  test.skip('[Redemption] Minimum cart value is enforced server-side — NOT BUILT (the single redemption rule has no minimum cart; there is no reward catalogue)');

  test('[Redemption] Another customer\'s code is refused — PARTIAL (the code is created bound to its customer in Shopify, which refuses it at checkout; if an order still carries it, we do not mark it used and log the anomaly)', async () => {
    const r = await earnActive(500).then(() => doRedeem());
    const [d] = [...gw.discounts.values()];
    assert.strictEqual(d.customerId, U1, 'bound to its owner in Shopify');
    await paid('someone-else', [{ price: 100 }], { codes: [{ code: r.code, amount: '50.00' }] });
    assert.strictEqual((await prisma.reward.findFirst({ where: { shop } })).status, 'active', 'not used by the other customer');
    assert.strictEqual(await prisma.auditLog.count({ where: { shop, action: 'reward_used_by_other_customer' } }), 1);
  });

  test('[Redemption] Expired reward code returns its points — WORKING (when returnPointsOnCodeExpiry is on)', async () => {
    await config({ returnPointsOnCodeExpiry: true });
    await earnActive(500);
    const r = await doRedeem();
    assert.strictEqual(r.ok, true);
    advance(91 * DAY);
    assert.deepStrictEqual(await expireUnusedCodes({ shop }), { due: 1, expired: 1, pointsReturned: 500 });
    assert.strictEqual((await prisma.reward.findFirst({ where: { shop } })).status, 'expired');
    assert.strictEqual((await balances()).available, 500);
  });

  test('[Redemption] Cancelling an order that used a reward returns the reward\'s points — WORKING', async () => {
    await earnActive(500);
    const r = await doRedeem();
    const o = await paid(U1, [{ price: 100 }], { codes: [{ code: r.code, amount: '50.00' }] });
    await send('orders/cancelled', { id: o.orderId });
    await run();
    assert.deepStrictEqual(await balances(), { available: 500, pending: 0, debt: 0 });
  });

  // ================================== Admin ==================================

  test('[Admin] Manual adjustment needs amount, reason, note and admin; it lands in ledger and audit log — WORKING', async () => {
    await paid(U1, [{ price: 100 }]);
    const bad = await adjust(200, 'Customer service goodwill', '');
    assert.strictEqual(bad.ok, false);
    assert.strictEqual((await adjust(0, 'Customer service goodwill', 'a valid note')).ok, false);
    assert.strictEqual((await adjust(5, '', 'a valid note')).ok, false);
    assert.strictEqual((await adjust(5, 'Customer service goodwill', 'a valid note', { adminId: undefined })).ok, false);
    const good = await adjust(200, 'Customer service goodwill', 'Delayed delivery apology');
    assert.strictEqual(good.ok, true);
    assert.ok((await entries(U1, 'adjustment')).length === 1);
    assert.strictEqual(await prisma.auditLog.count({ where: { shop, action: 'points_adjusted', adminId } }), 1);
  });

  test('[Admin] Deduction larger than the available balance is refused — WORKING', async () => {
    await paid(U1, [{ price: 100 }]);
    await adjust(100, 'Customer service goodwill', 'setup deduct');
    const r = await adjust(-300, 'Order issue correction', 'Wrong order credit');
    assert.deepStrictEqual([r.ok, r.reason], [false, 'EXCEEDS_AVAILABLE']);
    assert.strictEqual((await balances()).available, 100);
  });

  const saveRule = async (changes) => saveRules({ shop, adminId, ip: '127.0.0.1', body: { expected: (await prisma.loyaltyConfig.findUnique({ where: { shop } })).updatedAt.toISOString(), changes } });

  test('[Admin] Invalid rule (₹0 spend) is refused and the live rule is unchanged — WORKING (Rules page editing; the database check is a second guard)', async () => {
    const r = await saveRule({ spend: '0' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.field, 'spend');
    assert.strictEqual((await prisma.loyaltyConfig.findUnique({ where: { shop } })).spendAmountPaise, 100);
    await assert.rejects(config({ spendAmountPaise: 0 }), /check constraint|spendAmountPaise/i);
  });

  test('[Admin] Rule change is recorded with previous and new value — WORKING (one audit row per save)', async () => {
    const r = await saveRule({ holdPeriodDays: 7, spend: '2.50' });
    assert.strictEqual(r.status, 200);
    const audit = await prisma.auditLog.findFirst({ where: { shop, action: 'rules_changed' } });
    assert.strictEqual(audit.adminId, adminId);
    assert.deepStrictEqual(audit.detail.changes.map((c) => [c.field, c.previous, c.next]), [['spend', '1.00', '2.50'], ['holdPeriodDays', 30, 7]]);
    assert.deepStrictEqual([(await prisma.loyaltyConfig.findUnique({ where: { shop } })).holdPeriodDays], [7]);
  });

  test.skip('[Admin] Invalid reward (value above min cart) is refused — NOT BUILT (no reward catalogue, no minimum cart)');

  // ================================ Integrity ================================

  test('[Integrity] Reconciliation is clean after a busy scenario — WORKING', async () => {
    const a = await earnActive(1000);
    await doRedeem();
    await refund(a.orderId, 1, 1);
    const b = await paid('u2', [{ qty: 2, price: 250 }]);
    await refund(b.orderId, 1, 1);
    await paid('u3', [{ price: 300 }]).then((o) => send('orders/cancelled', { id: o.orderId }));
    await run();
    await adjust(40, 'Missing points', 'busy scenario');
    for (const { id } of await prisma.loyaltyAccount.findMany({ where: { shop }, select: { id: true } })) assert.deepStrictEqual(await reconcileAccount(id), []);
    await assertShopInvariants(prisma, shop);
  });

  test('[Integrity] Reconciliation detects a drifted cached balance; rebuild fixes it from the ledger — WORKING', async () => {
    await earnActive(500);
    const a = await acct();
    await prisma.loyaltyAccount.update({ where: { id: a.id }, data: { available: 999 } });
    const found = await reconcileAccount(a.id);
    assert.ok(found.some((d) => d.code === 'available_mismatch'));
    assert.strictEqual((await rebuildCache(a.id)).changed, true);
    assert.deepStrictEqual(await reconcileAccount(a.id), []);
    assert.strictEqual((await balances()).available, 500);
  });

  test.skip('[Integrity] Future campaign: 2× points only inside its window, capped at max bonus — NOT BUILT (campaigns are off by design in Phase 1)');
});
