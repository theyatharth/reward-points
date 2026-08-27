// @ts-check
import express from 'express';
import { prisma } from '../lib/prisma.js';

const router = express.Router();

/**
 * Validates merchant settings values.
 * All four fields must be positive integers within a sane range.
 * @param {any} body
 * @returns {{ valid: boolean, errors: Record<string, string> }}
 */
function validateSettings(body) {
  const errors = {};
  const fields = {
    spendAmount: 'Spend amount',
    earnPoints: 'Earn points',
    redeemPoints: 'Redeem points',
    discountValue: 'Discount value',
  };

  for (const [key, label] of Object.entries(fields)) {
    const raw = body[key];
    const val = parseInt(raw, 10);
    if (isNaN(val) || val <= 0) {
      errors[key] = `${label} must be a positive number.`;
    } else if (val > 100_000) {
      errors[key] = `${label} cannot exceed 100,000.`;
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * GET /api/settings
 * Returns the current reward settings for the authenticated merchant.
 * Creates default settings if the shop hasn't configured them yet.
 */
router.get('/settings', async (req, res) => {
  const shop = res.locals.shopify.session.shop;
  try {
    let settings = await prisma.shopSettings.findUnique({ where: { shop } });
    if (!settings) {
      settings = await prisma.shopSettings.create({ data: { shop } });
    }
    return res.status(200).json(settings);
  } catch (error) {
    console.error('Failed to fetch settings:', error);
    // Return safe defaults if DB is not yet set up (migration not run)
    return res.status(200).json({
      spendAmount: 100, earnPoints: 1, redeemPoints: 100, discountValue: 10
    });
  }
});

/**
 * POST /api/settings
 * Saves reward settings for the authenticated merchant.
 */
router.post('/settings', async (req, res) => {
  const shop = res.locals.shopify.session.shop;
  const { spendAmount, earnPoints, redeemPoints, discountValue } = req.body;

  const { valid, errors } = validateSettings({ spendAmount, earnPoints, redeemPoints, discountValue });
  if (!valid) {
    return res.status(422).json({ error: 'Validation failed.', fields: errors });
  }

  try {
    const settings = await prisma.shopSettings.upsert({
      where: { shop },
      update: {
        spendAmount: parseInt(spendAmount, 10),
        earnPoints: parseInt(earnPoints, 10),
        redeemPoints: parseInt(redeemPoints, 10),
        discountValue: parseInt(discountValue, 10),
      },
      create: {
        shop,
        spendAmount: parseInt(spendAmount, 10),
        earnPoints: parseInt(earnPoints, 10),
        redeemPoints: parseInt(redeemPoints, 10),
        discountValue: parseInt(discountValue, 10),
      },
    });
    return res.status(200).json(settings);
  } catch (error) {
    console.error('Failed to save settings:', error);
    return res.status(500).json({ error: 'Could not save settings. Please try again.' });
  }
});

/**
 * GET /api/customers/points
 * Returns all customers with their point balances.
 * Supports optional search by shopifyCustomerId.
 */
router.get('/customers/points', async (req, res) => {
  const shop = res.locals.shopify.session.shop;
  try {
    const customers = await prisma.customerPoint.findMany({
      where: { shop },
      orderBy: { points: 'desc' },
      take: 100,
    });
    return res.status(200).json(customers);
  } catch (error) {
    console.error('Failed to fetch customers:', error);
    return res.status(500).json({ error: 'Could not load customers.' });
  }
});

/**
 * POST /api/customers/adjust
 * Manually awards or deducts points for a specific customer.
 * Body: { shopifyCustomerId, points (positive=award, negative=deduct), reason }
 */
router.post('/customers/adjust', async (req, res) => {
  const shop = res.locals.shopify.session.shop;
  const { shopifyCustomerId, points, reason } = req.body;

  if (!shopifyCustomerId || typeof shopifyCustomerId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid shopifyCustomerId.' });
  }
  const parsedPoints = parseInt(points, 10);
  if (isNaN(parsedPoints) || parsedPoints === 0) {
    return res.status(400).json({ error: 'Points must be a non-zero integer.' });
  }
  if (!reason || String(reason).trim().length === 0) {
    return res.status(400).json({ error: 'A reason is required for manual adjustments.' });
  }

  try {
    const record = await prisma.customerPoint.upsert({
      where: { shop_shopifyCustomerId: { shop, shopifyCustomerId } },
      update: { points: { increment: parsedPoints } },
      create: { shopifyCustomerId, shop, points: Math.max(0, parsedPoints) },
    });

    // Prevent negative balances
    if (record.points < 0) {
      await prisma.customerPoint.update({
        where: { shop_shopifyCustomerId: { shop, shopifyCustomerId } },
        data: { points: 0 },
      });
      record.points = 0;
    }

    // Record in history
    const { recordTransaction } = await import('../lib/shopify-sync.js');
    const action = parsedPoints > 0
      ? `Manual Award: ${reason}`
      : `Manual Deduction: ${reason}`;
    const status = parsedPoints > 0 ? 'Approved' : 'Reversed';
    await recordTransaction(shopifyCustomerId, shop, action, parsedPoints, status);

    // Also sync to Shopify Metafields so the storefront shows the updated balance
    try {
      const shopify = (await import('../shopify.js')).default;
      const { getClientForShop, syncPointsBalance } = await import('../lib/shopify-sync.js');
      const client = await getClientForShop(
        { sessionStorage: shopify.config.sessionStorage, api: shopify.api },
        shop
      );
      if (client) {
        await syncPointsBalance(client, shopifyCustomerId, record.points);
      }
    } catch (syncErr) {
      console.warn('Could not sync metafield after adjustment:', syncErr.message);
    }

    return res.status(200).json({ success: true, newBalance: record.points });
  } catch (error) {
    console.error('Manual adjustment error:', error);
    return res.status(500).json({ error: 'Failed to adjust points.' });
  }
});

/**
 * GET /api/customers/:customerId/history
 * Returns the point transaction history for a specific customer.
 */
router.get('/customers/:customerId/history', async (req, res) => {
  const shop = res.locals.shopify.session.shop;
  const { customerId } = req.params;

  try {
    const transactions = await prisma.pointTransaction.findMany({
      where: { shopifyCustomerId: customerId, shop },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return res.status(200).json(transactions);
  } catch (error) {
    console.error('History fetch error:', error);
    return res.status(500).json({ error: 'Could not fetch transaction history.' });
  }
});

export default router;
