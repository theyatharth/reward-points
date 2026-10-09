// web/worker.js
//
// Background worker entry point. Every 30 seconds: processes stored webhook events, retries
// events stuck in processing, activates due pending lots, and (daily) purges old payloads and
// reconciles the ledger. See loyalty/service/jobs.js and reconcile.js.
//   node web/worker.js            (PM2: see deploy/ecosystem.config.cjs)
//
// Settings come from <repo root>/.env, like the web app. The database guard in
// web/lib/prisma.js refuses the production database, so a worker started from a
// production checkout fails at import instead of running.

import './lib/load-env.js'; // MUST stay first: prisma.js reads DATABASE_URL on import
import { prisma } from './lib/prisma.js';
import { startWorker, runTick, createWorkerWork, DEFAULT_INTERVAL_MS } from './loyalty/service/worker.js';

const intervalMs = Number(process.env.WORKER_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
const work = createWorkerWork();
const worker = startWorker({
  intervalMs,
  tick: () => runTick({ work }),
  onTick: (t) => {
    if (t.processed || t.failed || t.error) {
      console.log(`[worker] tick: picked=${t.picked} processed=${t.processed} failed=${t.failed}${t.error ? ' error=' + t.error : ''}`);
    }
  },
});
console.log(`[worker] started (every ${intervalMs} ms)`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} received: finishing the current tick, then exiting`);
  try {
    await worker.stop();
    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    console.error('[worker] error during shutdown:', err.message);
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
