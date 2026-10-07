// web/loyalty/service/ledger.js
//
// Core ledger service. Processes WebhookEvents into immutable LedgerEntry rows.
// All operations use Prisma transactions to guarantee atomicity: if an event
// is marked 'processed', the corresponding ledger entries exist.

import { prisma } from '../../lib/prisma.js';
import { computeEarningFromOrder } from '../rules/earning.js';
import { computeReversal, computeCancellation } from '../rules/reversal.js';
import { parsePaise } from '../rules/money.js';
import { DEFAULT_CONFIG } from '../rules/config.js';
import { now } from '../adapters/clock.js';
import { ShopifyGateway } from '../adapters/gateway.js';
import { FakeShopifyGateway } from '../adapters/fake-gateway.js';

// Simple dependency injection / factory for the gateway
export let gatewayFactory = (shop) => {
  if (process.env.NODE_ENV === 'test') return new FakeShopifyGateway(shop);
  return new ShopifyGateway(shop);
};

export function setGatewayFactory(factory) {
  gatewayFactory = factory;
}

/**
 * Main dispatcher. Loads config and routes WebhookEvent to the right handler.
 */
export async function processEvent(event) {
  const configRow = await prisma.loyaltyConfig.findUnique({ where: { shop: event.shop } });
  const config = configRow || DEFAULT_CONFIG;

  if (event.topic === 'ORDERS_PAID' || event.topic === 'orders/paid') {
    return writeEarning(event, config);
  } else if (event.topic === 'REFUNDS_CREATE' || event.topic === 'refunds/create') {
    return writeRefund(event, config);
  } else if (event.topic === 'ORDERS_CANCELLED' || event.topic === 'orders/cancelled') {
    return writeCancel(event, config);
  } else {
    return markSkipped(event.id, `Unhandled topic: ${event.topic}`);
  }
}

/**
 * Ensures a LoyaltyAccount exists for the given shopify customer.
 */
async function ensureAccount(tx, shop, shopifyCustomerId) {
  const strId = String(shopifyCustomerId);
  return tx.loyaltyAccount.upsert({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: strId } },
    update: {},
    create: { shop, shopifyCustomerId: strId },
  });
}

/**
 * Processes an orders/paid webhook event.
 */
export async function writeEarning(event, config) {
  const order = event.payload;

  if (!order.customer || !order.customer.id) {
    return markSkipped(event.id, 'Guest checkout (no customer)');
  }

  const processedAt = new Date(order.processed_at);
  if (config.ledgerStartAt && processedAt < config.ledgerStartAt) {
    return markSkipped(event.id, 'Order predates ledgerStartAt');
  }

  // T2.2: only ask Shopify about collections when some collection is excluded.
  // With an empty list there is nothing to compare against, so no extra call
  // per order. (The lookup result is not yet applied to the earning input.)
  if ((config.excludedCollectionIds || []).length > 0) {
    try {
      const gw = gatewayFactory(event.shop);
      const productIds = (order.line_items || []).map(li => li.product_id).filter(Boolean);
      await gw.getProductCollections(productIds);
    } catch (err) {
      throw new Error('Collection lookup failed: ' + err.message);
    }
  }

  const { points, eligibleAmountPaise } = computeEarningFromOrder(order, config);

  if (points <= 0 && eligibleAmountPaise <= 0) {
    return markSkipped(event.id, 'Order has zero eligible value/points');
  }

  const shopifyOrderId = String(order.id);
  const dedupeKey = `earn:${shopifyOrderId}`;

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Account
      const account = await ensureAccount(tx, event.shop, order.customer.id);

      // 2. PointLot (points are held as pending)
      const activatesAt = new Date(processedAt.getTime() + config.holdPeriodDays * 24 * 60 * 60 * 1000);
      
      const lot = await tx.pointLot.create({
        data: {
          accountId: account.id,
          originalPoints: points,
          remaining: points,
          status: 'pending',
          shopifyOrderId,
          activatesAt,
        },
      });

      // 3. LoyaltyOrder
      const loyaltyOrder = await tx.loyaltyOrder.create({
        data: {
          accountId: account.id,
          shopifyOrderId,
          shop: event.shop,
          pointsEarned: points,
          eligibleAmountPaise,
          processedAt,
          lotId: lot.id,
        },
      });

      // 4. LedgerEntry
      const entry = await tx.ledgerEntry.create({
        data: {
          accountId: account.id,
          type: 'earn',
          points: points, // positive
          status: 'pending',
          dedupeKey,
          note: `Order #${order.order_number || order.name}`,
          lotId: lot.id,
          orderId: loyaltyOrder.id,
        },
      });

      // 5. Update balances
      await tx.loyaltyAccount.update({
        where: { id: account.id },
        data: { pending: { increment: points } },
      });

      // 6. Mark webhook processed
      await tx.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: 'processed',
          ledgerEntryId: entry.id,
          updatedAt: now(),
        },
      });
    });
    return true;
  } catch (err) {
    if (err.code === 'P2002') {
      // Idempotency: already processed by a concurrent run
      return markSkipped(event.id, 'Duplicate: earn entry already exists');
    }
    throw err;
  }
}

