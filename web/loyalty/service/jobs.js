// web/loyalty/service/jobs.js
//
// The background jobs the worker runs besides processing events. Each is a plain async
// function of the database and the clock (adapters/clock.js), so tests drive them with a
// fake clock. `shop` narrows a job to one shop (tests, admin); the worker passes none.
//
//   recoverStuckEvents  events left in 'processing' for more than 10 minutes are retried
//   activateDueLots     pending lots whose hold period is over become available (J3 check
//                       through the gateway; new points repay the owed balance first)
//   purgeOldPayloads    processed events older than 90 days lose their payload, nothing else
//
// Reconciliation and the cache rebuild are in reconcile.js. createWorkerWork() ties them
// all together as the work of one worker tick.

import { prisma } from '../../lib/prisma.js';
import { now } from '../adapters/clock.js';
import { retryPlan } from './webhook.js';
import { activatePendingLot } from './ledger.js';
import { recordJob, ranWithin } from './jobrun.js';
import { runNightlyReconciliation } from './reconcile.js';

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

    if (!(await ranWithin('purge_payloads', 23 * HOUR_MS, shop ?? null))) {
      summary.purge = await runJob('purge_payloads', () => purgeOldPayloads({ shop }), { always: true, shop });
    }

    summary.nightly = await runJob('reconcile_nightly_check', () => runNightlyReconciliation({ shops: shop ? [shop] : undefined }), { didSomething: () => false });
    return summary;
  };
}
