// @ts-check
import express from 'express';
import { DeliveryMethod } from '@shopify/shopify-api';
import { prisma } from '../lib/prisma.js';
import {
  calculateEarnedPoints,
  calculateDeductedPoints,
  wasRewardCodeUsed,
  HOLD_PERIOD_DAYS,
} from '../lib/points.js';
import {
  syncPointsBalance,
  syncPendingSummary,
  clearDiscountCode,
  recordTransaction,
  getClientForShop,
} from '../lib/shopify-sync.js';
import { promotePendingPoints } from '../lib/promotion.js';
import PrivacyWebhookHandlers from '../privacy.js';

/**
 * Webhook handler for ORDERS_PAID.
 * Awards points to the customer, but holds them as a PendingPoint for
 * HOLD_PERIOD_DAYS rather than crediting spendable CustomerPoint.points
 * directly — this is what makes handleRefundsCreate's clawback meaningful:
 * cancelling a still-pending order costs the customer nothing (nothing was
 * ever spendable), instead of the old buy → earn → redeem → refund exploit.
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

    // Hold, don't credit. upsert-with-no-op-update makes this safe against a
    // retry after a later step in this same try block throws (the catch
    // below releases the ProcessedOrder claim so Shopify redelivers) —
    // without it, a retry's plain .create() would hit PendingPoint's
    // (orderId, shop) unique constraint and fail every time.
    const eligibleAt = new Date(Date.now() + HOLD_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    await prisma.pendingPoint.upsert({
      where: { orderId_shop: { orderId, shop } },
      update: {},
      create: { shopifyCustomerId: shopifyGid, shop, orderId, points: pointsToAward, eligibleAt },
    });

    console.log(`${pointsToAward} points held as pending for order ${orderId}, eligible ${eligibleAt.toISOString()}.`);

    // Sync to Shopify Metafields
    const client = await getClientForShop({ sessionStorage: (await import('../shopify.js')).default.config.sessionStorage, api: (await import('../shopify.js')).default.api }, shop);
    if (client) {
      if (usedReward) {
        const current = await prisma.customerPoint.findUnique({
          where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: shopifyGid } },
        });
        await clearDiscountCode(client, shopifyGid, current?.points ?? 0);
        console.log('Reward code was used — cleared discount code metafield.');
      } else {
        // Spendable balance metafield is untouched — nothing spendable
        // changed. Sync the pending summary instead so the storefront can
        // show "N points pending, available <date>".
        const allPending = await prisma.pendingPoint.findMany({
          where: { shop, shopifyCustomerId: shopifyGid },
          orderBy: { eligibleAt: 'asc' },
        });
        const pendingTotal = allPending.reduce((sum, p) => sum + p.points, 0);
        await syncPendingSummary(client, shopifyGid, pendingTotal, allPending[0]?.eligibleAt ?? null);
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
      'Pending',
      orderId
    );
  } catch (error) {
    // Processing failed after the claim was taken. Release the claim so a
    // Shopify retry (or a manual replay) can redo the work, then rethrow so
    // this delivery reports non-2xx and Shopify actually retries it.
    await prisma.processedOrder.deleteMany({ where: { orderId, shop } }).catch(() => {});
    console.error(`Failed to process reward points for order ${orderId}:`, error.message);
    throw error;
  }
}

/**
 * Webhook handler for REFUNDS_CREATE.
 * Claws back points proportional to the refund amount, pulling from
 * still-pending (unreleased) points first before ever touching spendable
 * balance or creating debt.
 */
