// web/routes/health.js
//
// GET /healthz: 200 {"ok":true} when the app can reach its database (one `SELECT 1`, 3-second limit), 503 {"ok":false} when it
// cannot. No authentication, no shop, no data and no error text in the answer: what failed goes to the log only. Used by nginx,
// uptime checks and the deploy steps. Mounted first in web/index.js, before anything that needs a session.

import express from 'express';
import { prisma } from '../lib/prisma.js';

export const HEALTH_TIMEOUT_MS = 3000;

/** @param {{ check?: () => Promise<unknown>, timeoutMs?: number }} [options] `check` is for tests */
export function createHealthRouter({ check = () => prisma.$queryRaw`SELECT 1`, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const router = express.Router();
  router.get('/healthz', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(check),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`database did not answer within ${timeoutMs} ms`)), timeoutMs); }),
      ]);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[healthz] database check failed:', err.message);
      return res.status(503).json({ ok: false });
    } finally {
      clearTimeout(timer);
    }
  });
  return router;
}
