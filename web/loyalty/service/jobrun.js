// web/loyalty/service/jobrun.js
//
// JobRun rows: one row per job run that did something (or, for the daily jobs, one per
// day so the "already ran today" check has something to find). A failure to write the
// row is logged and swallowed: bookkeeping must never fail the job itself.

import { prisma } from '../../lib/prisma.js';
import { now } from '../adapters/clock.js';

/**
 * @param {Object} run
 * @param {string} run.jobType
 * @param {Date}   run.startedAt
 * @param {'completed'|'failed'} run.status
 * @param {Object} [run.result]
 * @param {string} [run.error]
 * @param {string} [run.shop]
 */
export async function recordJob({ jobType, startedAt, status, result, error, shop }) {
  try {
    await prisma.jobRun.create({
      data: { jobType, shop: shop ?? null, status, startedAt, completedAt: now(), result: result ?? undefined, error: error ?? null },
    });
  } catch (err) {
    console.error('[jobs] could not write JobRun:', err.message);
  }
}

/**
 * True when a JobRun of this type (and of this shop; null = the global run of the real
 * worker) started within the last `withinMs`, by the job clock. `status` narrows it to completed or failed runs.
 */
export async function ranWithin(jobType, withinMs, shop = null, status = undefined) {
  const since = new Date(now().getTime() - withinMs);
  const last = await prisma.jobRun.findFirst({ where: { jobType, shop, startedAt: { gte: since }, ...(status ? { status } : {}) }, select: { id: true } });
  return last !== null;
}
