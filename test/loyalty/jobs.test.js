// test/loyalty/jobs.test.js
//
// Task 4: the worker's jobs, all driven by the fake clock (adapters/clock.js), never by sleeping.
//   (a) activation of due pending lots     (b) retry schedule and dead events
//   (c) events stuck in 'processing'       (d) 90-day purge of processed payloads
//   (e) reconciliation, rebuildCache, the nightly run, and the jobs together in one tick
// Every test has its own shop; jobs are narrowed to it with the `shop` option.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooksWithStats, RETRY_DELAYS_MINUTES } from '../../web/loyalty/service/webhook.js';
import { recoverStuckEvents, activateDueLots, purgeOldPayloads } from '../../web/loyalty/service/jobs.js';
import { reconcileAccount, rebuildCache, runReconciliation, runNightlyReconciliation } from '../../web/loyalty/service/reconcile.js';
import { runTick, createWorkerWork } from '../../web/loyalty/service/worker.js';
import { redeem } from '../../web/loyalty/service/redemption.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { setFixedTime, restoreClock, now } from '../../web/loyalty/adapters/clock.js';
import { uniqueId, uniqueKey } from '../helpers/ids.js';
import { assertLedgerInvariants, assertLedgerBalances } from '../helpers/invariants.js';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const T0 = new Date('2026-09-01T10:00:00Z');

