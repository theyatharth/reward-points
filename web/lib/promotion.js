// @ts-check
import { prisma } from './prisma.js';
import { syncPointsBalance, syncPendingSummary } from './shopify-sync.js';

/**
 * Computes this customer's current pending total and earliest eligible
 * date, then syncs it to Shopify metafields for the storefront to display.
 * Called once at the end of promotePendingPoints, after any changes.
 * @param {string} shop
 * @param {string} shopifyGid
 * @param {import('@shopify/shopify-api').GraphqlClient} client
 */
async function syncPendingSummaryNow(shop, shopifyGid, client) {
  const remaining = await prisma.pendingPoint.findMany({
    where: { shop, shopifyCustomerId: shopifyGid },
    orderBy: { eligibleAt: 'asc' },
  });
  const pendingTotal = remaining.reduce((sum, p) => sum + p.points, 0);
  const nextEligibleAt = remaining.length > 0 ? remaining[0].eligibleAt : null;
  await syncPendingSummary(client, shopifyGid, pendingTotal, nextEligibleAt);
}

/**
 * Promotes any of this customer's PendingPoint rows that have crossed their
 * eligibleAt date into spendable CustomerPoint.points — but only after
 * re-verifying each order's current status directly with Shopify first.
 * This is the backstop for the rare case where a REFUNDS_CREATE webhook was
 * missed or delayed: we don't just trust that 30 days of silence means
 * "nothing happened," we actually ask.
 *
 * Cheap on the common path: if nothing is due, this never calls Shopify at
 * all — `getClient` is a lazy callback, only invoked once we know there's
 * real work to do.
 *
 * @param {string} shop
 * @param {string} shopifyGid
 * @param {() => Promise<import('@shopify/shopify-api').GraphqlClient | null>} getClient
 * @returns {Promise<{ changed: boolean }>}
 */
export async function promotePendingPoints(shop, shopifyGid, getClient) {
  const due = await prisma.pendingPoint.findMany({
    where: { shop, shopifyCustomerId: shopifyGid, eligibleAt: { lte: new Date() } },
  });
  if (due.length === 0) return { changed: false };

  const client = await getClient();
  if (!client) {
    // No session available right now — leave pending rows as-is, we'll
    // retry on the next call. Never guess; never promote or discard blind.
    console.warn(`No Shopify client available to check ${due.length} due pending point(s) for ${shopifyGid} on ${shop}. Will retry later.`);
    return { changed: false };
  }

  let changed = false;

  for (const pending of due) {
    let orderIsClean = false;
    try {
      const orderData = await client.request(
        `query checkOrderStatus($id: ID!) {
          order(id: $id) {
            cancelledAt
            displayFinancialStatus
          }
        }`,
        { variables: { id: `gid://shopify/Order/${pending.orderId}` } }
      );
      const order = orderData.data?.order;
      orderIsClean =
        !!order &&
        !order.cancelledAt &&
        !['REFUNDED', 'PARTIALLY_REFUNDED', 'VOIDED'].includes(order.displayFinancialStatus);
    } catch (err) {
      // Couldn't verify — leave it pending rather than guess either way.
      console.error(`Promotion check failed for order ${pending.orderId} (${shopifyGid}):`, err.message);
      continue;
    }

    if (orderIsClean) {
      await prisma.$transaction([
        prisma.customerPoint.upsert({
          where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: shopifyGid } },
          update: { points: { increment: pending.points } },
          create: { shopifyCustomerId: shopifyGid, shop, points: pending.points },
        }),
        prisma.pendingPoint.delete({ where: { id: pending.id } }),
        prisma.pointTransaction.updateMany({
          where: { shop, shopifyCustomerId: shopifyGid, orderId: pending.orderId, status: 'Pending' },
          data: { status: 'Approved' },
        }),
      ]);
      console.log(`Promoted ${pending.points} pending points to spendable for ${shopifyGid} (order ${pending.orderId}).`);
    } else {
      await prisma.$transaction([
        prisma.pendingPoint.delete({ where: { id: pending.id } }),
        prisma.pointTransaction.updateMany({
          where: { shop, shopifyCustomerId: shopifyGid, orderId: pending.orderId, status: 'Pending' },
          data: { status: 'Cancelled' },
        }),
      ]);
      console.log(`Order ${pending.orderId} was refunded/cancelled before release — discarded ${pending.points} pending points for ${shopifyGid}. No debt created.`);
    }
    changed = true;
  }

  if (changed) {
    const updated = await prisma.customerPoint.findUnique({
      where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: shopifyGid } },
    });
    // Floor at 0 for the customer-facing metafield — real (possibly
    // negative) debt still lives in CustomerPoint.points, only the display
    // value shown on the storefront is ever clamped.
    await syncPointsBalance(client, shopifyGid, Math.max(0, updated?.points ?? 0));
    await syncPendingSummaryNow(shop, shopifyGid, client);
  }

  return { changed };
}