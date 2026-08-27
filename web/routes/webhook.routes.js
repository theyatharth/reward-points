// @ts-check
import express from 'express';
import { DeliveryMethod } from '@shopify/shopify-api';
import { prisma } from '../lib/prisma.js';
import {
  calculateEarnedPoints,
  calculateDeductedPoints,
  wasRewardCodeUsed,
} from '../lib/points.js';
import {
  syncPointsBalance,
  clearDiscountCode,
  recordTransaction,
  getClientForShop,
} from '../lib/shopify-sync.js';
import PrivacyWebhookHandlers from '../privacy.js';

/**
 * Webhook handler for ORDERS_PAID.
 * Awards dynamic points to the customer based on merchant settings.
 * Protected against duplicate delivery via ProcessedOrder idempotency table.
 */
async function handleOrdersPaid(topic, shop, body, webhookId) {
  console.log(`\n--- [WEBHOOK] ${topic} for ${shop} ---`);
  const payload = JSON.parse(body);
  const orderId = String(payload.id);
  const customerId = payload.customer?.id;

  if (!customerId) {
    console.log('No customer on order (guest checkout). Skipping.');
    return;
  }

  // --- IDEMPOTENCY CLAIM ---
  // Insert-first: the unique constraint on (orderId, shop) IS the lock.
  // The old check-then-create pattern had a gap where two concurrent
  // deliveries of the same webhook could both pass the check and both
  // award points. Losing this race is expected — it just means another
  // delivery already owns this order.
  try {
    await prisma.processedOrder.create({ data: { orderId, shop } });
  } catch (err) {
    if (err.code === 'P2002') {
      console.log(`Order ${orderId} already processed. Skipping duplicate webhook.`);
      return;
    }
    throw err;
  }

  const shopifyGid = `gid://shopify/Customer/${customerId}`;

  try {
    // Fetch merchant settings (fall back to defaults if not configured yet)
    const settings = (await prisma.shopSettings.findUnique({ where: { shop } })) || {
      spendAmount: 100,
      earnPoints: 1,
    };

    const subtotal = parseFloat(payload.subtotal_price || '0');
    const pointsToAward = calculateEarnedPoints(subtotal, settings);

    console.log(
      `Order #${payload.order_number} | Subtotal: ${subtotal} | Points to award: ${pointsToAward}`
    );

    if (pointsToAward <= 0) {
      console.log('Order total too low to earn points. Skipping.');
      return;
    }

    const usedReward = wasRewardCodeUsed(payload, shop);

    const record = await prisma.customerPoint.upsert({
      where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: shopifyGid } },
      update: { points: { increment: pointsToAward } },
      create: { shopifyCustomerId: shopifyGid, shop, points: pointsToAward },
    });

    console.log(`Points updated in DB. New balance: ${record.points}`);

    // Sync to Shopify Metafields
    const client = await getClientForShop({ sessionStorage: (await import('../shopify.js')).default.config.sessionStorage, api: (await import('../shopify.js')).default.api }, shop);
    if (client) {
      if (usedReward) {
        await clearDiscountCode(client, shopifyGid, record.points);
        console.log('Reward code was used — cleared discount code metafield.');
      } else {
        await syncPointsBalance(client, shopifyGid, record.points);
      }
    } else {
      console.warn(`No offline session for ${shop} — metafields not synced for order ${orderId}.`);
    }

    // Record in local DB history
    await recordTransaction(
      shopifyGid,
      shop,
      `Order #${payload.order_number}`,
      pointsToAward,
      'Approved',
      orderId
    );
  } catch (error) {
    // Processing failed after the claim was taken. Release the claim so a
    // Shopify retry (or a manual replay) can redo the work, then rethrow so
    // this delivery reports non-2xx and Shopify actually retries it —
    // swallowing the error here previously turned a retryable failure (e.g.
    // an RDS blip) into permanent, unrecoverable point loss.
    await prisma.processedOrder.deleteMany({ where: { orderId, shop } }).catch(() => {});
    console.error(`Failed to process reward points for order ${orderId}:`, error.message);
    throw error;
  }
}

/**
 * Webhook handler for REFUNDS_CREATE.
 * Claws back points proportional to the refund amount.
 */