describe('Worker jobs', () => {
  let shop = '';
  let gw = null;
  let customerId = '';

  const setClock = (d) => setFixedTime(d);
  const advanceMs = (ms) => setClock(new Date(now().getTime() + ms));

  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });

  beforeEach(async () => {
    shop = `jobs-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    customerId = uniqueKey('cust');
    setClock(T0);
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
    await prisma.loyaltyConfig.create({
      data: {
        shop, spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, currency: 'INR',
        holdPeriodDays: 30, ledgerStartAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
  });

  after(async () => {
    restoreClock();
    await prisma.$disconnect();
  });

  // ---- helpers ----

  const account = () => prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: customerId } } });
  const event = (id) => prisma.webhookEvent.findUnique({ where: { id } });
  const process_ = () => processPendingWebhooksWithStats({ shop });

  const paidPayload = (orderId, points = 300) => ({
    id: orderId, customer: { id: customerId }, processed_at: now().toISOString(),
    line_items: [{ id: 1, quantity: 1, price: String(points), title: 'Item' }],
  });

  /** Earns an order (pending lot) at the current clock and tells the fake Shopify about it. */
  async function earn(points = 300) {
    const orderId = uniqueId();
    const payload = paidPayload(orderId, points);
    await storeWebhook({ shop, topic: 'orders/paid', payload, shopifyWebhookId: crypto.randomUUID() });
    await process_();
    gw.addOrder({ id: orderId, processed_at: payload.processed_at, refunds: [] });
    return orderId;
  }
  const lotOf = (orderId) => prisma.pointLot.findFirst({ where: { shopifyOrderId: String(orderId) } });

  async function refundUnits(orderId, units = 1) {
    const ev = await storeWebhook({
      shop, topic: 'refunds/create', shopifyWebhookId: crypto.randomUUID(),
      payload: { id: uniqueId(), order_id: orderId, refund_line_items: [{ line_item_id: 1, quantity: units }] },
    });
    await process_();
    return event(ev.id);
  }

  const rawEvent = (data) => prisma.webhookEvent.create({ data: { shop, shopifyWebhookId: crypto.randomUUID(), topic: 'orders/paid', payload: {}, ...data } });
  const jobRuns = (jobType, where = {}) => prisma.jobRun.findMany({ where: { jobType, shop, ...where }, orderBy: { startedAt: 'asc' } });

  // ===================== (a) activation =====================

  test('(a) a pending lot becomes available only once its hold period is over', async () => {
    const orderId = await earn(300);
    advanceMs(29 * DAY);
    assert.deepStrictEqual(await activateDueLots({ shop }), { due: 0, activated: 0, blocked: [] }, 'day 29: not due');
    assert.strictEqual((await account()).pending, 300);

    advanceMs(DAY + MIN); // past activatesAt (day 30)
    const r = await activateDueLots({ shop });
    assert.deepStrictEqual(r, { due: 1, activated: 1, blocked: [] });
    const a = await assertLedgerBalances(prisma, (await account()).id);
    assert.deepStrictEqual([a.available, a.pending], [300, 0]);
    assert.strictEqual((await lotOf(orderId)).status, 'active');

    assert.deepStrictEqual(await activateDueLots({ shop }), { due: 0, activated: 0, blocked: [] }, 'nothing left to do');
  });

  test('(a) the J3 check blocks a lot while Shopify holds a refund the ledger has not applied, and is retried', async () => {
    const orderId = await earn(300);
    advanceMs(31 * DAY);
    gw.addOrder({ id: orderId, processed_at: T0.toISOString(), refunds: [{ id: 555 }] });

    const r = await activateDueLots({ shop });
    assert.strictEqual(r.activated, 0);
    assert.strictEqual(r.blocked.length, 1);
    assert.match(r.blocked[0].reason, /J3/);
    assert.strictEqual((await lotOf(orderId)).status, 'pending', 'still pending');

    gw.addOrder({ id: orderId, processed_at: T0.toISOString(), refunds: [] }); // the refund has been dealt with
    assert.strictEqual((await activateDueLots({ shop })).activated, 1);
    assert.strictEqual((await lotOf(orderId)).status, 'active');
  });

  test('(a) activation repays the owed balance first, from the activated lot', async () => {
    await earn(300);
    const a0 = await account();
    await prisma.loyaltyAccount.update({ where: { id: a0.id }, data: { debt: 200 } }); // owed from an earlier return
    advanceMs(31 * DAY);

    assert.strictEqual((await activateDueLots({ shop })).activated, 1);
    const a = await assertLedgerInvariants(prisma, a0.id);
    assert.deepStrictEqual([a.available, a.pending, a.debt], [100, 0, 0], '200 of the 300 repaid the debt');
    const lot = await prisma.pointLot.findFirst({ where: { accountId: a0.id } });
    assert.deepStrictEqual([lot.status, lot.remaining], ['active', 100]);
  });

  test('(a) a refund applied before activation leaves nothing to activate (the lot is exhausted)', async () => {
    const orderId = await earn(300);
    await refundUnits(orderId, 1);
    advanceMs(31 * DAY);
    assert.deepStrictEqual(await activateDueLots({ shop }), { due: 0, activated: 0, blocked: [] });
    const a = await assertLedgerBalances(prisma, (await account()).id);
    assert.deepStrictEqual([a.available, a.pending, a.debt], [0, 0, 0]);
  });

  // ===================== (b) retry schedule =====================

  /** A refund whose order Shopify knows but the ledger does not: it fails "retry later" every time. */
  async function failingEvent() {
    const orderId = uniqueId();
    gw.addOrder({ id: orderId, processed_at: now().toISOString() });
    return storeWebhook({
      shop, topic: 'refunds/create', shopifyWebhookId: crypto.randomUUID(),
      payload: { id: uniqueId(), order_id: orderId, refund_line_items: [{ line_item_id: 1, quantity: 1 }] },
    });
  }

  test('(b) the schedule is 1, 5, 30, 120, 360 minutes; the sixth failure is dead', async () => {
    assert.deepStrictEqual(RETRY_DELAYS_MINUTES, [1, 5, 30, 120, 360]);
    const { id } = await failingEvent();

    for (let failure = 1; failure <= 5; failure++) {
      const ran = await process_();
      assert.strictEqual(ran.failed, 1, `failure ${failure}`);
      const e = await event(id);
      assert.strictEqual(e.status, 'failed');
      assert.strictEqual(e.attempts, failure);
      const delay = RETRY_DELAYS_MINUTES[failure - 1];
      assert.strictEqual(e.nextRetryAt.getTime() - now().getTime(), delay * MIN, `retry ${failure} is due in ${delay} min`);

      advanceMs(delay * MIN - 1); // one millisecond early: not picked up
      assert.strictEqual((await process_()).picked, 0, `not before the ${delay}-minute mark`);
      advanceMs(1);
    }

    assert.strictEqual((await process_()).failed, 1, 'the sixth failure');
    const dead = await event(id);
    assert.strictEqual(dead.status, 'dead');
    assert.strictEqual(dead.attempts, 6);
    assert.strictEqual(dead.nextRetryAt, null);
    assert.match(dead.lastError, /not yet in ledger/, 'the reason is kept');

    advanceMs(1000 * DAY);
    assert.strictEqual((await process_()).picked, 0, 'a dead event is never picked up again');
  });

  test('(b) a payload that is not a JSON object is dead at once, with the reason', async () => {
    const cases = [['a string', 'this is not json {'], ['an array', [1, 2, 3]], ['a number', 42]];
    for (const [what, payload] of cases) {
      const e0 = await rawEvent({ payload });
      const ran = await process_();
      assert.strictEqual(ran.failed, 1, what);
      const e = await event(e0.id);
      assert.strictEqual(e.status, 'dead', what);
      assert.strictEqual(e.attempts, 1, `${what}: on the first attempt`);
      assert.strictEqual(e.nextRetryAt, null);
      assert.match(e.lastError, /Unparseable payload/, what);
    }
  });

  test('(b) an unhandled topic with any payload is still just skipped', async () => {
    const e0 = await rawEvent({ topic: 'products/update', payload: 'junk' });
    await process_();
    assert.strictEqual((await event(e0.id)).status, 'skipped');
  });

  // ===================== (c) stuck events =====================

  test('(c) an event stuck in processing for more than 10 minutes is retried; a recent one is left alone', async () => {
    const old = await rawEvent({ status: 'processing', payload: paidPayload(uniqueId(), 300), updatedAt: new Date(now().getTime() - 11 * MIN) });
    const recent = await rawEvent({ status: 'processing', payload: paidPayload(uniqueId(), 300), updatedAt: new Date(now().getTime() - 5 * MIN) });
    const exhausted = await rawEvent({ status: 'processing', attempts: 5, payload: paidPayload(uniqueId(), 300), updatedAt: new Date(now().getTime() - 30 * MIN) });

    const r = await recoverStuckEvents({ shop });
    assert.deepStrictEqual(r, { stuck: 2, recovered: 2, dead: 1 });

    const o = await event(old.id);
    assert.strictEqual(o.status, 'failed');
    assert.strictEqual(o.attempts, 1);
    assert.strictEqual(o.nextRetryAt.getTime(), now().getTime() + MIN, 'due on the normal schedule');
    assert.match(o.lastError, /Stuck in processing/);
    assert.strictEqual((await event(recent.id)).status, 'processing', 'a 5-minute-old claim may still be running');
    const x = await event(exhausted.id);
    assert.strictEqual(x.status, 'dead', 'the 6th failure');
    assert.strictEqual(x.nextRetryAt, null);

    // ...and the recovered event is processed on its retry, applying the ledger exactly once.
    advanceMs(2 * MIN);
    await process_();
    assert.strictEqual((await event(old.id)).status, 'processed');
    assert.strictEqual((await account()).pending, 300);
  });

  test('(c) recovery never touches events that are not stuck in processing', async () => {
    const ok = await rawEvent({ status: 'processed', updatedAt: new Date(now().getTime() - 60 * MIN) });
    const pending = await rawEvent({ status: 'pending', updatedAt: new Date(now().getTime() - 60 * MIN) });
    const failed = await rawEvent({ status: 'failed', updatedAt: new Date(now().getTime() - 60 * MIN) });
    assert.deepStrictEqual(await recoverStuckEvents({ shop }), { stuck: 0, recovered: 0, dead: 0 });
    for (const [e, status] of [[ok, 'processed'], [pending, 'pending'], [failed, 'failed']]) assert.strictEqual((await event(e.id)).status, status);
  });

  // ===================== (d) purge =====================

  test('(d) processed events older than 90 days lose their payload and nothing else', async () => {
    const age = (days) => new Date(now().getTime() - days * DAY);
    const payload = { id: 123, secret_looking: 'order body' };
    const stale = await rawEvent({ status: 'processed', payload, createdAt: age(91), attempts: 2, ledgerEntryId: 'entry-1', lastError: 'earlier note' });
    const fresh = await rawEvent({ status: 'processed', payload, createdAt: age(89) });
    const failed = await rawEvent({ status: 'failed', payload, createdAt: age(120) });
    const dead = await rawEvent({ status: 'dead', payload, createdAt: age(120) });
    const skipped = await rawEvent({ status: 'skipped', payload, createdAt: age(120) });
    const pending = await rawEvent({ status: 'pending', payload, createdAt: age(120) });
    const before = await event(stale.id);

    assert.deepStrictEqual(await purgeOldPayloads({ shop }), { purged: 1 });

    const after = await event(stale.id);
    assert.deepStrictEqual(after.payload, { _purged: true });
    assert.ok(after.payloadPurgedAt, 'purge time recorded');
    for (const col of ['id', 'shop', 'shopifyWebhookId', 'topic', 'status', 'attempts', 'nextRetryAt', 'lastError', 'ledgerEntryId', 'createdAt']) {
      assert.deepStrictEqual(after[col], before[col], `${col} is kept`);
    }
    for (const e of [fresh, failed, dead, skipped, pending]) {
      const row = await event(e.id);
      assert.deepStrictEqual(row.payload, payload, `${row.status} event keeps its payload`);
      assert.strictEqual(row.payloadPurgedAt, null);
    }
    assert.deepStrictEqual(await purgeOldPayloads({ shop }), { purged: 0 }, 'repeating it changes nothing');

    advanceMs(2 * DAY); // the 89-day-old event is now 91 days old
    assert.deepStrictEqual(await purgeOldPayloads({ shop }), { purged: 1 });
  });

  // ===================== (e) reconciliation =====================

  const types = async (accountId) => (await prisma.ledgerEntry.findMany({ where: { accountId } })).map((e) => e.type);

  /** A customer who earned 500, redeemed it, used the code, and had the order refunded: owes 500. */
  async function oweFiveHundred() {
    const orderId = await earn(500);
    advanceMs(31 * DAY);
    assert.strictEqual((await activateDueLots({ shop })).activated, 1);
    assert.strictEqual((await redeem({ shop, shopifyCustomerId: customerId, idempotencyKey: crypto.randomUUID() })).ok, true);
    await prisma.reward.updateMany({ where: { shop }, data: { status: 'used', usedAt: now() } });
    await refundUnits(orderId, 1);
    return orderId;
  }

  test('(e) a healthy account, including one that owes points, reconciles clean; the result lands in JobRun.result', async () => {
    await oweFiveHundred();
    const a = await account();
    assert.strictEqual(a.debt, 500);
    assert.deepStrictEqual(await reconcileAccount(a.id), []);

    const result = await runReconciliation({ shop, repair: false, trigger: 'manual' });
    assert.strictEqual(result.accountsChecked, 1);
    assert.strictEqual(result.discrepancyCount, 0);
    assert.ok(result.eventHealth.processed >= 1, 'event health is part of the result');

    const [row] = await jobRuns('reconcile');
    assert.strictEqual(row.status, 'completed');
    assert.strictEqual(row.result.accountsChecked, 1);
    assert.strictEqual(row.result.trigger, 'manual');
    assert.deepStrictEqual((await types(a.id)).sort(), ['activate', 'earn', 'redemption', 'refund'], 'reconciling writes nothing to the ledger');
  });

  test('(e) a wrong cached balance is reported, left alone without repair, and rebuilt (with an AuditLog row) with it', async () => {
    const orderId = await earn(300);
    advanceMs(31 * DAY);
    await activateDueLots({ shop });
    const a0 = await account();
    assert.strictEqual(a0.available, 300);
    void orderId;

    await prisma.loyaltyAccount.update({ where: { id: a0.id }, data: { available: 999, debt: 40 } }); // corrupt the cache
    const found = await reconcileAccount(a0.id);
    assert.deepStrictEqual(found.map((d) => d.code).sort(), ['available_mismatch', 'ledger_identity']);
    assert.deepStrictEqual(found.find((d) => d.code === 'available_mismatch'), { code: 'available_mismatch', detail: 'available differs from the sum of active lots', expected: 300, found: 999 });

    const report = await runReconciliation({ shop, repair: false });
    assert.strictEqual(report.accountsWithDiscrepancies, 1);
    assert.strictEqual(report.repaired, 0);
    assert.deepStrictEqual((await account()).available, 999, 'report only: nothing changed');

    const fixed = await runReconciliation({ shop, repair: true });
    assert.strictEqual(fixed.repaired, 1);
    const a = await assertLedgerBalances(prisma, a0.id);
    assert.deepStrictEqual([a.available, a.pending, a.debt], [300, 0, 0]);
    assert.deepStrictEqual(await reconcileAccount(a0.id), []);

    const audit = await prisma.auditLog.findMany({ where: { shop, action: { startsWith: 'rebuild_cache' } } });
    assert.strictEqual(audit.length, 1);
    assert.strictEqual(audit[0].adminId, null);
    assert.deepStrictEqual(audit[0].detail.before, { available: 999, pending: 0, debt: 40 });
    assert.deepStrictEqual(audit[0].detail.after, { available: 300, pending: 0, debt: 0 });

    assert.strictEqual((await rebuildCache(a0.id)).changed, false, 'rebuilding a correct cache changes nothing');
    assert.strictEqual((await prisma.auditLog.count({ where: { shop, action: { startsWith: 'rebuild_cache' } } })), 1, 'and writes no AuditLog row');
  });

  test('(e) rebuildCache restores a real owed balance from the ledger identity', async () => {
    await oweFiveHundred();
    const a0 = await account();
    await prisma.loyaltyAccount.update({ where: { id: a0.id }, data: { debt: 0 } }); // the debt got lost from the cache
    assert.deepStrictEqual((await reconcileAccount(a0.id)).map((d) => d.code), ['ledger_identity']);
    const r = await rebuildCache(a0.id);
    assert.deepStrictEqual([r.changed, r.after.debt], [true, 500]);
    assert.strictEqual((await account()).debt, 500);
  });

  test('(e) when the ledger holds more than the lots can account for, it is reported and NOT guessed at', async () => {
    await earn(300);
    const a0 = await account();
    await prisma.ledgerEntry.create({ data: { accountId: a0.id, type: 'adjustment', points: 50, status: 'active', dedupeKey: `test-adjust:${uniqueId()}`, note: 'inserted without a lot' } });

    const found = await reconcileAccount(a0.id);
    assert.ok(found.some((d) => d.code === 'ledger_identity'));
    const refused = await rebuildCache(a0.id);
    assert.strictEqual(refused.changed, false);
    assert.match(refused.refused, /needs a person/);

    const run = await runReconciliation({ shop, repair: true });
    assert.strictEqual(run.repaired, 0);
    assert.strictEqual(run.unrepairable.length, 1);
    assert.strictEqual((await account()).pending, 300, 'untouched');
    assert.strictEqual(await prisma.auditLog.count({ where: { shop, action: { startsWith: 'rebuild_cache' } } }), 0);
  });

  test('(e) other inconsistencies are reported: an order reversed beyond what it earned, an earn entry that disagrees', async () => {
    const orderId = await earn(300);
    const lo = await prisma.loyaltyOrder.findFirst({ where: { shop, shopifyOrderId: String(orderId) } });
    await prisma.loyaltyRefund.create({ data: { accountId: lo.accountId, shopifyRefundId: String(uniqueId()), shopifyOrderId: lo.shopifyOrderId, shop, pointsReversed: 301, refundAmountPaise: 0, loyaltyOrderId: lo.id, lines: [] } });
    await prisma.loyaltyOrder.update({ where: { id: lo.id }, data: { pointsEarned: 299 } });
    const codes = (await reconcileAccount(lo.accountId)).map((d) => d.code);
    assert.ok(codes.includes('order_over_reversed'));
    assert.ok(codes.includes('earn_entry_mismatch'));
  });

  test('(e) the engine\'s "incorrect reversal" check: ledger refund and cancel entries must equal the reversals recorded on the order', async () => {
    const orderId = await earn(500);
    await refundUnits(orderId, 1); // a real full refund: 500 reversed in the ledger and on the order
    const a0 = await account();
    assert.deepStrictEqual(await reconcileAccount(a0.id), [], 'a real reversal reconciles clean');

    const refund = await prisma.loyaltyRefund.findFirst({ where: { shop } });
    await prisma.loyaltyRefund.update({ where: { id: refund.id }, data: { pointsReversed: 400 } }); // the order says 400, the ledger says 500
    const found = await reconcileAccount(a0.id);
    const mismatch = found.find((d) => d.code === 'reversal_mismatch');
    assert.deepStrictEqual([mismatch.expected, mismatch.found], [400, 500]);
    assert.match(mismatch.detail, /the ledger reversed 500 points, the order records 400/);

    // and the other way: a reversal recorded on the order that never reached the ledger
    await prisma.loyaltyRefund.update({ where: { id: refund.id }, data: { pointsReversed: 500 } });
    await prisma.loyaltyRefund.create({ data: { accountId: a0.id, shopifyRefundId: String(uniqueId()), shopifyOrderId: refund.shopifyOrderId, shop, pointsReversed: 25, refundAmountPaise: 0, loyaltyOrderId: refund.loyaltyOrderId, lines: [] } });
    const second = (await reconcileAccount(a0.id)).find((d) => d.code === 'reversal_mismatch');
    assert.deepStrictEqual([second.expected, second.found], [525, 500]);
  });

  test('(e) nightly: due from the set hour, once a day, not before, and every shop run leaves a JobRun', async () => {
    await earn(300);
    const nightly = (extra = {}) => runNightlyReconciliation({ shops: [shop], ...extra });
    const umbrella = () => prisma.jobRun.findMany({ where: { jobType: 'reconcile_nightly', shop }, orderBy: { startedAt: 'asc' } });

    setClock(new Date('2026-09-02T10:00:00Z')); // before 21:00 UTC
    assert.deepStrictEqual(await nightly(), { ran: false });

    setClock(new Date('2026-09-02T21:30:00Z'));
    assert.deepStrictEqual(await nightly(), { ran: true, shops: 1 });
    assert.strictEqual((await umbrella()).length, 1);
    assert.strictEqual((await jobRuns('reconcile')).length, 1);
    assert.strictEqual((await jobRuns('reconcile'))[0].result.trigger, 'nightly');
    assert.strictEqual((await jobRuns('reconcile'))[0].result.repair, false, 'the nightly run reports, it does not repair');

    setClock(new Date('2026-09-02T23:30:00Z'));
    assert.deepStrictEqual(await nightly(), { ran: false }, 'not twice the same night');

    setClock(new Date('2026-09-03T21:30:00Z'));
    assert.deepStrictEqual(await nightly(), { ran: true, shops: 1 }, 'the next night');
    assert.strictEqual((await umbrella()).length, 2);
  });

  test('(e) on demand: runReconciliation works at any time, whatever the nightly state', async () => {
    await earn(300);
    setClock(new Date('2026-09-02T03:00:00Z'));
    const r = await runReconciliation({ shop, trigger: 'manual' });
    assert.strictEqual(r.accountsChecked, 1);
    assert.strictEqual((await jobRuns('reconcile')).length, 1);
  });

  // ===================== the jobs together =====================

  test('the worker tick runs the jobs together: events, stuck recovery, activation, purge, nightly reconcile', async () => {
    // A lot that is due, an old processed event, a stuck event, a pending event, at 21:30 UTC.
    await earn(300);
    setClock(new Date('2026-10-05T21:30:00Z'));
    const old = await rawEvent({ status: 'processed', payload: { id: 1 }, createdAt: new Date('2026-01-01T00:00:00Z') });
    const stuck = await rawEvent({ status: 'processing', payload: paidPayload(uniqueId(), 100), updatedAt: new Date(now().getTime() - 20 * MIN) });
    const fresh = await storeWebhook({ shop, topic: 'orders/paid', payload: paidPayload(uniqueId(), 200), shopifyWebhookId: crypto.randomUUID() });

    const jobType = uniqueKey('tick');
    const outcome = await runTick({ work: createWorkerWork({ shop }), jobType });
    assert.strictEqual(outcome.ran, true);
    assert.strictEqual(outcome.processed, 1, 'the pending event');
    assert.strictEqual((await event(fresh.id)).status, 'processed');
    assert.strictEqual((await event(stuck.id)).status, 'failed', 'stuck event recovered');
    assert.deepStrictEqual((await event(old.id)).payload, { _purged: true }, 'old payload purged');

    assert.strictEqual((await jobRuns('recover_stuck')).length, 1);
    assert.strictEqual((await jobRuns('activate_lots')).length, 1);
    assert.strictEqual((await jobRuns('purge_payloads')).length, 1);
    assert.strictEqual((await jobRuns('reconcile')).length, 1);
    assert.strictEqual((await prisma.jobRun.count({ where: { jobType: 'reconcile_nightly', shop } })), 1);
    assert.strictEqual((await jobRuns('activate_lots'))[0].result.activated, 1);

    // The activated lot (300 points earned in September) is available now.
    const a = await account();
    assert.ok(a.available >= 300, `available ${a.available}`);

    // A second tick straight after: the daily jobs do not run again, the throttled activation neither.
    await runTick({ work: createWorkerWork({ shop }), jobType });
    assert.strictEqual((await jobRuns('purge_payloads')).length, 1);
    assert.strictEqual((await prisma.jobRun.count({ where: { jobType: 'reconcile_nightly', shop } })), 1);
  });
});
