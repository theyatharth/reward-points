// web/loyalty/service/jobs.js
//
// The background jobs the worker runs besides processing events. Each is a plain async
// function of the database and the clock (adapters/clock.js), so tests drive them with a
// fake clock. `shop` narrows a job to one shop (tests, admin); the worker passes none.
//
//   recoverStuckEvents  events left in 'processing' for more than 10 minutes are retried
//   activateDueLots     pending lots whose hold period is over become available (J3 check
//                       through the gateway; new points repay the owed balance first)
//   expireUnusedCodes   reward codes past their expiry that were never used become 'expired';
//                       their points come back only if the shop's returnPointsOnCodeExpiry is on
//   syncStorefront      dirty accounts' metafields and the redeem-rule metafield are pushed to Shopify
//                       (metafield-sync.js)
//   deleteVoidedCodes   codes voided to cover a return (D4) are deleted in Shopify
//   purgeOldPayloads    processed events older than 90 days lose their payload, nothing else
//
// Reconciliation and the cache rebuild are in reconcile.js. createWorkerWork() ties them
// all together as the work of one worker tick.

import { prisma } from '../../lib/prisma.js';
import { now } from '../adapters/clock.js';
import { retryPlan } from './webhook.js';
import { activatePendingLot, lockAccount, returnPoints, gatewayFactory } from './ledger.js';
import { DEFAULT_CONFIG } from '../rules/config.js';
import { recordJob, ranWithin } from './jobrun.js';
import { runNightlyReconciliation } from './reconcile.js';
import { syncDirtyAccounts, syncRuleMetafields } from './metafield-sync.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const STUCK_AFTER_MS = 10 * MINUTE_MS;
export const PURGE_AFTER_DAYS = 90;
export const ACTIVATION_EVERY_MS = 5 * MINUTE_MS;

const STUCK_BATCH = 200;
const LOT_BATCH = 200;
const PURGE_BATCH = 500;

// ---------------------------------------------------------------------------
// (c) Events stuck in 'processing'
// ---------------------------------------------------------------------------

/**
 * An event is claimed ('processing') before it is handled. If the process dies in between,
 * nothing else would ever pick it up. After 10 minutes it is counted as a failure and
 * retried on the normal schedule (so an event that keeps killing the worker ends up dead).
 * Handling an event writes the ledger and marks the event processed in ONE transaction, so
 * a retry can never apply it twice.
 *
 * @returns {Promise<{ stuck: number, recovered: number, dead: number }>}
 */
export async function recoverStuckEvents({ shop } = {}) {
  const cutoff = new Date(now().getTime() - STUCK_AFTER_MS);
  const stuck = await prisma.webhookEvent.findMany({
    where: { status: 'processing', updatedAt: { lt: cutoff }, ...(shop ? { shop } : {}) },
    select: { id: true, attempts: true },
    orderBy: { updatedAt: 'asc' },
    take: STUCK_BATCH,
  });

  let recovered = 0;
  let dead = 0;
  for (const event of stuck) {
    const attempts = event.attempts + 1;
    const plan = retryPlan(attempts, new Error('stuck'));
    // Only if it is still stuck: it may have finished since it was selected.
    const moved = await prisma.webhookEvent.updateMany({
      where: { id: event.id, status: 'processing', updatedAt: { lt: cutoff } },
      data: {
        status: plan.status,
        attempts,
        nextRetryAt: plan.nextRetryAt,
        lastError: 'Stuck in processing for more than 10 minutes; counted as a failed attempt',
        updatedAt: now(),
      },
    });
    if (moved.count === 1) {
      recovered++;
      if (plan.status === 'dead') dead++;
    }
  }
  return { stuck: stuck.length, recovered, dead };
}

// ---------------------------------------------------------------------------
// (a) Activation of due pending lots
// ---------------------------------------------------------------------------

/**
 * Activates pending lots whose activatesAt has passed. Each goes through activatePendingLot:
 * the J3 check (Shopify must not hold a refund the ledger has not applied), then, under the
 * account lock, the lot is re-read and moved to active, repaying any owed balance first.
 * A lot that fails its J3 check stays pending and is tried again on the next run.
 *
 * @returns {Promise<{ due: number, activated: number, blocked: Array<{ lotId: string, reason: string }> }>}
 */
export async function activateDueLots({ shop } = {}) {
  const lots = await prisma.pointLot.findMany({
    where: { status: 'pending', remaining: { gt: 0 }, activatesAt: { lte: now() }, ...(shop ? { account: { shop } } : {}) },
    select: { id: true, account: { select: { shop: true } } },
    orderBy: { activatesAt: 'asc' },
    take: LOT_BATCH,
  });

  let activated = 0;
  const blocked = [];
  for (const lot of lots) {
    try {
      if (await activatePendingLot(lot.id, lot.account.shop)) activated++;
    } catch (err) {
      blocked.push({ lotId: lot.id, reason: err.message });
    }
  }
  return { due: lots.length, activated, blocked };
}

