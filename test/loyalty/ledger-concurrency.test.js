// test/loyalty/ledger-concurrency.test.js
//
// Task 3: every ledger writer takes the account row lock FIRST (lockAccount), re-reads
// lots inside the transaction and writes deltas. This test FORCES the race instead of
// hoping for it: a barrier on lockAccount (the test seam setLockHook) holds both the
// refund and the redeem until BOTH have opened their transaction and reached the lock,
// then releases them with the preferred one first, alternating the preference every run so
// both interleavings are exercised. Twenty runs, one account each, the invariants checked
// after every run.
//
// Setup of a run: the customer earned 500 points on an order and the hold period passed.
// Then, at the same time: the order is fully refunded (a refunds/create event) and the
// customer redeems (500 points buy a reward).
//
// Whichever wins, the customer is entitled to NOTHING in the end (the order was refunded):
//   refund first : the points are reversed, the redeem is refused (SHORT): no reward, balance 0
//   redeem first : the reward exists, and the refund either voids it (points returned, then
//                  reversed) or, if it ran before the code was recorded, the customer owes 500
//   so  available + points held in still-active rewards - debt = 0   in every outcome.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import { redeem, resolveRedemption } from '../../web/loyalty/service/redemption.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { setFixedTime, restoreClock } from '../../web/loyalty/adapters/clock.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { uniqueId } from '../helpers/ids.js';
import { assertLedgerBalances } from '../helpers/invariants.js';

const DAY = 24 * 60 * 60 * 1000;
const RUNS = 20;

/**
 * A barrier for exactly two writers, told apart by the tag lockAccount passes ('refund',
 * 'redeem'). When both have arrived, `first` is released at once and the other 20 ms later.
 * A writer that arrives alone is let through after 5 s so a code path that never reaches
 * the lock cannot hang the test. Later calls pass straight through.
 */
function makeBarrier(first) {
  const waiting = [];
  const seen = [];
  const hook = async (_accountId, tag) => {
    seen.push(tag);
    if (!['refund', 'redeem'].includes(tag) || waiting.length >= 2) return;
    await new Promise((resolve) => {
      waiting.push({ tag, resolve });
      if (waiting.length === 2) {
        const early = waiting.find((w) => w.tag === first) ?? waiting[0];
        const late = waiting.find((w) => w !== early);
        early.resolve();
        setTimeout(() => late.resolve(), 20);
      } else {
        setTimeout(resolve, 5000).unref();
      }
    });
  };
  return { hook, seen };
}