/**
 * Helper to mark skipped
 */
async function markSkipped(eventId, reason) {
  await prisma.webhookEvent.update({
    where: { id: eventId },
    data: { status: 'skipped', lastError: reason, updatedAt: now() },
  });
  return true;
}

/**
 * Processes a refunds/create webhook event.
 */
export async function writeRefund(event, config) {
  const payload = event.payload;
  if (!payload.order_id) {
    return markSkipped(event.id, 'Refund payload missing order_id');
  }

  const shopifyOrderId = String(payload.order_id);
  const shopifyRefundId = String(payload.id);
  const dedupeKey = `refund:${shopifyRefundId}`;

  // Find the original LoyaltyOrder
  const loyaltyOrder = await prisma.loyaltyOrder.findUnique({
    where: { shop_shopifyOrderId: { shop: event.shop, shopifyOrderId } },
    include: { lot: true },
  });

  if (!loyaltyOrder) {
    if (!config.ledgerStartAt) {
      return markSkipped(event.id, 'Original order not found in ledger (predates ledger or zero value)');
    }
    // T2.8 Shopify lookup
    try {
      const gw = gatewayFactory(event.shop);
      const shopifyOrder = await gw.getOrder(shopifyOrderId);
      const processedAt = new Date(shopifyOrder.processed_at);
      if (processedAt < config.ledgerStartAt) {
        return markSkipped(event.id, 'Original order not found in ledger (predates ledger)');
      }
    } catch (err) {
      if (err.response && err.response.code === 404) {
        return markSkipped(event.id, 'Original order not found in Shopify either');
      }
      throw err; // retry on network failure
    }
    // If we reach here, it's after ledgerStartAt but missing. Wait for it!
    throw new Error('Original order not yet in ledger, retry later');
  }

  // Calculate refund amount
  const refunds = payload.refund_line_items || [];
  let refundAmountPaise = 0;
  for (const item of refunds) {
    refundAmountPaise += parsePaise(item.subtotal || item.subtotalSet?.shopMoney?.amount || '0');
  }
  // Include order adjustments (shipping refunds)
  for (const adj of payload.order_adjustments || []) {
    refundAmountPaise += parsePaise(adj.amount || '0');
  }
  // Math.abs because adjustments can be negative in Shopify
  refundAmountPaise = Math.abs(refundAmountPaise);

  // Get already reversed points
  const reversedAgg = await prisma.loyaltyRefund.aggregate({
    where: { loyaltyOrderId: loyaltyOrder.id },
    _sum: { pointsReversed: true, refundAmountPaise: true },
  });
  const alreadyReversed = reversedAgg._sum.pointsReversed || 0;
  const alreadyRefundedPaise = reversedAgg._sum.refundAmountPaise || 0;

  const isFinalRefund = (alreadyRefundedPaise + refundAmountPaise) >= loyaltyOrder.eligibleAmountPaise;

  const { pointsToReverse } = computeReversal({
    pointsEarned: loyaltyOrder.pointsEarned,
    eligibleAmountPaise: loyaltyOrder.eligibleAmountPaise,
    totalRefundedPaise: alreadyRefundedPaise + refundAmountPaise,
    alreadyReversed,
    isFinalRefund,
  });

  if (pointsToReverse <= 0) {
    return markSkipped(event.id, 'Refund results in 0 points to reverse');
  }

  try {
    await prisma.$transaction(async (tx) => {
      const lot = loyaltyOrder.lot;
      
      let deductFromPending = 0;
      let deductFromAvailable = 0;

      const deductFromLot = Math.min(pointsToReverse, lot.remaining);
      const leftover = pointsToReverse - deductFromLot;

      if (lot.status === 'pending') {
        deductFromPending = deductFromLot;
        deductFromAvailable = leftover;
      } else {
        // active or exhausted
        deductFromAvailable = pointsToReverse; 
      }

      const newLotRemaining = lot.remaining - deductFromLot;
      const newLotStatus = newLotRemaining === 0 ? 'exhausted' : lot.status;

      // 1. PointLot
      await tx.pointLot.update({
        where: { id: lot.id },
        data: { remaining: newLotRemaining, status: newLotStatus },
      });

      // 2. LoyaltyRefund
      const refundRecord = await tx.loyaltyRefund.create({
        data: {
          accountId: loyaltyOrder.accountId,
          shopifyRefundId,
          shopifyOrderId,
          shop: event.shop,
          pointsReversed: pointsToReverse,
          refundAmountPaise,
          isFullCancellation: false,
          loyaltyOrderId: loyaltyOrder.id,
        },
      });

      // 3. LedgerEntry
      const entry = await tx.ledgerEntry.create({
        data: {
          accountId: loyaltyOrder.accountId,
          type: 'refund',
          points: -pointsToReverse,
          status: 'active',
          dedupeKey,
          note: `Refund on order #${shopifyOrderId}`,
          orderId: loyaltyOrder.id,
          refundId: refundRecord.id,
          lotId: lot.id,
        },
      });

      // 4. Update balances
      await tx.loyaltyAccount.update({
        where: { id: loyaltyOrder.accountId },
        data: {
          pending: { decrement: deductFromPending },
          available: { decrement: deductFromAvailable },
        },
      });

      // 5. Mark webhook processed
      await tx.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: 'processed',
          ledgerEntryId: entry.id,
          updatedAt: now(),
        },
      });
    });
    return true;
  } catch (err) {
    if (err.code === 'P2002') { 
      return markSkipped(event.id, 'Duplicate: refund entry already exists');
    }
    throw err;
  }
}