// ---------------------------------------------------------------------------
// (b2) Expiry of unused reward codes (processDue's "expire codes" step)
// ---------------------------------------------------------------------------

/**
 * An ACTIVE reward whose expiresAt has passed was never used: the Reward and its Redemption
 * become 'expired'. The Shopify discount was created with endsAt = expiresAt, so Shopify has
 * already stopped accepting it and nothing needs to be deleted there.
 *
 * Points come back ONLY when the shop's returnPointsOnCodeExpiry is true (off by default): a
 * 'reward_return' entry and a fresh active lot, repaying any owed balance first. Otherwise the
 * points stay spent. Lot expiry (points expiring with age) is not part of this and stays off.
 * Used, returned (voided) and failed rewards are never touched.
 *
 * Known edge: an order placed with the code just before it expired, whose orders/paid event has
 * not been processed yet, is not seen here; Task 6 handles a late "used" signal for an expired code.
 *
 * @returns {Promise<{ due: number, expired: number, pointsReturned: number }>}
 */
export async function expireUnusedCodes({ shop } = {}) {
  const due = await prisma.reward.findMany({
    where: { status: 'active', expiresAt: { lte: now() }, ...(shop ? { shop } : {}) },
    select: { id: true, shop: true, accountId: true },
    orderBy: { expiresAt: 'asc' },
    take: LOT_BATCH,
  });

  const returnFlag = new Map(); // shop -> returnPointsOnCodeExpiry
  let expired = 0;
  let pointsReturned = 0;
  for (const { id, shop: rewardShop, accountId } of due) {
    if (!returnFlag.has(rewardShop)) {
      const config = await prisma.loyaltyConfig.findUnique({ where: { shop: rewardShop } });
      returnFlag.set(rewardShop, (config || DEFAULT_CONFIG).returnPointsOnCodeExpiry === true);
    }
    const give = returnFlag.get(rewardShop);

    const returned = await prisma.$transaction(async (tx) => {
      await lockAccount(tx, accountId, 'expire');
      const reward = await tx.reward.findUnique({ where: { id } });
      if (!reward || reward.status !== 'active') return null; // used, voided or expired since it was selected

      await tx.reward.update({ where: { id }, data: { status: 'expired' } });
      const redemption = await tx.redemption.findFirst({ where: { accountId, discountCode: reward.discountCode } });
      if (redemption && redemption.status === 'active') {
        await tx.redemption.update({ where: { id: redemption.id }, data: { status: 'expired' } });
      }
      if (!give) return 0;
      await returnPoints(tx, {
        accountId,
        points: reward.pointsUsed,
        lotTag: `reward:${redemption?.id ?? reward.id}`,
        dedupeKey: `reward_return:${redemption?.id ?? reward.id}`,
        note: 'Reward code expired unused — points returned',
        redemptionId: redemption?.id,
        rewardId: reward.id,
      });
      return reward.pointsUsed;
    }, { maxWait: 10000, timeout: 20000 });

    if (returned !== null) {
      expired++;
      pointsReturned += returned;
    }
  }
  return { due: due.length, expired, pointsReturned };
}

// ---------------------------------------------------------------------------
// Deleting voided codes in Shopify (the second half of D4's "void an unused code")
// ---------------------------------------------------------------------------

/**
 * takeBackPoints voids an unused code inside the refund's transaction (Reward 'returned',
 * needsShopifyDelete = true); the Shopify call cannot be made there. This job makes it afterwards:
 * the discount is deleted so the customer can no longer use a code whose points were taken back.
 * A failure leaves the flag set and is retried on the next run. A code with no Shopify id is just cleared.
 *
 * @returns {Promise<{ due: number, deleted: number, failed: Array<{ rewardId: string, reason: string }> }>}
 */
export async function deleteVoidedCodes({ shop } = {}) {
  const due = await prisma.reward.findMany({
    where: { needsShopifyDelete: true, ...(shop ? { shop } : {}) },
    select: { id: true, shop: true, discountCodeId: true },
    orderBy: { returnedAt: 'asc' },
    take: LOT_BATCH,
  });
  let deleted = 0;
  const failed = [];
  for (const reward of due) {
    try {
      if (reward.discountCodeId) await gatewayFactory(reward.shop).deleteRewardDiscount(reward.discountCodeId);
      await prisma.reward.update({ where: { id: reward.id }, data: { needsShopifyDelete: false, shopifyDeletedAt: now() } });
      deleted++;
    } catch (err) {
      failed.push({ rewardId: reward.id, reason: err.message });
    }
  }
  return { due: due.length, deleted, failed };
}

// ---------------------------------------------------------------------------
// (d) 90-day purge of processed event payloads
// ---------------------------------------------------------------------------

