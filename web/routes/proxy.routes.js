// @ts-check
import crypto from 'crypto';
import express from 'express';
import { prisma } from '../lib/prisma.js';
import { Prisma } from '../../prisma/generated/client/index.js';
import {
  calculateRedemption,
  generateDiscountCode,
} from '../lib/points.js';
import { syncBalanceAndCode, recordTransaction, getClientForShop } from '../lib/shopify-sync.js';

const router = express.Router();

/**
 * Verifies the Shopify App Proxy `signature` query param.
 *
 * IMPORTANT: this is NOT the OAuth HMAC algorithm (shopify.api.utils.validateHmac).
 * App Proxy signs `sha256_hex(secret, sorted "key=value" pairs joined with NO
 * separator)`, whereas OAuth join with "&". Using validateHmac() here rejects
 * every legitimate request, which is why it was previously commented out.
 *
 * Every request that reaches this app through /apps/rewards/* has been
 * forwarded and signed by Shopify's edge — this is what proves that.
 * @param {express.Request} req
 * @param {express.Response} res
 * @param {express.NextFunction} next
 */
function verifyAppProxySignature(req, res, next) {
  const { signature, ...params } = req.query;
  if (typeof signature !== 'string' || !process.env.SHOPIFY_API_SECRET) {
    console.warn('App Proxy: missing signature or secret. Rejecting request.');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const message = Object.keys(params)
    .sort()
    .map((key) => `${key}=${Array.isArray(params[key]) ? params[key].join(',') : params[key]}`)
    .join('');

  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(message, 'utf8')
    .digest('hex');

  const expected = Buffer.from(digest, 'utf8');
  const actual = Buffer.from(String(signature), 'utf8');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    console.warn('App Proxy: invalid signature. Rejecting request.');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * Derives the caller's identity from Shopify's SIGNED query string, never
 * from the request body or client-supplied query params. The body is not
 * covered by the App Proxy signature, so a customerId there is spoofable —
 * this is what previously let any caller redeem/read another customer's
 * points (IDOR). `logged_in_customer_id` and `shop` are injected by Shopify
 * itself and are part of what verifyAppProxySignature just validated.
 * @param {express.Request} req
 * @param {express.Response} res
 * @param {express.NextFunction} next
 */
function requireLoggedInCustomer(req, res, next) {
  const id = req.query.logged_in_customer_id;
  const shop = req.query.shop;
  if (!id || !/^\d+$/.test(String(id))) {
    return res.status(401).json({ error: 'Please log in to your account.' });
  }
  if (!shop || typeof shop !== 'string') {
    return res.status(400).json({ error: 'Missing shop.' });
  }
  res.locals.customerGid = `gid://shopify/Customer/${id}`;
  res.locals.shop = shop;
  next();
}

const RATE_LIMIT_MAX_ATTEMPTS = 3;
const RATE_LIMIT_WINDOW_MINUTES = 10;

/**
 * Postgres-backed rate limiter — one row per (shop, customer), upserted
 * atomically via INSERT ... ON CONFLICT. Replaces an in-memory Map that was
 * per-process (each app instance behind a load balancer had its own
 * independent 3-attempt budget) and grew forever. A single atomic statement
 * means concurrent requests from the same customer serialize on the row
 * lock — there's no read-then-write gap for two requests to both observe
 * "2 attempts so far" and both proceed.
 * @param {express.Request} req
 * @param {express.Response} res
 * @param {express.NextFunction} next
 */
async function proxyRateLimiter(req, res, next) {
  const customerGid = res.locals.customerGid;
  const shop = res.locals.shop;
  if (!customerGid || !shop) return next();

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

    const attempts = Number(rows[0].count);
    if (attempts > RATE_LIMIT_MAX_ATTEMPTS) {
      console.warn(`Rate limit exceeded for customer ${customerGid} on ${shop}`);
      return res.status(429).json({ error: 'Too many redemption attempts. Please wait before trying again.' });
    }
    next();
  } catch (err) {
    // Fail OPEN on limiter infrastructure errors — a DB blip on the rate
    // limiter must not block legitimate redemptions. The atomic reservation
    // in the /redeem handler itself is still what actually prevents
    // overdraft; this limiter is an abuse-throttle on top of that, not the
    // last line of defense.
    console.error('Rate limiter error (failing open):', err.message);
    next();
  }
}

/**
 * Refunds a reservation that was deducted but never turned into a usable
 * discount code (session missing, GraphQL call failed, or Shopify rejected
 * the discount). Points must never be lost for a code the customer never got.
 * @param {string} shop
 * @param {string} shopifyGid
 * @param {number} pointsToDeduct
 */
async function refundReservation(shop, shopifyGid, pointsToDeduct) {
  await prisma.customerPoint.update({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: shopifyGid } },
    data: { points: { increment: pointsToDeduct } },
  });
}

/**
 * Builds the DiscountCodeBasicInput for a reward redemption.
 * - customerSelection binds the code to the redeeming customer only, instead
 *   of `all: true`, so a redeemed code can't be shared/resold as a bearer coupon.
 * - endsAt bounds how long an unused code stays valid.
 * @param {string} code
 * @param {{ discountAmount: number }} redemption
 * @param {string} customerGid
 */
