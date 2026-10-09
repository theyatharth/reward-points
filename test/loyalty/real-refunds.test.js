// test/loyalty/real-refunds.test.js
//
// The REAL captured refunds/create and orders/cancelled payloads (test/fixtures/shopify/
// real/, test orders #1019 to #1021, USD) against the REAL captured orders/paid
// payloads, through storeWebhook -> processPendingWebhooks -> ledger (decisions D1 to D3).
//
// Only ids are overridden, with uniqueId(), because ledger dedupe keys are global and
// ledger rows are immutable: the order id and customer.id on an order, the order id and
// refund id on a refund, the order id on a cancel. Line item ids, quantities, amounts and
// every other field are exactly as captured. Config mirrors the M5 seed profile: spend
// 10000 paise : 100 points, tax "inclusive", after-discount, gift cards excluded.
//
// EXPECTED (computed by hand, see docs/PROGRESS.md):
//   #1019 earns 1349; R1 reverses 675 and R2 674 (1349 in total).
//   #1020 earns 674;  R3 (gift card line) and R4 (money-only) reverse 0.
//   #1021 earns 749;  R5 reverses 749 and the cancel 0 more (same total if the cancel runs first).

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { setFixedTime, restoreClock } from '../../web/loyalty/adapters/clock.js';
import { uniqueId } from '../helpers/ids.js';

const REAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'shopify', 'real');
const MIN = 60 * 1000;

