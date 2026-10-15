// web/loyalty/service/worker.js
//
// The background worker's core (T3.5, minimal slice): process stored webhook
// events on a timer. The entry point is web/worker.js; this file holds the logic
// so it can be tested without starting a process.
//
//   * One tick = take a Postgres advisory lock, process pending events, release it.
//   * The lock is a TRANSACTION-level advisory lock held on one dedicated
//     connection for the whole tick. It is released when the transaction ends,
//     whether the tick finishes, throws, or the process dies (the connection
//     drops), so a crashed tick can never leave the lock held.
//   * A JobRun row is written only for ticks that processed an event, saw an
//     event fail, or threw. Quiet ticks write no JobRun (no row every 30 s) but
//     DO update the one WorkerHeartbeat row (the admin Overview's "last worker tick").

import { prisma } from '../../lib/prisma.js';
import { now } from '../adapters/clock.js';
import { processPendingWebhooksWithStats } from './webhook.js';
import { recordJob } from './jobrun.js';
import { createJobsWork } from './jobs.js';

export const WORKER_LOCK_KEY = 7284140001; // arbitrary constant, unique to this job
export const DEFAULT_INTERVAL_MS = 30_000;
const MAX_TICK_MS = 10 * 60 * 1000;
const MAX_BATCHES_PER_TICK = 10; // 10 x 50 events, then yield until the next tick

/** Default work for a tick: drain pending events, batch by batch. */
export async function drainPendingEvents(options = {}) {
  const total = { picked: 0, processed: 0, failed: 0 };
  for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
    const batch = await processPendingWebhooksWithStats(options);
    total.picked += batch.picked;
    total.processed += batch.processed;
    total.failed += batch.failed;
    if (batch.picked < 50) break;
  }
  return total;
}

/**
 * The work of the real worker's tick: drain the pending events first (so refunds are applied
 * before any J3 check), then the other jobs (jobs.js). Returns the event stats, which is what
 * a tick reports; every other job writes its own JobRun.
 * @param {Object} [options]
 * @param {string} [options.shop] narrow everything to one shop (tests)
 */
export function createWorkerWork(options = {}) {
  const jobs = createJobsWork(options);
  return async () => {
    const events = await drainPendingEvents(options.shop ? { shop: options.shop } : {});
    await jobs();
    return events;
  };
}

/** Upserts this loop's heartbeat. Bookkeeping: a failure is logged and never fails the tick. */
export async function beat(name, { ran, failed }) {
  const lastTickAt = now();
  try {
    await prisma.workerHeartbeat.upsert({
      where: { name },
      create: { name, lastTickAt, lastTickRan: ran, lastTickFailed: failed },
      update: { lastTickAt, lastTickRan: ran, lastTickFailed: failed },
    });
  } catch (err) {
    console.error('[worker] could not write the heartbeat:', err.message);
  }
}

/**
 * Runs one tick.
 * @param {Object} [options]
 * @param {() => Promise<{picked:number, processed:number, failed:number}>} [options.work]
 * @param {string} [options.jobType]
 * @param {number} [options.lockKey]
 * @returns {Promise<{ ran: boolean, picked: number, processed: number, failed: number, error?: string }>}
 *   ran=false means another worker held the lock and nothing was done.
 */
export async function runTick({ work = drainPendingEvents, jobType = 'process_events', lockKey = WORKER_LOCK_KEY } = {}) {
  const startedAt = now();
  const outcome = { ran: false, picked: 0, processed: 0, failed: 0 };

  try {
    await prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${String(lockKey)}::bigint) AS locked`;
        if (!rows[0].locked) return; // another worker has it: skip this tick
        outcome.ran = true;
        Object.assign(outcome, await work()); // a throw here rolls the transaction back and frees the lock
      },
      { maxWait: 10_000, timeout: MAX_TICK_MS }
    );
  } catch (err) {
    outcome.error = err.message;
    console.error('[worker] tick failed:', err.message);
    await recordJob({ jobType, startedAt, status: 'failed', error: err.message, result: { processed: outcome.processed, failed: outcome.failed } });
    await beat(jobType, { ran: outcome.ran, failed: true });
    return outcome;
  }

  if (outcome.ran && (outcome.processed > 0 || outcome.failed > 0)) {
    await recordJob({ jobType, startedAt, status: 'completed', result: { picked: outcome.picked, processed: outcome.processed, failed: outcome.failed } });
  }
  await beat(jobType, { ran: outcome.ran, failed: false });
  return outcome;
}

/**
 * Starts the loop: a tick now, then one every intervalMs, never overlapping.
 * stop() prevents further ticks and resolves after the in-flight tick finishes.
 */
export function startWorker({ intervalMs = DEFAULT_INTERVAL_MS, tick = runTick, onTick = () => {} } = {}) {
  let stopped = false;
  let timer = null;
  let inFlight = Promise.resolve();

  const loop = async () => {
    if (stopped) return;
    inFlight = (async () => {
      try {
        onTick(await tick());
      } catch (err) {
        console.error('[worker] unexpected error in tick:', err.message);
      }
    })();
    await inFlight;
    if (!stopped) timer = setTimeout(loop, intervalMs);
  };
  timer = setTimeout(loop, 0);

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
}
