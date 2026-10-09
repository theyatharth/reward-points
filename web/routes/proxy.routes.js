// @ts-check
//
// Storefront App Proxy routes (/apps/<subpath>/... on the shop, forwarded here and signed by Shopify):
//   POST /api/proxy/redeem    redeem the calling customer's points for one reward code
//   GET  /api/proxy/history   the calling customer's balances, rewards and history
//
// Every request is HMAC-verified (web/lib/app-proxy.js); the customer is the signed
// `logged_in_customer_id`, never a body field; responses are whitelists (storefront.js, decision D6).
// All the work is in web/loyalty/service/: this file only does HTTP.

import crypto from 'node:crypto';
import express from 'express';
import { prisma } from '../lib/prisma.js';
import { Prisma } from '../../prisma/generated/client/index.js';
import { verifyAppProxySignature, requireLoggedInCustomer } from '../lib/app-proxy.js';
import { redeemForCustomer, customerView, shopIsConfigured } from '../loyalty/service/storefront.js';

const router = express.Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const RATE_LIMIT_MAX_ATTEMPTS = 3;
const RATE_LIMIT_WINDOW_MINUTES = 10;

/**
 * Postgres-backed rate limiter: one row per (shop, customer), upserted atomically. An abuse throttle on
 * top of the ledger's own locking, not the last line of defence, so it fails OPEN on its own errors.
 */
async function proxyRateLimiter(_req, res, next) {
  const { shop, customerId } = res.locals;
  const customerGid = `gid://shopify/Customer/${customerId}`;
  try {
    const rows = await prisma.$queryRaw`
      INSERT INTO "RedemptionAttempt" (id, "shop", "customerGid", "windowStart", "count", "updatedAt")
      VALUES (${crypto.randomUUID()}, ${shop}, ${customerGid}, NOW(), 1, NOW())
      ON CONFLICT ("shop", "customerGid") DO UPDATE SET
        "count" = CASE
          WHEN "RedemptionAttempt"."windowStart" < NOW() - INTERVAL '${Prisma.raw(String(RATE_LIMIT_WINDOW_MINUTES))} minutes' THEN 1
          ELSE "RedemptionAttempt"."count" + 1
        END,
        "windowStart" = CASE
          WHEN "RedemptionAttempt"."windowStart" < NOW() - INTERVAL '${Prisma.raw(String(RATE_LIMIT_WINDOW_MINUTES))} minutes' THEN NOW()
          ELSE "RedemptionAttempt"."windowStart"
        END,
        "updatedAt" = NOW()
      RETURNING "count"
    `;
    if (Number(rows[0].count) > RATE_LIMIT_MAX_ATTEMPTS) {
      return res.status(429).json({ success: false, reason: 'RATE_LIMITED', message: 'Too many redemption attempts. Please wait a few minutes.' });
    }
  } catch (err) {
    console.error('Rate limiter error (failing open):', err.message);
  }
  next();
}

async function requireConfiguredShop(_req, res, next) {
  if (!(await shopIsConfigured(res.locals.shop))) return res.status(404).json({ success: false, error: 'Rewards are not set up for this store.' });
  next();
}

router.post(
  '/redeem',
  express.json({ limit: '2kb' }),
  verifyAppProxySignature,
  requireLoggedInCustomer,
  requireConfiguredShop,
  proxyRateLimiter,
  async (req, res) => {
    const headerKey = req.get('Idempotency-Key');
    const bodyKey = req.body && typeof req.body === 'object' ? req.body.idempotencyKey : undefined;
    const idempotencyKey = typeof headerKey === 'string' && headerKey ? headerKey : bodyKey;
    try {
      const { status, body } = await redeemForCustomer({
        shop: res.locals.shop,
        shopifyCustomerId: res.locals.customerId,
        idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : '',
      });
      return res.status(status).json(body);
    } catch (err) {
      console.error('Redemption error:', err.message);
      return res.status(500).json({ success: false, message: 'Failed to process redemption.' });
    }
  }
);

router.get('/history', verifyAppProxySignature, requireLoggedInCustomer, requireConfiguredShop, async (_req, res) => {
  try {
    return res.json(await customerView({ shop: res.locals.shop, shopifyCustomerId: res.locals.customerId }));
  } catch (err) {
    console.error('History error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch history.' });
  }
});

export default router;