describe('Real captured refunds and cancellation through the ledger', () => {
  let shop = '';
  let gw = null;
  let clock = new Date('2026-10-09T12:00:00Z');

  const setClock = (d) => { clock = d; setFixedTime(d); };

  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });

  beforeEach(async () => {
    shop = `real-refunds-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    setClock(new Date('2026-10-09T12:00:00Z'));
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
    await prisma.loyaltyConfig.create({
      data: {
        shop, spendAmountPaise: 10000, pointsPerUnit: 100, taxHandling: 'inclusive', earnBasis: 'after_discount',
        excludeGiftCards: true, ledgerStartAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
  });

  after(async () => {
    restoreClock();
    await prisma.$disconnect();
  });

  // ---- helpers ----

  const read = (file) => {
    const body = JSON.parse(readFileSync(join(REAL, file), 'utf8'));
    delete body._provenance;
    return body;
  };

  /** A real order with a fresh order id and customer id. */
  const order = (file) => {
    const p = read(file);
    p.id = uniqueId();
    p.customer.id = uniqueId();
    return p;
  };
  /** A real refund pointed at `orderPayload`, with a fresh refund id. */
  const refund = (file, orderPayload) => {
    const p = read(file);
    p.order_id = orderPayload.id;
    p.id = uniqueId();
    return p;
  };
  const cancel = (file, orderPayload) => {
    const p = read(file);
    p.id = orderPayload.id;
    return p;
  };

  const send = (topic, payload, webhookId = crypto.randomUUID()) => storeWebhook({ shop, topic, payload, shopifyWebhookId: webhookId });
  const run = () => processPendingWebhooks({ shop });
  const event = (id) => prisma.webhookEvent.findUnique({ where: { id } });
  const account = (o) => prisma.loyaltyAccount.findUnique({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: String(o.customer.id) } },
  });
  const ledger = async (o, type) => {
    const a = await account(o);
    return prisma.ledgerEntry.findMany({ where: { accountId: a.id, ...(type ? { type } : {}) }, orderBy: { createdAt: 'asc' } });
  };
  const loyaltyOrder = (o) => prisma.loyaltyOrder.findUnique({
    where: { shop_shopifyOrderId: { shop, shopifyOrderId: String(o.id) } }, include: { lot: true, refunds: true },
  });

  /** Earns the order and returns it. */
  async function earned(file, expectPoints) {
    const o = order(file);
    const ev = await send('orders/paid', o);
    await run();
    assert.strictEqual((await event(ev.id)).status, 'processed');
    assert.strictEqual((await loyaltyOrder(o)).pointsEarned, expectPoints);
    return o;
  }

  async function deliver(topic, payload) {
    const ev = await send(topic, payload);
    await run();
    return event(ev.id);
  }

  // ---- #1019: two units, two refunds ----

  test('#1019: earns 1349; R1 (restocked unit) reverses 675 and R2 (not restocked) reverses 674: 1349 in total', async () => {
    const o = await earned('orders-paid-1019-two-units-discount.json', 1349);
    assert.deepStrictEqual((await loyaltyOrder(o)).lines, [
      { shopifyLineItemId: String(o.line_items[0].id), quantity: 2, eligiblePaise: 134991, excluded: false, excludedReason: null },
    ]);

    const e1 = await deliver('refunds/create', refund('refunds-create-1019-r1-restock.json', o));
    assert.strictEqual(e1.status, 'processed', e1.lastError ?? '');
    assert.strictEqual((await account(o)).pending, 1349 - 675);

    const e2 = await deliver('refunds/create', refund('refunds-create-1019-r2-no-restock.json', o));
    assert.strictEqual(e2.status, 'processed', e2.lastError ?? '');
    const a = await account(o);
    assert.strictEqual(a.pending, 0);
    assert.strictEqual(a.available, 0);
    assert.strictEqual(a.debt, 0);

    const entries = await ledger(o, 'refund');
    assert.deepStrictEqual(entries.map((e) => e.points), [-675, -674]);
    const lo = await loyaltyOrder(o);
    assert.strictEqual(lo.lot.remaining, 0);
    assert.strictEqual(lo.lot.status, 'exhausted');
    assert.deepStrictEqual(lo.refunds.map((r) => r.pointsReversed).sort(), [674, 675]);
    for (const r of lo.refunds) {
      assert.deepStrictEqual(r.lines, [{ shopifyLineItemId: String(o.line_items[0].id), quantity: 1, counted: true, reason: null }]);
    }
  });

  test('#1019: the same two refunds in the other order give the same total (the first one rounds up)', async () => {
    const o = await earned('orders-paid-1019-two-units-discount.json', 1349);
    await deliver('refunds/create', refund('refunds-create-1019-r2-no-restock.json', o));
    await deliver('refunds/create', refund('refunds-create-1019-r1-restock.json', o));
    assert.deepStrictEqual((await ledger(o, 'refund')).map((e) => e.points), [-675, -674]);
    assert.strictEqual((await account(o)).pending, 0);
  });

  // ---- #1020: gift card and money-only ----

  test('#1020: earns 674; R3 (gift card line) and R4 (money-only) reverse 0 and write no ledger entry', async () => {
    const o = await earned('orders-paid-1020-giftcard-discount.json', 674);
    const lines = (await loyaltyOrder(o)).lines;
    assert.deepStrictEqual(lines.map((l) => [l.quantity, l.eligiblePaise, l.excluded, l.excludedReason]), [[1, 67496, false, null], [1, 0, true, 'gift_card']]);

    const r3 = refund('refunds-create-1020-r3-giftcard.json', o);
    assert.strictEqual(r3.refund_line_items[0].line_item.gift_card, true, 'R3 refunds the gift-card line');
    const e3 = await deliver('refunds/create', r3);
    assert.strictEqual(e3.status, 'processed', e3.lastError ?? '');

    const r4 = refund('refunds-create-1020-r4-money-only.json', o);
    assert.deepStrictEqual(r4.refund_line_items, [], 'R4 is money-only');
    assert.strictEqual(r4.order_adjustments.length, 1, 'with an order adjustment that must NOT be added');
    const e4 = await deliver('refunds/create', r4);
    assert.strictEqual(e4.status, 'processed', e4.lastError ?? '');

    assert.strictEqual((await account(o)).pending, 674);
    assert.deepStrictEqual((await ledger(o)).map((e) => e.type), ['earn'], 'no refund entry');
    const lo = await loyaltyOrder(o);
    assert.deepStrictEqual(lo.refunds.map((r) => r.pointsReversed), [0, 0], 'both refunds recorded, both 0');
    assert.strictEqual(lo.lot.remaining, 674);
    const gift = lo.refunds.find((r) => r.lines.length > 0);
    assert.deepStrictEqual(gift.lines.map((l) => [l.counted, l.reason]), [[false, 'gift_card']]);
  });

  // ---- #1021: cancel and its refund ----

  test('#1021: earns 749; R5 reverses 749, then the cancel reverses 0 more', async () => {
    const o = await earned('orders-paid-1021-plain.json', 749);
    const e5 = await deliver('refunds/create', refund('refunds-create-1021-r5-cancel.json', o));
    assert.strictEqual(e5.status, 'processed', e5.lastError ?? '');
    assert.strictEqual((await account(o)).pending, 0);

    const ec = await deliver('orders/cancelled', cancel('orders-cancelled-1021.json', o));
    assert.strictEqual(ec.status, 'processed', ec.lastError ?? '');

    assert.deepStrictEqual((await ledger(o)).map((e) => `${e.type}:${e.points}`), ['earn:749', 'refund:-749'], 'no cancel entry: nothing left to reverse');
    const lo = await loyaltyOrder(o);
    assert.strictEqual(lo.refunds.length, 2, 'the refund and the cancellation are both recorded');
    assert.deepStrictEqual(lo.refunds.map((r) => [r.isFullCancellation, r.pointsReversed]).sort(), [[false, 749], [true, 0]]);
    const a = await account(o);
    assert.deepStrictEqual([a.pending, a.available, a.debt], [0, 0, 0]);
  });

  test('#1021: the cancel arrives FIRST, then R5: the same 749 in total, nothing counted twice', async () => {
    const o = await earned('orders-paid-1021-plain.json', 749);
    const ec = await deliver('orders/cancelled', cancel('orders-cancelled-1021.json', o));
    assert.strictEqual(ec.status, 'processed', ec.lastError ?? '');
    assert.strictEqual((await account(o)).pending, 0);
    assert.strictEqual((await loyaltyOrder(o)).lot.status, 'cancelled');

    const e5 = await deliver('refunds/create', refund('refunds-create-1021-r5-cancel.json', o));
    assert.strictEqual(e5.status, 'processed', e5.lastError ?? '');

    assert.deepStrictEqual((await ledger(o)).map((e) => `${e.type}:${e.points}`), ['earn:749', 'cancel:-749'], 'no refund entry');
    const a = await account(o);
    assert.deepStrictEqual([a.pending, a.available, a.debt], [0, 0, 0]);
    const lo = await loyaltyOrder(o);
    assert.strictEqual(lo.refunds.reduce((t, r) => t + r.pointsReversed, 0), 749);
  });

  test('#1021: the refund and the cancel stored together (about 39 ms apart) are processed in one batch, in either order, without double counting', async () => {
    for (const first of ['refund', 'cancel']) {
      const o = await earned('orders-paid-1021-plain.json', 749);
      const r = refund('refunds-create-1021-r5-cancel.json', o);
      const c = cancel('orders-cancelled-1021.json', o);
      const batch = first === 'refund' ? [['refunds/create', r], ['orders/cancelled', c]] : [['orders/cancelled', c], ['refunds/create', r]];
      for (const [topic, payload] of batch) await send(topic, payload);
      await run();
      assert.strictEqual((await ledger(o)).reduce((t, e) => t + e.points, 0), 0, `${first} first: ledger nets to 0`);
      assert.strictEqual((await ledger(o)).length, 2, `${first} first: earn plus exactly one reversal entry`);
      assert.deepStrictEqual([(await account(o)).pending, (await account(o)).debt], [0, 0]);
    }
  });

  // ---- redelivery ----

  test('a redelivered refund (same webhook id, then a new webhook id with the same refund id) adds nothing', async () => {
    const o = await earned('orders-paid-1019-two-units-discount.json', 1349);
    const r1 = refund('refunds-create-1019-r1-restock.json', o);
    const webhookId = crypto.randomUUID();
    const first = await send('refunds/create', r1, webhookId);
    await run();
    assert.strictEqual((await event(first.id)).status, 'processed');

    const sameWebhook = await send('refunds/create', r1, webhookId);
    assert.strictEqual(sameWebhook.id, first.id, 'the same webhook id returns the stored event');

    const again = await send('refunds/create', r1);
    await run();
    const after = await event(again.id);
    assert.strictEqual(after.status, 'skipped');
    assert.match(after.lastError, /Duplicate/);

    assert.strictEqual((await account(o)).pending, 1349 - 675, 'reversed once');
    assert.strictEqual((await loyaltyOrder(o)).refunds.length, 1);
    assert.strictEqual((await ledger(o, 'refund')).length, 1);

    // ...and R2 still counts the second unit, so the redelivery did not use up the line.
    await deliver('refunds/create', refund('refunds-create-1019-r2-no-restock.json', o));
    assert.strictEqual((await account(o)).pending, 0);
  });

  test('a redelivered cancel adds nothing', async () => {
    const o = await earned('orders-paid-1021-plain.json', 749);
    await deliver('orders/cancelled', cancel('orders-cancelled-1021.json', o));
    const again = await deliver('orders/cancelled', cancel('orders-cancelled-1021.json', o));
    assert.strictEqual(again.status, 'skipped');
    assert.strictEqual((await ledger(o, 'cancel')).length, 1);
  });

  // ---- a refund before its order ----

  test('a refund before its order is RETRIED, not skipped, and applies once the order has been processed', async () => {
    const o = order('orders-paid-1019-two-units-discount.json');
    gw.addOrder({ id: o.id, processed_at: o.processed_at }); // Shopify knows the order; the ledger does not yet

    const early = await send('refunds/create', refund('refunds-create-1019-r1-restock.json', o));
    await run();
    let e = await event(early.id);
    assert.strictEqual(e.status, 'failed', 'kept for retry, not skipped');
    assert.match(e.lastError, /not yet in ledger/);
    assert.ok(e.nextRetryAt > clock, 'a retry time is set');
    assert.strictEqual(await prisma.loyaltyRefund.count({ where: { shop } }), 0, 'nothing recorded yet');

    await send('orders/paid', o);
    await run();
    setClock(new Date(clock.getTime() + 6 * MIN));
    await run();
    e = await event(early.id);
    assert.strictEqual(e.status, 'processed', e.lastError ?? '');
    assert.strictEqual((await account(o)).pending, 1349 - 675);
  });

  test('a refund stored BEFORE its order in the same batch is retried too (the order\'s own event is found, no Shopify call needed)', async () => {
    const o = order('orders-paid-1019-two-units-discount.json'); // the gateway knows nothing about this order
    const early = await send('refunds/create', refund('refunds-create-1019-r1-restock.json', o));
    await send('orders/paid', o);
    await run(); // refund first (older), fails; order second, processed
    assert.strictEqual((await event(early.id)).status, 'failed');
    assert.strictEqual((await account(o)).pending, 1349);

    setClock(new Date(clock.getTime() + 6 * MIN));
    await run();
    assert.strictEqual((await event(early.id)).status, 'processed');
    assert.strictEqual((await account(o)).pending, 1349 - 675);
  });

  test('a refund for an order Shopify has never heard of is skipped, with the reason', async () => {
    const o = order('orders-paid-1019-two-units-discount.json');
    const e = await deliver('refunds/create', refund('refunds-create-1019-r1-restock.json', o));
    assert.strictEqual(e.status, 'skipped');
    assert.match(e.lastError, /not found in Shopify/);
  });

  test('a refund for an order whose own event was skipped (earned nothing) is skipped, not retried forever', async () => {
    const o = order('orders-paid-1019-two-units-discount.json');
    delete o.customer; // a guest checkout earns nothing
    await send('orders/paid', o);
    await run();
    const e = await deliver('refunds/create', refund('refunds-create-1019-r1-restock.json', o));
    assert.strictEqual(e.status, 'skipped');
    assert.match(e.lastError, /earned no points/);
  });

  // ---- malformed or unmatched refunds ----

  test('a refunded quantity above the line quantity FAILS VISIBLY (dead at once, reason kept) and writes nothing', async () => {
    const o = await earned('orders-paid-1019-two-units-discount.json', 1349);
    const r = refund('refunds-create-1019-r1-restock.json', o);
    r.refund_line_items[0].quantity = 3; // the line has 2 units
    const e = await deliver('refunds/create', r);
    assert.strictEqual(e.status, 'dead');
    assert.match(e.lastError, /above the line quantity/);
    assert.strictEqual(e.nextRetryAt, null);
    assert.strictEqual((await account(o)).pending, 1349);
    assert.strictEqual(await prisma.loyaltyRefund.count({ where: { shop } }), 0);
  });

  test('a line refunded in two parts counts cumulatively, and a second part that goes over the quantity fails', async () => {
    const o = await earned('orders-paid-1019-two-units-discount.json', 1349);
    const a = refund('refunds-create-1019-r1-restock.json', o);
    const b = refund('refunds-create-1019-r2-no-restock.json', o);
    const c = refund('refunds-create-1019-r2-no-restock.json', o); // a third unit that does not exist
    await deliver('refunds/create', a);
    await deliver('refunds/create', b);
    const e = await deliver('refunds/create', c);
    assert.strictEqual(e.status, 'dead');
    assert.match(e.lastError, /above the line quantity/);
    assert.strictEqual((await ledger(o, 'refund')).reduce((t, x) => t + x.points, 0), -1349, 'still exactly 1349 reversed');
  });

  test('a refund entry for a line that is not in the earn snapshot reverses 0, and is recorded as such', async () => {
    const o = await earned('orders-paid-1019-two-units-discount.json', 1349);
    const r = refund('refunds-create-1019-r1-restock.json', o);
    r.refund_line_items[0].line_item_id = 1;
    r.refund_line_items[0].line_item.id = 1;
    const e = await deliver('refunds/create', r);
    assert.strictEqual(e.status, 'processed');
    assert.strictEqual((await account(o)).pending, 1349);
    const rec = (await loyaltyOrder(o)).refunds[0];
    assert.deepStrictEqual(rec.lines, [{ shopifyLineItemId: '1', quantity: 1, counted: false, reason: 'not_in_snapshot' }]);
  });

  test('line_item.id is used when line_item_id is absent', async () => {
    const o = await earned('orders-paid-1019-two-units-discount.json', 1349);
    const r = refund('refunds-create-1019-r1-restock.json', o);
    delete r.refund_line_items[0].line_item_id;
    const e = await deliver('refunds/create', r);
    assert.strictEqual(e.status, 'processed', e.lastError ?? '');
    assert.strictEqual((await account(o)).pending, 1349 - 675);
  });

  test('a refund entry with no line id at all fails visibly (dead), never guessed', async () => {
    const o = await earned('orders-paid-1019-two-units-discount.json', 1349);
    const r = refund('refunds-create-1019-r1-restock.json', o);
    delete r.refund_line_items[0].line_item_id;
    delete r.refund_line_items[0].line_item;
    const e = await deliver('refunds/create', r);
    assert.strictEqual(e.status, 'dead');
    assert.match(e.lastError, /neither line_item_id nor line_item.id/);
  });

  // ---- orders earned before the snapshot existed (D3) ----

  const clearSnapshot = (o) => prisma.$executeRaw`UPDATE "LoyaltyOrder" SET "lines" = NULL WHERE "shop" = ${shop} AND "shopifyOrderId" = ${String(o.id)}`;

  test('an order with no snapshot rebuilds it from the stored orders/paid event, stores it, and reverses as normal', async () => {
    const o = await earned('orders-paid-1019-two-units-discount.json', 1349);
    await clearSnapshot(o);
    assert.strictEqual((await loyaltyOrder(o)).lines, null);

    const e = await deliver('refunds/create', refund('refunds-create-1019-r1-restock.json', o));
    assert.strictEqual(e.status, 'processed', e.lastError ?? '');
    assert.strictEqual((await account(o)).pending, 1349 - 675);
    assert.strictEqual((await loyaltyOrder(o)).lines.length, 1, 'the rebuilt snapshot is stored');
  });

  test('an order with no snapshot and no stored orders/paid event fails the refund visibly', async () => {
    const o = await earned('orders-paid-1019-two-units-discount.json', 1349);
    await clearSnapshot(o);
    await prisma.webhookEvent.deleteMany({ where: { shop, topic: 'orders/paid' } });
    const e = await deliver('refunds/create', refund('refunds-create-1019-r1-restock.json', o));
    assert.strictEqual(e.status, 'dead');
    assert.match(e.lastError, /no earn snapshot/);
    assert.strictEqual((await account(o)).pending, 1349, 'nothing guessed');
  });

  test('a rebuilt snapshot that does not match what the ledger recorded is refused, not guessed', async () => {
    const o = await earned('orders-paid-1019-two-units-discount.json', 1349);
    await clearSnapshot(o);
    await prisma.loyaltyConfig.update({ where: { shop }, data: { earnBasis: 'before_discount' } }); // rules changed since the order earned
    const e = await deliver('refunds/create', refund('refunds-create-1019-r1-restock.json', o));
    assert.strictEqual(e.status, 'dead');
    assert.match(e.lastError, /does not match/);
    assert.strictEqual((await account(o)).pending, 1349);
  });

  test('the fixtures added for this suite carry no email address and a _provenance note', () => {
    for (const f of ['orders-paid-1019-two-units-discount.json', 'orders-paid-1020-giftcard-discount.json', 'orders-paid-1021-plain.json',
      'refunds-create-1019-r1-restock.json', 'refunds-create-1019-r2-no-restock.json', 'refunds-create-1020-r3-giftcard.json',
      'refunds-create-1020-r4-money-only.json', 'refunds-create-1021-r5-cancel.json', 'orders-cancelled-1021.json']) {
      const text = readFileSync(join(REAL, f), 'utf8');
      assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), `${f}: no email address`);
      const body = JSON.parse(text);
      assert.match(body._provenance?.note ?? '', /REAL delivery/, `${f}: _provenance note`);
      for (const holder of [body, ...(body.transactions || [])]) {
        for (const key of ['user_id', 'authorization', 'message']) {
          const v = holder?.[key];
          assert.ok(v === undefined || v === null || String(v).startsWith('[redacted'), `${f}: ${key} must be absent, null or redacted`);
        }
      }
      for (const t of body.transactions || []) {
        assert.ok(t.receipt === undefined || t.receipt === null || Object.values(t.receipt).every((v) => String(v).startsWith('[redacted')), `${f}: receipt redacted`);
      }
    }
  });
});
