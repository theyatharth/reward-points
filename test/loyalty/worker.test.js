// test/loyalty/worker.test.js
//
// The worker core (web/loyalty/service/worker.js): ticks, the advisory lock,
// JobRun rows, and the loop's shutdown. Tick work is scoped to one shop so
// events left by other tests are never touched, and every test uses its own
// jobType so JobRun rows can be counted exactly.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooksWithStats } from '../../web/loyalty/service/webhook.js';
import { runTick, startWorker } from '../../web/loyalty/service/worker.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { setFixedTime, restoreClock } from '../../web/loyalty/adapters/clock.js';
import { uniqueId, uniqueKey } from '../helpers/ids.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Worker', () => {
  let shop = '';
  let customerId = '';
  let jobType = '';
  let gw = null;

  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });

  beforeEach(async () => {
    shop = `worker-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    customerId = uniqueKey('cust');
    jobType = uniqueKey('wt');
    setFixedTime('2026-09-20T12:00:00Z');
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
    await prisma.loyaltyConfig.create({
      data: { shop, pointsPerUnit: 1, ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
    });
  });

  after(async () => {
    restoreClock();
    await prisma.$disconnect();
  });

  const storeOrder = async () => {
    const orderId = uniqueId();
    const event = await storeWebhook({
      shop,
      topic: 'orders/paid',
      shopifyWebhookId: crypto.randomUUID(),
      payload: {
        id: orderId,
        processed_at: '2026-09-20T10:00:00Z',
        subtotal_price: '100.00',
        taxes_included: false,
        customer: { id: customerId },
        line_items: [{ price: '100.00', quantity: 1, tax_lines: [], discount_allocations: [] }],
        shipping_lines: [],
      },
    });
    return { event, orderId };
  };
  const scoped = () => processPendingWebhooksWithStats({ shop });
  const eventRow = (id) => prisma.webhookEvent.findUnique({ where: { id } });
  const jobs = () => prisma.jobRun.findMany({ where: { jobType }, orderBy: { startedAt: 'asc' } });

  test('a tick processes a stored event and records one JobRun', async () => {
    const { event } = await storeOrder();
    const outcome = await runTick({ work: scoped, jobType });

    assert.strictEqual(outcome.ran, true);
    assert.strictEqual(outcome.processed, 1);
    assert.strictEqual((await eventRow(event.id)).status, 'processed');

    const rows = await jobs();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'completed');
    assert.strictEqual(rows[0].result.processed, 1);
    assert.ok(rows[0].completedAt);
  });

  test('a quiet tick (nothing to process) writes no JobRun', async () => {
    const outcome = await runTick({ work: scoped, jobType });
    assert.strictEqual(outcome.ran, true);
    assert.strictEqual(outcome.processed, 0);
    assert.strictEqual((await jobs()).length, 0);
  });

  test('a tick in which an event fails is recorded, with the failure count', async () => {
    await prisma.loyaltyConfig.update({ where: { shop }, data: { excludedCollectionIds: ['900001'] } });
    gw.injectFailure(new Error('Simulated Shopify outage')); // the collection lookup throws
    const { event } = await storeOrder();

    const outcome = await runTick({ work: scoped, jobType });
    assert.strictEqual(outcome.processed, 0);
    assert.strictEqual(outcome.failed, 1);
    assert.strictEqual((await eventRow(event.id)).status, 'failed');

    const [row] = await jobs();
    assert.strictEqual(row.status, 'completed');
    assert.strictEqual(row.result.failed, 1);
  });

  test('two workers ticking at the same moment process the event exactly once', async () => {
    const { event, orderId } = await storeOrder();
    let workCalls = 0;
    const slow = async () => {
      workCalls++;
      await sleep(300); // hold the lock long enough for the other tick to arrive
      return scoped();
    };

    const [a, b] = await Promise.all([runTick({ work: slow, jobType }), runTick({ work: slow, jobType })]);

    assert.strictEqual(workCalls, 1, 'only one tick did the work');
    assert.deepStrictEqual([a.ran, b.ran].sort(), [false, true], 'the other tick saw the lock and skipped');
    assert.strictEqual(a.processed + b.processed, 1);
    assert.strictEqual((await eventRow(event.id)).status, 'processed');
    assert.strictEqual(await prisma.loyaltyOrder.count({ where: { shop, shopifyOrderId: String(orderId) } }), 1);
    assert.strictEqual((await jobs()).length, 1, 'one JobRun, not two');
  });

  test('two running worker loops process the event exactly once between them', async () => {
    const { event } = await storeOrder();
    const ticks = [];
    const slow = async () => { await sleep(150); return scoped(); };
    const make = () => startWorker({
      intervalMs: 30,
      tick: () => runTick({ work: slow, jobType }),
      onTick: (t) => ticks.push(t),
    });

    const w1 = make();
    const w2 = make();
    await sleep(1200);
    await Promise.all([w1.stop(), w2.stop()]);

    assert.strictEqual(ticks.reduce((n, t) => n + t.processed, 0), 1, 'exactly one event processed in total');
    assert.ok(ticks.some((t) => t.ran === false), 'at least one tick was turned away by the lock');
    assert.strictEqual((await eventRow(event.id)).status, 'processed');
    assert.strictEqual((await jobs()).length, 1);
  });

  test('a crashed tick releases the lock and records a failed JobRun', async () => {
    const { event } = await storeOrder();

    const crashed = await runTick({
      work: async () => { throw new Error('boom in the middle of a tick'); },
      jobType,
    });
    assert.strictEqual(crashed.ran, true);
    assert.match(crashed.error, /boom in the middle of a tick/);

    // The lock must be free again immediately: the next tick runs and does the work.
    const next = await runTick({ work: scoped, jobType });
    assert.strictEqual(next.ran, true, 'lock was released by the crashed tick');
    assert.strictEqual(next.processed, 1);
    assert.strictEqual((await eventRow(event.id)).status, 'processed');

    const rows = await jobs();
    // The test clock is fixed, so both rows carry the same startedAt: their order is not observable, only their statuses.
    assert.deepStrictEqual(rows.map((r) => r.status).sort(), ['completed', 'failed']);
    assert.match(rows.find((r) => r.status === 'failed').error, /boom in the middle of a tick/);
  });

  test('stop() waits for the tick in flight and starts no further tick', async () => {
    let started = 0;
    let finished = 0;
    const worker = startWorker({
      intervalMs: 20,
      tick: async () => { started++; await sleep(250); finished++; return { ran: true, picked: 0, processed: 0, failed: 0 }; },
    });
    while (started === 0) await sleep(10);

    await worker.stop(); // called mid-tick
    assert.strictEqual(finished, 1, 'the in-flight tick completed before stop() resolved');

    await sleep(150);
    assert.strictEqual(started, 1, 'no new tick started after stop()');
  });
});