/**
 * Processes an orders/cancelled webhook event.
 */
export async function writeCancel(event, config) {
  const payload = event.payload;
  const shopifyOrderId = String(payload.id);
  const dedupeKey = `cancel:${shopifyOrderId}`;

  const loyaltyOrder = await prisma.loyaltyOrder.findUnique({
    where: { shop_shopifyOrderId: { shop: event.shop, shopifyOrderId } },
    include: { lot: true },
  });

  if (!loyaltyOrder) {
    if (!config.ledgerStartAt) {
      return markSkipped(event.id, 'Original order not found in ledger');
    }
    // T2.8 Shopify lookup
    try {
      const gw = gatewayFactory(event.shop);
      const shopifyOrder = await gw.getOrder(shopifyOrderId);
      const processedAt = new Date(shopifyOrder.processed_at);
      if (processedAt < config.ledgerStartAt) {
        return markSkipped(event.id, 'Original order not found in ledger (predates ledger)');
      }
    } catch (err) {
      if (err.response && err.response.code === 404) {
        return markSkipped(event.id, 'Original order not found in Shopify either');
      }
      throw err;
    }
    throw new Error('Original order not yet in ledger, retry later');
  }

  const reversedAgg = await prisma.loyaltyRefund.aggregate({
    where: { loyaltyOrderId: loyaltyOrder.id },
    _sum: { pointsReversed: true },
  });
  const alreadyReversed = reversedAgg._sum.pointsReversed || 0;

  const { pointsToReverse } = computeCancellation({
    pointsEarned: loyaltyOrder.pointsEarned,
    alreadyReversed,
  });

  if (pointsToReverse <= 0) {
    return markSkipped(event.id, 'Order cancellation results in 0 points to reverse (already fully refunded/cancelled)');
  }

  try {
    await prisma.$transaction(async (tx) => {
      const lot = loyaltyOrder.lot;
      
      let deductFromPending = 0;
      let deductFromAvailable = 0;

      const deductFromLot = Math.min(pointsToReverse, lot.remaining);
      const leftover = pointsToReverse - deductFromLot;

      if (lot.status === 'pending') {
        deductFromPending = deductFromLot;
        deductFromAvailable = leftover;
      } else {
        deductFromAvailable = pointsToReverse; 
      }

      // 1. PointLot
      await tx.pointLot.update({
        where: { id: lot.id },
        data: { remaining: 0, status: 'cancelled' },
      });

      // 2. LoyaltyRefund (reuse table for cancellations)
      const refundRecord = await tx.loyaltyRefund.create({
        data: {
          accountId: loyaltyOrder.accountId,
          shopifyRefundId: null,
          shopifyOrderId,
          shop: event.shop,
          pointsReversed: pointsToReverse,
          refundAmountPaise: loyaltyOrder.eligibleAmountPaise, // represents full order value
          isFullCancellation: true,
          loyaltyOrderId: loyaltyOrder.id,
        },
      });

      // 3. LedgerEntry
      const entry = await tx.ledgerEntry.create({
        data: {
          accountId: loyaltyOrder.accountId,
          type: 'cancel',
          points: -pointsToReverse,
          status: 'active',
          dedupeKey,
          note: `Cancelled order #${shopifyOrderId}`,
          orderId: loyaltyOrder.id,
          refundId: refundRecord.id,
          lotId: lot.id,
        },
      });

      // 4. Update balances
      await tx.loyaltyAccount.update({
        where: { id: loyaltyOrder.accountId },
        data: {
          pending: { decrement: deductFromPending },
          available: { decrement: deductFromAvailable },
        },
      });

      // 5. Mark webhook processed
      await tx.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: 'processed',
          ledgerEntryId: entry.id,
          updatedAt: now(),
        },
      });
    });
    return true;
  } catch (err) {
    if (err.code === 'P2002') {
      return markSkipped(event.id, 'Duplicate: cancel entry already exists');
    }
    throw err;
  }
}