/**
 * Replaces the payload of processed events older than 90 days (by receipt time) with
 * { "_purged": true } and stamps payloadPurgedAt. Every other column is kept: topic, status,
 * attempts, ledgerEntryId, timestamps. Events that are not 'processed' (failed, dead, skipped,
 * pending) keep their payload. Safe to repeat: purged events are not selected again.
 *
 * Note: refunds for an order earned BEFORE migration 4 rebuild its line snapshot from the
 * stored orders/paid payload; once that payload is purged, such an order can no longer be
 * refunded by line. Orders earned since migration 4 carry their own snapshot.
 *
 * @returns {Promise<{ purged: number }>}
 */
export async function purgeOldPayloads({ shop, days = PURGE_AFTER_DAYS } = {}) {
  const cutoff = new Date(now().getTime() - days * DAY_MS);
  let purged = 0;
  for (;;) {
    const ids = await prisma.webhookEvent.findMany({
      where: { status: 'processed', payloadPurgedAt: null, createdAt: { lt: cutoff }, ...(shop ? { shop } : {}) },
      select: { id: true },
      take: PURGE_BATCH,
    });
    if (ids.length === 0) break;
    const done = await prisma.webhookEvent.updateMany({
      where: { id: { in: ids.map((e) => e.id) }, status: 'processed', payloadPurgedAt: null },
      data: { payload: { _purged: true }, payloadPurgedAt: now() },
    });
    purged += done.count;
    if (ids.length < PURGE_BATCH) break;
  }
  return { purged };
}

// ---------------------------------------------------------------------------
// The worker tick
// ---------------------------------------------------------------------------

/** Runs one job, writing a JobRun when it did something (or, with `always`, every time). */
async function runJob(jobType, fn, { didSomething, always = false, shop } = {}) {
  const startedAt = now();
  try {
    const result = await fn();
    if (always || didSomething(result)) await recordJob({ jobType, startedAt, status: 'completed', result, shop });
    return result;
  } catch (err) {
    console.error(`[jobs] ${jobType} failed:`, err.message);
    await recordJob({ jobType, startedAt, status: 'failed', error: err.message, shop });
    return null;
  }
}

/**
 * Pushes dirty accounts and a changed rule to the storefront. A run that synced something is recorded;
 * a run that only FAILED is recorded at most once every 10 minutes (a broken Shopify session must not
 * write a JobRun every 30 seconds).
 */
async function runStorefrontSync({ shop } = {}) {
  const startedAt = now();
  try {
    const accounts = await syncDirtyAccounts({ shop });
    const rule = await syncRuleMetafields({ shop });
    const synced = accounts.synced + accounts.gone + rule.synced;
    const failed = accounts.failed.length + rule.failed.length;
    if (synced > 0) {
      await recordJob({ jobType: 'sync_metafields', startedAt, status: 'completed', result: { accounts: { ...accounts, failed: accounts.failed.slice(0, 20) }, rule }, shop });
    } else if (failed > 0 && !(await ranWithin('sync_metafields', 10 * MINUTE_MS, shop ?? null, 'failed'))) {
      await recordJob({ jobType: 'sync_metafields', startedAt, status: 'failed', error: `${failed} sync failure(s)`, result: { accounts: { ...accounts, failed: accounts.failed.slice(0, 20) }, rule }, shop });
    }
    return { accounts, rule };
  } catch (err) {
    console.error('[jobs] sync_metafields failed:', err.message);
    return null;
  }
}

/**
 * The work of one worker tick, after the events themselves have been drained:
 * stuck-event recovery every tick, lot activation every 5 minutes, the purge once a day,
 * the nightly reconciliation. One failing job does not stop the others.
 *
 * @param {Object} [options]
 * @param {string} [options.shop]   narrow every job to one shop (tests)
 * @param {number} [options.activationEveryMs]
 * @returns {() => Promise<Object>} the function a tick runs
 */
export function createJobsWork({ shop, activationEveryMs = ACTIVATION_EVERY_MS } = {}) {
  let lastActivationAt = 0;
  return async function jobsWork() {
    const summary = {};

    summary.stuck = await runJob('recover_stuck', () => recoverStuckEvents({ shop }), { didSomething: (r) => r.recovered > 0, shop });

    if (now().getTime() - lastActivationAt >= activationEveryMs) {
      lastActivationAt = now().getTime();
      summary.activation = await runJob('activate_lots', () => activateDueLots({ shop }), {
        didSomething: (r) => r.activated > 0 || r.blocked.length > 0, shop,
      });
    }

    summary.codes = await runJob('expire_codes', () => expireUnusedCodes({ shop }), { didSomething: (r) => r.expired > 0, shop });

    summary.voided = await runJob('delete_voided_codes', () => deleteVoidedCodes({ shop }), { didSomething: (r) => r.due > 0, shop });

    summary.sync = await runStorefrontSync({ shop });

    if (!(await ranWithin('purge_payloads', 23 * HOUR_MS, shop ?? null))) {
      summary.purge = await runJob('purge_payloads', () => purgeOldPayloads({ shop }), { always: true, shop });
    }

    summary.nightly = await runJob('reconcile_nightly_check', () => runNightlyReconciliation({ shops: shop ? [shop] : undefined }), { didSomething: () => false });
    return summary;
  };
}