function buildRewardDiscount(code, redemption, customerGid) {
  const endsAt = new Date();
  endsAt.setDate(endsAt.getDate() + 90);
  return {
    title: `Reward Points — ₹${redemption.discountAmount} Off`,
    code,
    startsAt: new Date().toISOString(),
    endsAt: endsAt.toISOString(),
    usageLimit: 1,
    appliesOncePerCustomer: true,
    customerSelection: { customers: { add: [customerGid] } },
    customerGets: {
      value: {
        discountAmount: {
          amount: String(redemption.discountAmount),
          appliesOnEachItem: false,
        },
      },
      items: { all: true },
    },
    // Allow this discount to stack with automatic discounts (e.g. combo bundles)
    // and product discounts (e.g. sale prices on products)
    combinesWith: {
      orderDiscounts: true,
      productDiscounts: true,
      shippingDiscounts: true,
    },
  };
}

/**
 * POST /api/proxy/redeem
 * Called from the storefront widget to redeem points for a discount code.
 * This is a public storefront route (App Proxy) — protected by the App
 * Proxy signature, trusted-identity extraction, and the rate limiter below.
 */
router.post(
  '/redeem',
  express.json(),
  verifyAppProxySignature,
  requireLoggedInCustomer,
  proxyRateLimiter,
  async (req, res) => {
    // Identity comes ONLY from the signed query string (set by
    // requireLoggedInCustomer) — never from the request body, which is not
    // covered by the App Proxy signature and is fully attacker-controlled.
    const shopifyGid = res.locals.customerGid;
    const shop = res.locals.shop;

    try {
      const settings =
        (await prisma.shopSettings.findUnique({ where: { shop } })) ||
        { redeemPoints: 100, discountValue: 10 };

      const record = await prisma.customerPoint.findUnique({
        where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: shopifyGid } },
      });

      const redemption = record && calculateRedemption(record.points, settings);
      if (!redemption) {
        return res.status(400).json({
          error: `You need at least ${settings.redeemPoints} points to redeem.`,
        });
      }

      // --- ATOMIC RESERVE ---
      // The sufficiency check and the deduction happen in ONE statement, so
      // there is no gap for a second concurrent request to read the same
      // starting balance. Postgres serializes concurrent UPDATEs on the same
      // row; a request that loses the race matches zero rows (the WHERE
      // re-checks points >= pointsToDeduct at write time) and is rejected
      // here — before any Shopify API call or discount code is created.
      const reserved = await prisma.$queryRaw`
        UPDATE "CustomerPoint"
           SET points = points - ${redemption.pointsToDeduct}, "updatedAt" = NOW()
         WHERE "shop" = ${shop}
           AND "shopifyCustomerId" = ${shopifyGid}
           AND points >= ${redemption.pointsToDeduct}
        RETURNING points
      `;

      if (reserved.length === 0) {
        return res.status(409).json({
          error: 'Your balance changed. Please refresh and try again.',
        });
      }
      const newBalance = reserved[0].points;

      const shopify = (await import('../shopify.js')).default;
      const client = await getClientForShop(
        { sessionStorage: shopify.config.sessionStorage, api: shopify.api },
        shop
      );
      if (!client) {
        await refundReservation(shop, shopifyGid, redemption.pointsToDeduct);
        return res.status(500).json({ error: 'Store session not found. Please reinstall the app.' });
      }

      const discountCode = generateDiscountCode(shop);
      let discountResponse;
      try {
        discountResponse = await client.request(
          `mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
            discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
              userErrors { field message }
            }
          }`,
          {
            variables: { basicCodeDiscount: buildRewardDiscount(discountCode, redemption, shopifyGid) },
            tries: 3, // retries on THROTTLED without us re-reserving points
          }
        );
      } catch (err) {
        // The mutation call itself failed (network/exhausted retries). Points
        // were already reserved above — give them back, nothing was issued.
        await refundReservation(shop, shopifyGid, redemption.pointsToDeduct);
        console.error('Discount creation request failed, points refunded:', err.message);
        return res.status(500).json({ error: 'Could not generate your code. No points were used.' });
      }

      const errors = discountResponse.data?.discountCodeBasicCreate?.userErrors;
      if (errors && errors.length > 0) {
        // Shopify accepted the call but rejected the discount (e.g. a code
        // collision). Same compensation — no code exists, so no points should
        // have moved.
        await refundReservation(shop, shopifyGid, redemption.pointsToDeduct);
        console.error('Shopify discount creation errors, points refunded:', errors);
        return res.status(500).json({ error: 'Failed to generate discount code. No points were used.' });
      }

      // The code now genuinely exists in Shopify — points are truly spent.
      // Sync + history are best-effort from here on; their failure must NOT
      // re-credit points, since the customer already holds a real, usable code.
      await syncBalanceAndCode(client, shopifyGid, newBalance, discountCode);

      await recordTransaction(
        shopifyGid,
        shop,
        `Redeemed ₹${redemption.discountAmount} Coupon`,
        -redemption.pointsToDeduct
      );

      return res.json({
        success: true,
        newBalance,
        discountCode,
      });
    } catch (error) {
      console.error('Redemption error:', error);
      return res.status(500).json({ error: 'Failed to process redemption.' });
    }
  }
);

/**
 * GET /api/proxy/history
 * Returns the reward history for the CALLING customer from the local DB.
 * Called by the storefront rewards page. Previously had no auth at all —
 * any caller could enumerate any customer's order/point history by GID.
 */
router.get('/history', verifyAppProxySignature, requireLoggedInCustomer, async (req, res) => {
  const shopifyGid = res.locals.customerGid;
  const shop = res.locals.shop;

  try {
    const transactions = await prisma.pointTransaction.findMany({
      where: { shopifyCustomerId: shopifyGid, shop },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return res.json({ success: true, history: transactions });
  } catch (error) {
    console.error('History fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch history.' });
  }
});

export default router;