/**
 * Takes a row lock on the account for the rest of the transaction.
 * Every operation that reads a balance and then decides something from it
 * (redeem, reward return) must call this first.
 */
export async function lockAccount(tx, accountId) {
  const rows = await tx.$queryRaw`SELECT id FROM "LoyaltyAccount" WHERE id = ${accountId} FOR UPDATE`;
  if (rows.length === 0) throw new Error(`LoyaltyAccount ${accountId} not found`);
}

/**
 * J3 check: asks Shopify for the order's refunds and reports any that the
 * ledger has not applied yet. Network call — never run it inside a
 * transaction that holds a lock.
 *
 * Refunds are matched on Shopify's refund id, not counted: cancellations are
 * stored as LoyaltyRefund rows with no Shopify refund id and would otherwise
 * mask a missed refund.
 *
 * @param {{ shopifyOrderId: string }} lot
 * @param {string} loyaltyOrderId
 * @param {string} shop
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'unapplied_refund' | 'lookup_failed', detail: string }>}
 */
export async function checkLotJ3(lot, loyaltyOrderId, shop) {
  let shopifyOrder;
  try {
    shopifyOrder = await gatewayFactory(shop).getOrder(lot.shopifyOrderId);
  } catch (err) {
    return { ok: false, reason: 'lookup_failed', detail: err.message };
  }
  const shopifyRefunds = shopifyOrder?.refunds || [];
  if (shopifyRefunds.length === 0) return { ok: true };

  const applied = await prisma.loyaltyRefund.findMany({
    where: { loyaltyOrderId, shopifyRefundId: { not: null } },
    select: { shopifyRefundId: true },
  });
  const appliedIds = new Set(applied.map((r) => r.shopifyRefundId));
  const unapplied = shopifyRefunds.filter((r) => !appliedIds.has(String(r.id)));
  if (unapplied.length > 0) {
    return { ok: false, reason: 'unapplied_refund', detail: `${unapplied.length} unapplied refund(s) in Shopify` };
  }
  return { ok: true };
}

/**
 * Moves one pending lot to active inside the caller's transaction (the
 * account must already be locked). Re-reads the lot, so a refund that landed
 * after the J3 check is reflected. Returns the points activated, or 0 if the
 * lot is no longer pending.
 */
export async function activateLotInTx(tx, lotId, loyaltyOrderId) {
  const lot = await tx.pointLot.findUnique({ where: { id: lotId } });
  if (!lot || lot.status !== 'pending' || lot.remaining <= 0) return 0;

  await tx.pointLot.update({ where: { id: lot.id }, data: { status: 'active' } });

  await tx.ledgerEntry.create({
    data: {
      accountId: lot.accountId,
      type: 'activate',
      points: 0,
      status: 'active',
      dedupeKey: `activate:${lot.shopifyOrderId}`,
      lotId: lot.id,
      orderId: loyaltyOrderId,
      note: `Activated points for order #${lot.shopifyOrderId}`,
    },
  });

  await tx.loyaltyAccount.update({
    where: { id: lot.accountId },
    data: {
      pending: { decrement: lot.remaining },
      available: { increment: lot.remaining },
    },
  });
  return lot.remaining;
}

/**
 * Activates a pending lot. J3 check: validates against Shopify for missed refunds.
 */
export async function activatePendingLot(lotId, shop) {
  const lot = await prisma.pointLot.findUnique({
    where: { id: lotId },
    include: { account: true, orders: true }
  });
  if (!lot || lot.status !== 'pending') return false;

  const loyaltyOrder = lot.orders[0];
  if (!loyaltyOrder) return false;

  const j3 = await checkLotJ3(lot, loyaltyOrder.id, shop);
  if (!j3.ok) {
    if (j3.reason === 'unapplied_refund') throw new Error('J3 check failed: unapplied refund in Shopify');
    throw new Error('Failed Shopify lookup for J3 check: ' + j3.detail);
  }

  try {
    await prisma.$transaction(async (tx) => {
      await lockAccount(tx, lot.accountId);
      await activateLotInTx(tx, lot.id, loyaltyOrder.id);
    });
    return true;
  } catch (err) {
    if (err.code === 'P2002') {
      // Duplicate activation
      return false;
    }
    throw err;
  }
}