describe('Ledger concurrency: refund versus redeem on one account', () => {
  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });

  after(async () => {
    ledgerService.setLockHook(null);
    restoreClock();
    await prisma.$disconnect();
  });

  test(`${RUNS} barrier-forced runs: invariants hold, nothing is created from nothing, both orderings happen`, async () => {
    const outcomes = { 'refund won: redeem refused': 0, 'redeem won, reward voided': 0, 'redeem won, reward active and 500 owed': 0 };

    for (let i = 0; i < RUNS; i++) {
      const shop = `race-${Date.now()}-${i}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
      const gw = new FakeShopifyGateway(shop);
      ledgerService.setGatewayFactory(() => gw);
      let clock = new Date('2026-09-01T10:00:00Z');
      setFixedTime(clock);
      await prisma.loyaltyConfig.create({
        data: { shop, spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, currency: 'INR', ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
      });

      const orderId = uniqueId();
      const paid = { id: orderId, customer: { id: 'racer' }, processed_at: clock.toISOString(), line_items: [{ id: 1, quantity: 1, price: '500', title: 'Item' }] };
      await storeWebhook({ shop, topic: 'orders/paid', payload: paid, shopifyWebhookId: crypto.randomUUID() });
      await processPendingWebhooks({ shop });
      clock = new Date(clock.getTime() + 31 * DAY);
      setFixedTime(clock);
      gw.addOrder({ id: orderId, processed_at: paid.processed_at, refunds: [] });

      // The refund is stored (not yet processed); the race is between processing it and redeeming.
      const refundEvent = await storeWebhook({
        shop, topic: 'refunds/create', shopifyWebhookId: crypto.randomUUID(),
        payload: { id: uniqueId(), order_id: orderId, refund_line_items: [{ line_item_id: 1, quantity: 1 }] },
      });

      const barrier = makeBarrier(i % 2 === 0 ? 'refund' : 'redeem');
      ledgerService.setLockHook(barrier.hook);
      let redeemResult;
      try {
        [, redeemResult] = await Promise.all([
          processPendingWebhooks({ shop }),
          redeem({ shop, shopifyCustomerId: 'racer', idempotencyKey: crypto.randomUUID() }),
        ]);
      } finally {
        ledgerService.setLockHook(null);
      }
      assert.ok(barrier.seen.includes('refund') && barrier.seen.includes('redeem'),
        `run ${i}: both the refund and the redeem reached the lock (saw ${barrier.seen.join(',') || 'none'})`);

      // Settle anything the redeem left in flight, then check.
      for (const r of await prisma.redemption.findMany({ where: { shop, status: 'creating' } })) await resolveRedemption(r.id);

      const ev = await prisma.webhookEvent.findUnique({ where: { id: refundEvent.id } });
      assert.strictEqual(ev.status, 'processed', `run ${i}: refund processed (${ev.lastError ?? ''})`);

      const account = await prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: 'racer' } } });
      await assertLedgerBalances(prisma, account.id, `run ${i}`);

      const rewards = await prisma.reward.findMany({ where: { shop } });
      const activeRewardPoints = rewards.filter((r) => r.status === 'active').reduce((t, r) => t + r.pointsUsed, 0);
      assert.strictEqual(account.available + activeRewardPoints - account.debt, 0,
        `run ${i}: entitlement is 0 after a full refund (available ${account.available}, active rewards ${activeRewardPoints}, debt ${account.debt})`);
      assert.strictEqual(account.pending, 0);

      if (rewards.some((r) => r.status === 'returned')) {
        // The reward existed and was voided: by the refund, or at completion if the refund landed while it was being created
        // (in that case the redeem itself answers REWARD_VOIDED).
        assert.ok(redeemResult.ok === true || redeemResult.reason === 'REWARD_VOIDED', `run ${i}: unexpected redeem answer ${JSON.stringify(redeemResult)}`);
        assert.deepStrictEqual([account.available, account.debt], [0, 0]);
        outcomes['redeem won, reward voided']++;
      } else if (redeemResult.ok === false) {
        assert.strictEqual(redeemResult.reason, 'SHORT', `run ${i}: the only valid refusal without a reward is SHORT`);
        assert.deepStrictEqual([rewards.length, account.available, account.debt], [0, 0, 0]);
        outcomes['refund won: redeem refused']++;
      } else {
        // The race fix: a code completed while the customer owes points is voided at once, so a reward that is
        // active while 500 is owed can no longer happen. Reaching this branch is a failure.
        assert.fail(`run ${i}: a reward is active while the customer owes points (available ${account.available}, debt ${account.debt}, active rewards ${activeRewardPoints})`);
      }
    }

    console.log('[concurrency] outcomes over', RUNS, 'runs:', JSON.stringify(outcomes));
    assert.strictEqual(Object.values(outcomes).reduce((t, n) => t + n, 0), RUNS);
    assert.ok(outcomes['refund won: redeem refused'] > 0, 'the refund-first interleaving was exercised');
    assert.ok(outcomes['redeem won, reward voided'] > 0, 'the redeem-first interleaving was exercised');
    assert.strictEqual(outcomes['redeem won, reward active and 500 owed'], 0, 'the race edge no longer leaves an active code with debt');
  });

  test('two refunds of the same order at the same moment (barrier-forced) are applied once each, never twice', async () => {
    const shop = `race2-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    ledgerService.setGatewayFactory(() => new FakeShopifyGateway(shop));
    setFixedTime('2026-09-01T10:00:00Z');
    await prisma.loyaltyConfig.create({
      data: { shop, spendAmountPaise: 100, pointsPerUnit: 1, currency: 'INR', ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
    });
    const orderId = uniqueId();
    await storeWebhook({
      shop, topic: 'orders/paid', shopifyWebhookId: crypto.randomUUID(),
      payload: { id: orderId, customer: { id: 'racer' }, processed_at: '2026-09-01T09:00:00Z', line_items: [{ id: 1, quantity: 4, price: '250', title: 'Item' }] },
    });
    await processPendingWebhooks({ shop });

    // The SAME refund delivered twice under different webhook ids, plus a second, different refund.
    const refundId = uniqueId();
    const body = (id, units) => ({ id, order_id: orderId, refund_line_items: [{ line_item_id: 1, quantity: units }] });
    await storeWebhook({ shop, topic: 'refunds/create', shopifyWebhookId: crypto.randomUUID(), payload: body(refundId, 1) });
    await storeWebhook({ shop, topic: 'refunds/create', shopifyWebhookId: crypto.randomUUID(), payload: body(refundId, 1) });
    await storeWebhook({ shop, topic: 'refunds/create', shopifyWebhookId: crypto.randomUUID(), payload: body(uniqueId(), 1) });

    // Three workers (as if several processes ran a batch) process the same pending events at once.
    const barrier = (() => {
      const waiters = [];
      return async (_accountId, tag) => {
        if (tag !== 'refund' || waiters.length >= 3) return;
        await new Promise((resolve) => {
          waiters.push(resolve);
          if (waiters.length === 3) waiters.forEach((r) => r());
          else setTimeout(resolve, 5000).unref();
        });
      };
    })();
    ledgerService.setLockHook(barrier);
    try {
      await Promise.all([1, 2, 3].map(() => processPendingWebhooks({ shop })));
    } finally {
      ledgerService.setLockHook(null);
    }
    await processPendingWebhooks({ shop }); // anything left over

    const account = await prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: 'racer' } } });
    await assertLedgerBalances(prisma, account.id, 'three workers');
    assert.strictEqual(account.pending, 1000 - 250 - 250, 'two distinct refunds of one unit each; the duplicate added nothing');
    const events = await prisma.webhookEvent.findMany({ where: { shop, topic: 'refunds/create' } });
    assert.deepStrictEqual(events.map((e) => e.status).sort(), ['processed', 'processed', 'skipped']);
  });
});