async function handleRefundsCreate(topic, shop, body, webhookId) {
  console.log(`\n--- [WEBHOOK] ${topic} for ${shop} ---`);
  const payload = JSON.parse(body);
  if (!payload.order_id) return;

  // --- IDEMPOTENCY CLAIM ---
  // Keyed on the REFUND's own id, not order_id — one order can have several
  // distinct refunds, each of which must be clawed back exactly once. Same
  // insert-first pattern as handleOrdersPaid: the unique constraint is the lock.
  const refundId = String(payload.id);
  try {
    await prisma.processedRefund.create({ data: { refundId, shop } });
  } catch (err) {
    if (err.code === 'P2002') {
      console.log(`Refund ${refundId} already processed. Skipping duplicate webhook.`);
      return;
    }
    throw err;
  }

  try {
    const shopifyModule = await import('../shopify.js');
    const shopify = shopifyModule.default;
    const client = await getClientForShop(
      { sessionStorage: shopify.config.sessionStorage, api: shopify.api },
      shop
    );
    if (!client) return;

    // Look up the customer AND every refund issued against this order so far
    // (not just this one). A single refund's subtotal is the wrong basis for
    // flooring points math: two separate ₹99 refunds on a spendAmount=100
    // order each floor(0.99) to 0 points clawed back even though ₹198 was
    // actually returned. Recomputing against the cumulative refunded total
    // and diffing against what we've already clawed back (below) fixes that
    // regardless of how the refund was split across events.
    const orderData = await client.request(
      `query getOrderRefundState($id: ID!) {
        order(id: $id) {
          customer { id }
          refunds(first: 50) {
            refundLineItems(first: 250) {
              edges { node { subtotalSet { shopMoney { amount } } } }
            }
          }
        }
      }`,
      { variables: { id: `gid://shopify/Order/${payload.order_id}` } }
    );
    const order = orderData.data.order;
    const shopifyGid = order?.customer?.id;
    if (!shopifyGid) {
      console.log('No customer on refunded order. Skipping clawback.');
      return;
    }

    const settings = (await prisma.shopSettings.findUnique({ where: { shop } })) || {
      spendAmount: 100,
      earnPoints: 1,
    };

    const refunds = order.refunds || [];
    if (refunds.length === 50) {
      console.warn(`Order ${payload.order_id} has 50+ refunds — cumulative clawback recompute may undercount past the cap.`);
    }
    let cumulativeRefundedSubtotal = 0;
    for (const refund of refunds) {
      const edges = refund.refundLineItems?.edges || [];
      if (edges.length === 250) {
        console.warn(`A refund on order ${payload.order_id} has 250+ line items — clawback recompute may undercount past the cap.`);
      }
      for (const edge of edges) {
        cumulativeRefundedSubtotal += parseFloat(edge.node.subtotalSet?.shopMoney?.amount || '0');
      }
    }

    const cumulativeTargetPoints = calculateDeductedPoints(cumulativeRefundedSubtotal, settings);

    // What we've already clawed back for THIS order, from our own ledger —
    // orderId scopes this to refund-triggered rows only (manual adjustments
    // never set orderId), so this can't be thrown off by unrelated deductions.
    const alreadyClawed = await prisma.pointTransaction.aggregate({
      where: { shopifyCustomerId: shopifyGid, shop, orderId: String(payload.order_id), points: { lt: 0 } },
      _sum: { points: true },
    });
    const alreadyClawedPoints = Math.abs(alreadyClawed._sum.points ?? 0);

    const pointsToDeduct = cumulativeTargetPoints - alreadyClawedPoints;

    if (pointsToDeduct <= 0) {
      console.log(
        `Refund ${refundId}: no new points to claw back (cumulative target ${cumulativeTargetPoints}, already clawed ${alreadyClawedPoints}).`
      );
      return;
    }

    // Single atomic statement, and — deliberately — NO floor at zero.
    // Flooring the balance to 0 here was the actual vulnerability: it
    // silently forgave debt for points that had already been redeemed for a
    // real discount code, i.e. buy → earn → redeem → refund → repeat was
    // free merchandise on every cycle. A negative balance is a legitimate
    // debt; calculateRedemption() already refuses to redeem while balance
    // is below the redeem threshold, so debt correctly blocks new redemptions
    // until the customer earns their way back to non-negative.
    const rows = await prisma.$queryRaw`
      UPDATE "CustomerPoint"
         SET points = points - ${pointsToDeduct}, "updatedAt" = NOW()
       WHERE "shop" = ${shop} AND "shopifyCustomerId" = ${shopifyGid}
      RETURNING points
    `;

    if (rows.length === 0) {
      console.log(`No CustomerPoint record for ${shopifyGid} — nothing to claw back.`);
      return;
    }
    const newBalance = rows[0].points;
    if (newBalance < 0) {
      console.warn(`Customer ${shopifyGid} balance is now ${newBalance} — refund clawed back already-redeemed points.`);
    }

    await syncPointsBalance(client, shopifyGid, newBalance);

    await recordTransaction(
      shopifyGid,
      shop,
      'Refund Deducted',
      -pointsToDeduct,
      'Reversed',
      String(payload.order_id)
    );

    console.log(`Refund processed. Reversed ${pointsToDeduct} points. New balance: ${newBalance}`);
  } catch (error) {
    // Release the claim so a retry can redo the work, then rethrow so
    // Shopify sees a failure and actually retries (see handleOrdersPaid).
    await prisma.processedRefund.deleteMany({ where: { refundId, shop } }).catch(() => {});
    console.error(`Refund processing error for refund ${refundId}:`, error.message);
    throw error;
  }
}

/**
 * Webhook handler for APP_UNINSTALLED.
 * Cleans up the merchant's sessions from the session storage.
 */
async function handleAppUninstalled(topic, shop, body, webhookId) {
  console.log(`\n--- [WEBHOOK] ${topic} for ${shop} ---`);
  try {
    const shopify = (await import('../shopify.js')).default;
    await shopify.config.sessionStorage.deleteSessions(shop);
    console.log(`Sessions cleared for uninstalled shop: ${shop}`);
  } catch (error) {
    console.error('Failed to clean up sessions on uninstall:', error.message);
  }
}

/**
 * Combined webhook handlers object — merges Shopify privacy requirements
 * with our custom business logic handlers.
 */
export const webhookHandlers = {
  ...PrivacyWebhookHandlers,
  ORDERS_PAID: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: '/api/webhooks',
    callback: handleOrdersPaid,
  },
  REFUNDS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: '/api/webhooks',
    callback: handleRefundsCreate,
  },
  APP_UNINSTALLED: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: '/api/webhooks',
    callback: handleAppUninstalled,
  },
};