async function handleRefundsCreate(topic, shop, body, webhookId) {
  console.log(`\n--- [WEBHOOK] ${topic} for ${shop} ---`);
  const payload = JSON.parse(body);
  if (!payload.order_id) return;

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

  const orderId = String(payload.order_id);

  try {
    const shopifyModule = await import('../shopify.js');
    const shopify = shopifyModule.default;
    const client = await getClientForShop(
      { sessionStorage: shopify.config.sessionStorage, api: shopify.api },
      shop
    );
    if (!client) return;

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
      { variables: { id: `gid://shopify/Order/${orderId}` } }
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
      console.warn(`Order ${orderId} has 50+ refunds — cumulative clawback recompute may undercount past the cap.`);
    }
    let cumulativeRefundedSubtotal = 0;
    for (const refund of refunds) {
      const edges = refund.refundLineItems?.edges || [];
      if (edges.length === 250) {
        console.warn(`A refund on order ${orderId} has 250+ line items — clawback recompute may undercount past the cap.`);
      }
      for (const edge of edges) {
        cumulativeRefundedSubtotal += parseFloat(edge.node.subtotalSet?.shopMoney?.amount || '0');
      }
    }

    const cumulativeTargetPoints = calculateDeductedPoints(cumulativeRefundedSubtotal, settings);

    const alreadyClawed = await prisma.pointTransaction.aggregate({
      where: { shopifyCustomerId: shopifyGid, shop, orderId, points: { lt: 0 } },
      _sum: { points: true },
    });
    const alreadyClawedPoints = Math.abs(alreadyClawed._sum.points ?? 0);

    let pointsToDeduct = cumulativeTargetPoints - alreadyClawedPoints;

    if (pointsToDeduct <= 0) {
      console.log(
        `Refund ${refundId}: no new points to claw back (cumulative target ${cumulativeTargetPoints}, already clawed ${alreadyClawedPoints}).`
      );
      return;
    }

    // --- Pull from PENDING first — this is the whole point of the hold ---
    // If this order's points haven't been released yet, cancelling them
    // costs the customer nothing extra: no debt, no negative balance,
    // because they were never spendable in the first place.
    const pending = await prisma.pendingPoint.findUnique({
      where: { orderId_shop: { orderId, shop } },
    });

    let deductedFromPending = 0;
    if (pending && pending.points > 0) {
      deductedFromPending = Math.min(pointsToDeduct, pending.points);
      const remainingPending = pending.points - deductedFromPending;

      if (remainingPending <= 0) {
        await prisma.$transaction([
          prisma.pendingPoint.delete({ where: { id: pending.id } }),
          prisma.pointTransaction.updateMany({
            where: { shop, shopifyCustomerId: shopifyGid, orderId, status: 'Pending' },
            data: { status: 'Cancelled' },
          }),
        ]);
        console.log(`Refund ${refundId}: fully cancelled ${deductedFromPending} pending (unreleased) points for order ${orderId}. No debt.`);
      } else {
        await prisma.$transaction([
          prisma.pendingPoint.update({ where: { id: pending.id }, data: { points: remainingPending } }),
          prisma.pointTransaction.create({
            data: {
              shopifyCustomerId: shopifyGid, shop,
              action: 'Partial Refund (Pre-Release)',
              points: -deductedFromPending,
              status: 'Reversed',
              orderId,
            },
          }),
        ]);
        console.log(`Refund ${refundId}: partially cancelled ${deductedFromPending} pending points for order ${orderId}; ${remainingPending} still pending.`);
      }
    }

    // --- Anything left over must already have been released — this is the
    // rare late-refund case, and it's the ONLY path that can create debt. ---
    const remainingToDeductFromSpendable = pointsToDeduct - deductedFromPending;

    if (remainingToDeductFromSpendable > 0) {
      const rows = await prisma.$queryRaw`
        UPDATE "CustomerPoint"
           SET points = points - ${remainingToDeductFromSpendable}, "updatedAt" = NOW()
         WHERE "shop" = ${shop} AND "shopifyCustomerId" = ${shopifyGid}
        RETURNING points
      `;

      if (rows.length === 0) {
        console.log(`No CustomerPoint record for ${shopifyGid} — nothing to claw back from spendable balance.`);
      } else {
        const newBalance = rows[0].points;
        if (newBalance < 0) {
          console.warn(`Customer ${shopifyGid} balance is now ${newBalance} (internal only) — refund clawed back already-spent points. Displayed balance is floored at 0.`);
        }

        // Floor at 0 for the customer-facing metafield. The real debt stays
        // in the DB (blocks redemption via calculateRedemption) but is
        // never shown as a negative number to the customer.
        await syncPointsBalance(client, shopifyGid, Math.max(0, newBalance));

        await recordTransaction(
          shopifyGid,
          shop,
          'Refund Deducted',
          -remainingToDeductFromSpendable,
          'Reversed',
          orderId
        );
      }
    }

    console.log(`Refund ${refundId} processed. Pending cancelled: ${deductedFromPending}. Spendable clawed back: ${remainingToDeductFromSpendable}.`);
  } catch (error) {
    await prisma.processedRefund.deleteMany({ where: { refundId, shop } }).catch(() => { });
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
