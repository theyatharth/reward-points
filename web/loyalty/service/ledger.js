// web/loyalty/service/ledger.js
//
// Core ledger service. Processes WebhookEvents into immutable LedgerEntry rows.
// All operations use Prisma transactions to guarantee atomicity: if an event
// is marked 'processed', the corresponding ledger entries exist.

import { prisma } from '../../lib/prisma.js';
import { computeEarningFromOrder } from '../rules/earning.js';
import { computeCancellation } from '../rules/reversal.js';
import { refundEntries, priorQuantities, computeLineReversal, RefundDataError } from '../rules/refund-lines.js';
import { DEFAULT_CONFIG } from '../rules/config.js';
import { now } from '../adapters/clock.js';
import { normalizeTopic } from './topics.js';
import { PermanentError } from './errors.js';
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

  // Accept both forms: new events are stored in the slash form, but rows stored
  // before the intake map existed hold the library's enum form ("ORDERS_PAID").
  const topic = normalizeTopic(event.topic);

  // A payload that is not a JSON object cannot be processed by any handler, however often
  // it is retried: dead at once, reason in lastError.
  if (['orders/paid', 'refunds/create', 'orders/cancelled'].includes(topic) &&
      (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload))) {
    const found = event.payload === null ? 'null' : Array.isArray(event.payload) ? 'an array' : `a ${typeof event.payload}`;
    throw new PermanentError(`Unparseable payload: expected a JSON object, found ${found}`);
  }

  if (topic === 'orders/paid') {
    return writeEarning(event, config);
  } else if (topic === 'refunds/create') {
    return writeRefund(event, config);
  } else if (topic === 'orders/cancelled') {
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

  const { points, eligibleAmountPaise, lines } = computeEarningFromOrder(order, config);

  if (points <= 0 && eligibleAmountPaise <= 0) {
    return markSkipped(event.id, 'Order has zero eligible value/points');
  }

  const shopifyOrderId = String(order.id);
  const dedupeKey = `earn:${shopifyOrderId}`;

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Account
      const account = await ensureAccount(tx, event.shop, order.customer.id);
      await lockAccount(tx, account.id, 'earn');

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
          lines, // D3: per-line snapshot, the basis for refund reversal
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

const TX_OPTIONS = { maxWait: 10000, timeout: 20000 };

/** Marks an event skipped inside the caller's transaction. */
async function markSkippedIn(tx, eventId, reason) {
  await tx.webhookEvent.update({
    where: { id: eventId },
    data: { status: 'skipped', lastError: reason, updatedAt: now() },
  });
  return true;
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

// ---------------------------------------------------------------------------
// Refunds and cancellations (decisions D1 to D4)
// ---------------------------------------------------------------------------

const PAID_TOPICS = ['orders/paid', 'ORDERS_PAID'];

/** The newest stored orders/paid event for an order (either topic form; the id may be a number or a string). */
function findStoredPaidEvent(shop, shopifyOrderId) {
  const ids = [shopifyOrderId];
  if (/^\d+$/.test(shopifyOrderId)) ids.push(Number(shopifyOrderId));
  return prisma.webhookEvent.findFirst({
    where: { shop, topic: { in: PAID_TOPICS }, OR: ids.map((v) => ({ payload: { path: ['id'], equals: v } })) },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Finds the LoyaltyOrder a refund or cancel refers to, or says why there is none.
 * An order that has simply not been processed yet THROWS, so the event is retried
 * (never skipped): a refund can arrive before its order.
 *
 * @returns {Promise<{ order: object } | { skip: string }>}
 */
async function loadOrderForReversal(event, config, shopifyOrderId) {
  const order = await prisma.loyaltyOrder.findUnique({
    where: { shop_shopifyOrderId: { shop: event.shop, shopifyOrderId } },
  });
  if (order) return { order };

  // The order's own event may be stored already (queued, failed, or skipped).
  const paid = await findStoredPaidEvent(event.shop, shopifyOrderId);
  if (paid) {
    if (paid.status === 'skipped') return { skip: `Order earned no points (${paid.lastError || 'its orders/paid event was skipped'})` };
    throw new Error('Original order not yet in ledger, retry later');
  }

  if (!config.ledgerStartAt) {
    return { skip: 'Original order not found in ledger (predates ledger or zero value)' };
  }
  // T2.8 Shopify lookup
  try {
    const shopifyOrder = await gatewayFactory(event.shop).getOrder(shopifyOrderId);
    if (new Date(shopifyOrder.processed_at) < config.ledgerStartAt) {
      return { skip: 'Original order not found in ledger (predates ledger)' };
    }
  } catch (err) {
    if (err.response && err.response.code === 404) return { skip: 'Original order not found in Shopify either' };
    throw err; // retry on network failure
  }
  // After ledgerStartAt but not in the ledger yet: wait for it.
  throw new Error('Original order not yet in ledger, retry later');
}

/**
 * The order's earn snapshot (D3). Orders earned before migration 4 have none: it is
 * rebuilt from the stored orders/paid event, and only if the rebuilt eligible value
 * and points equal what the ledger recorded. Otherwise the event fails visibly.
 */
async function snapshotFor(order, config) {
  if (Array.isArray(order.lines)) return { lines: order.lines, rebuilt: false };
  const paid = await findStoredPaidEvent(order.shop, order.shopifyOrderId);
  if (!paid) {
    throw new RefundDataError('The order has no earn snapshot and no stored orders/paid event to rebuild it from');
  }
  const rebuilt = computeEarningFromOrder(paid.payload, config);
  if (rebuilt.eligibleAmountPaise !== order.eligibleAmountPaise || rebuilt.points !== order.pointsEarned) {
    throw new RefundDataError(
      'The earn snapshot rebuilt from the stored orders/paid event does not match what the ledger recorded ' +
        `(${rebuilt.points} points / ${rebuilt.eligibleAmountPaise} paise rebuilt, ${order.pointsEarned} / ${order.eligibleAmountPaise} recorded); the earning rules may have changed since`
    );
  }
  return { lines: rebuilt.lines, rebuilt: true };
}

/**
 * Takes `points` back from an account, inside the caller's transaction (the account
 * must already be locked). Order of preference (D4):
 *   1. the order's own lot (pending or active),
 *   2. the account's other ACTIVE lots, oldest first,
 *   3. unused reward codes, newest first: voiding a code gives its points back, and
 *      they cover the reversal (any surplus stays with the customer as a fresh active lot),
 *   4. whatever is still left is owed: it is added to the debt column.
 * `available` and `pending` therefore never go below 0 and always equal the sum of the
 * active and pending lots' remaining points. Lots and rewards are read FOR UPDATE inside
 * the transaction and every balance change is a delta.
 *
 * A redemption still in 'creating' has no code yet and cannot be voided; its points count
 * as spent and the shortfall becomes debt.
 *
 * Voiding only marks the Reward 'returned' and the Redemption 'voided' here; deleting the
 * code in Shopify happens after commit (it is a network call).
 *
 * @param {boolean} [emptiesOrder] true for a cancellation: an emptied own lot is marked 'cancelled' rather than 'exhausted'
 * @returns {Promise<{ fromLots: number, fromRewards: number, toDebt: number, voidedRewards: string[] }>}
 */
export async function takeBackPoints(tx, { accountId, ownLotId, points, emptiesOrder = false }) {
  const lots = await tx.$queryRaw`
    SELECT id, remaining, status FROM "PointLot"
     WHERE "accountId" = ${accountId} AND remaining > 0
       AND (id = ${ownLotId ?? ''} OR status = 'active')
       AND status IN ('pending', 'active')
     ORDER BY (id = ${ownLotId ?? ''}) DESC, "activatesAt" ASC, "createdAt" ASC, id ASC
       FOR UPDATE`;

  let left = points;
  let fromPending = 0;
  let fromAvailable = 0;
  for (const lot of lots) {
    if (left === 0) break;
    const take = Math.min(left, lot.remaining);
    const emptied = take === lot.remaining;
    await tx.pointLot.update({
      where: { id: lot.id },
      data: {
        remaining: { decrement: take },
        ...(emptied ? { status: emptiesOrder && lot.id === ownLotId ? 'cancelled' : 'exhausted' } : {}),
      },
    });
    if (lot.status === 'pending') fromPending += take;
    else fromAvailable += take;
    left -= take;
  }

  let fromRewards = 0;
  let surplusReturned = 0;
  const voidedRewards = [];
  if (left > 0) {
    const candidates = await tx.$queryRaw`
      SELECT id, "discountCode", "pointsUsed", "expiresAt" FROM "Reward"
       WHERE "accountId" = ${accountId} AND status = 'active'
       ORDER BY "createdAt" DESC, id DESC
         FOR UPDATE`;
    const rewards = candidates.filter((r) => !r.expiresAt || r.expiresAt > now()); // an expired code is not "unused": it is simply gone
    for (const reward of rewards) {
      if (left === 0) break;
      const used = Math.min(left, reward.pointsUsed);
      const surplus = reward.pointsUsed - used;
      left -= used;
      fromRewards += used;
      surplusReturned += surplus;
      voidedRewards.push(reward.id);

      await tx.reward.update({ where: { id: reward.id }, data: { status: 'returned', returnedAt: now() } });
      const redemption = await tx.redemption.findFirst({ where: { accountId, discountCode: reward.discountCode } });
      if (redemption) await tx.redemption.update({ where: { id: redemption.id }, data: { status: 'voided' } });

      let lotId = null;
      if (surplus > 0) {
        const lot = await tx.pointLot.create({
          data: {
            accountId,
            originalPoints: reward.pointsUsed,
            remaining: surplus,
            status: 'active',
            shopifyOrderId: `reward:${redemption?.id ?? reward.id}`,
            activatesAt: now(),
          },
        });
        lotId = lot.id;
      }
      await tx.ledgerEntry.create({
        data: {
          accountId,
          type: 'reward_return',
          points: reward.pointsUsed,
          status: 'active',
          dedupeKey: `reward_return:${redemption?.id ?? reward.id}`,
          note: 'Unused reward code voided to cover points taken back for a refund or cancellation',
          lotId,
          redemptionId: redemption?.id,
          rewardId: reward.id,
        },
      });
    }
  }

  const availableDelta = surplusReturned - fromAvailable;
  const balanceChanges = {
    ...(fromPending > 0 ? { pending: { decrement: fromPending } } : {}),
    ...(availableDelta !== 0 ? { available: { increment: availableDelta } } : {}),
    ...(left > 0 ? { debt: { increment: left } } : {}),
  };
  if (Object.keys(balanceChanges).length > 0) {
    await tx.loyaltyAccount.update({ where: { id: accountId }, data: balanceChanges });
  }
  return { fromLots: fromPending + fromAvailable, fromRewards, toDebt: left, voidedRewards };
}

const sumOf = (rows, key) => rows.reduce((t, r) => t + (r[key] || 0), 0);
const reversalNote = ({ voidedRewards, toDebt }) =>
  (voidedRewards.length > 0 ? ` (${voidedRewards.length} unused reward code${voidedRewards.length === 1 ? '' : 's'} voided)` : '') +
  (toDebt > 0 ? ` (${toDebt} added to the owed balance)` : '');

/**
 * Processes a refunds/create webhook event (D1).
 */
export async function writeRefund(event, config) {
  const payload = event.payload;
  if (!payload.order_id) {
    return markSkipped(event.id, 'Refund payload missing order_id');
  }

  const shopifyOrderId = String(payload.order_id);
  const shopifyRefundId = String(payload.id);
  const dedupeKey = `refund:${shopifyRefundId}`;

  const found = await loadOrderForReversal(event, config, shopifyOrderId);
  if (found.skip) return markSkipped(event.id, found.skip);

  const entries = refundEntries(payload); // throws RefundDataError on a malformed entry
  const snapshot = await snapshotFor(found.order, config);

  try {
    return await prisma.$transaction(async (tx) => {
      await lockAccount(tx, found.order.accountId, 'refund');

      // Everything below is read under the lock, so a refund that landed a moment ago is seen.
      const already = await tx.loyaltyRefund.findFirst({ where: { shop: event.shop, shopifyRefundId } });
      if (already) return markSkippedIn(tx, event.id, 'Duplicate: this refund was already applied');

      const order = await tx.loyaltyOrder.findUnique({ where: { id: found.order.id } });
      if (snapshot.rebuilt && order.lines === null) {
        await tx.loyaltyOrder.update({ where: { id: order.id }, data: { lines: snapshot.lines } });
      }
      const lines = Array.isArray(order.lines) ? order.lines : snapshot.lines;

      const earlier = await tx.loyaltyRefund.findMany({
        where: { loyaltyOrderId: order.id },
        select: { pointsReversed: true, lines: true },
      });
      const { pointsToReverse, deltaRefundedPaise, lineRecords } = computeLineReversal({
        lines,
        entries,
        prior: priorQuantities(earlier.map((r) => r.lines)),
        pointsEarned: order.pointsEarned,
        eligibleAmountPaise: order.eligibleAmountPaise,
        alreadyReversed: sumOf(earlier, 'pointsReversed'),
      });

      const refundRecord = await tx.loyaltyRefund.create({
        data: {
          accountId: order.accountId,
          shopifyRefundId,
          shopifyOrderId,
          shop: event.shop,
          pointsReversed: pointsToReverse,
          refundAmountPaise: deltaRefundedPaise,
          isFullCancellation: false,
          lines: lineRecords,
          loyaltyOrderId: order.id,
        },
      });

      let ledgerEntryId;
      if (pointsToReverse > 0) {
        const taken = await takeBackPoints(tx, { accountId: order.accountId, ownLotId: order.lotId, points: pointsToReverse });
        const entry = await tx.ledgerEntry.create({
          data: {
            accountId: order.accountId,
            type: 'refund',
            points: -pointsToReverse,
            status: 'active',
            dedupeKey,
            note: `Refund on order #${shopifyOrderId}${reversalNote(taken)}`,
            orderId: order.id,
            refundId: refundRecord.id,
            lotId: order.lotId,
          },
        });
        ledgerEntryId = entry.id;
      }

      await tx.webhookEvent.update({
        where: { id: event.id },
        data: { status: 'processed', ledgerEntryId, updatedAt: now() },
      });
      return true;
    }, TX_OPTIONS);
  } catch (err) {
    if (err.code === 'P2002') return markSkipped(event.id, 'Duplicate: refund entry already exists');
    throw err;
  }
}

/**
 * Processes an orders/cancelled webhook event (D2): reverses everything still
 * unreversed. Whether it runs before or after the cancel's own refund, nothing is
 * counted twice: both work from the points already reversed on the order.
 */
export async function writeCancel(event, config) {
  const payload = event.payload;
  if (!payload.id) return markSkipped(event.id, 'Cancel payload missing id');
  const shopifyOrderId = String(payload.id);
  const dedupeKey = `cancel:${shopifyOrderId}`;

  const found = await loadOrderForReversal(event, config, shopifyOrderId);
  if (found.skip) return markSkipped(event.id, found.skip);

  try {
    return await prisma.$transaction(async (tx) => {
      await lockAccount(tx, found.order.accountId, 'cancel');

      const already = await tx.loyaltyRefund.findFirst({ where: { loyaltyOrderId: found.order.id, isFullCancellation: true } });
      if (already) return markSkippedIn(tx, event.id, 'Duplicate: this cancellation was already applied');

      const order = await tx.loyaltyOrder.findUnique({ where: { id: found.order.id } });
      const earlier = await tx.loyaltyRefund.findMany({
        where: { loyaltyOrderId: order.id },
        select: { pointsReversed: true, refundAmountPaise: true },
      });
      const { pointsToReverse } = computeCancellation({
        pointsEarned: order.pointsEarned,
        alreadyReversed: sumOf(earlier, 'pointsReversed'),
      });

      const refundRecord = await tx.loyaltyRefund.create({
        data: {
          accountId: order.accountId,
          shopifyRefundId: null,
          shopifyOrderId,
          shop: event.shop,
          pointsReversed: pointsToReverse,
          refundAmountPaise: Math.max(0, order.eligibleAmountPaise - sumOf(earlier, 'refundAmountPaise')),
          isFullCancellation: true,
          lines: [],
          loyaltyOrderId: order.id,
        },
      });

      let ledgerEntryId;
      if (pointsToReverse > 0) {
        const taken = await takeBackPoints(tx, {
          accountId: order.accountId, ownLotId: order.lotId, points: pointsToReverse, emptiesOrder: true,
        });
        const entry = await tx.ledgerEntry.create({
          data: {
            accountId: order.accountId,
            type: 'cancel',
            points: -pointsToReverse,
            status: 'active',
            dedupeKey,
            note: `Cancelled order #${shopifyOrderId}${reversalNote(taken)}`,
            orderId: order.id,
            refundId: refundRecord.id,
            lotId: order.lotId,
          },
        });
        ledgerEntryId = entry.id;
      }

      await tx.webhookEvent.update({
        where: { id: event.id },
        data: { status: 'processed', ledgerEntryId, updatedAt: now() },
      });
      return true;
    }, TX_OPTIONS);
  } catch (err) {
    if (err.code === 'P2002') return markSkipped(event.id, 'Duplicate: cancel entry already exists');
    throw err;
  }
}

let lockHook = null;

/**
 * TEST SEAM. Installs a function (accountId, tag) awaited by every lockAccount call just
 * before it asks the database for the row lock (the transaction is already open). `tag`
 * names the writer: 'earn' | 'refund' | 'cancel' | 'activate' | 'redeem' | 'compensate' | 'adjust'.
 * Pass null to remove it. Production code never sets this.
 */
export function setLockHook(fn) {
  lockHook = fn;
}

/**
 * Takes a row lock on the account for the rest of the transaction.
 * Every operation that reads a balance and then decides something from it
 * (redeem, reward return) must call this first.
 */
export async function lockAccount(tx, accountId, tag = 'unspecified') {
  if (lockHook) await lockHook(accountId, tag); // test seam: lets a test force writers to reach the lock together
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
 * Gives points back to an account as a FRESH active lot, inside the caller's transaction
 * (the account must already be locked). New points repay the owed balance first (D4): the
 * repaid part is consumed from the lot, the rest becomes available. Writes the 'reward_return'
 * ledger entry for the whole amount. Used when a redemption could not create its code, when an
 * unused code expires, and when a reward is restored after a cancelled or fully refunded order.
 *
 * @param {Object} p
 * @param {string} p.accountId
 * @param {number} p.points
 * @param {string} p.lotTag       PointLot.shopifyOrderId of the new lot, e.g. "reward:<redemptionId>"
 * @param {string} p.dedupeKey    ledger dedupe key, e.g. "reward_return:<redemptionId>" (one return per reward, ever)
 * @param {string} p.note
 * @param {string} [p.redemptionId]
 * @param {string} [p.rewardId]
 * @param {string} [p.orderId]    LoyaltyOrder.id the return belongs to, if any
 * @returns {Promise<{ repaid: number, usable: number, lotId: string }>}
 */
export async function returnPoints(tx, { accountId, points, lotTag, dedupeKey, note, redemptionId, rewardId, orderId }) {
  const account = await tx.loyaltyAccount.findUnique({ where: { id: accountId }, select: { debt: true } });
  const repaid = Math.min(account.debt, points);
  const usable = points - repaid;

  const lot = await tx.pointLot.create({
    data: {
      accountId,
      originalPoints: points,
      remaining: usable,
      status: usable > 0 ? 'active' : 'exhausted',
      shopifyOrderId: lotTag,
      activatesAt: now(),
    },
  });
  await tx.ledgerEntry.create({
    data: {
      accountId,
      type: 'reward_return',
      points,
      status: 'active',
      dedupeKey,
      note: note + (repaid > 0 ? ` (${repaid} used to repay the owed balance)` : ''),
      lotId: lot.id,
      redemptionId,
      rewardId,
      orderId,
    },
  });
  await tx.loyaltyAccount.update({
    where: { id: accountId },
    data: {
      ...(usable > 0 ? { available: { increment: usable } } : {}),
      ...(repaid > 0 ? { debt: { decrement: repaid } } : {}),
    },
  });
  return { repaid, usable, lotId: lot.id };
}

/**
 * Moves one pending lot to active inside the caller's transaction (the
 * account must already be locked). Re-reads the lot, so a refund that landed
 * after the J3 check is reflected. New points repay any owed balance (debt)
 * first (D4): the repaid part is consumed from the lot, the rest becomes
 * available. Returns the points that became available, or 0 if the lot is no
 * longer pending.
 */
export async function activateLotInTx(tx, lotId, loyaltyOrderId) {
  const lot = await tx.pointLot.findUnique({ where: { id: lotId } });
  if (!lot || lot.status !== 'pending' || lot.remaining <= 0) return 0;

  const account = await tx.loyaltyAccount.findUnique({ where: { id: lot.accountId }, select: { debt: true } });
  const repaid = Math.min(account.debt, lot.remaining);
  const usable = lot.remaining - repaid;

  await tx.pointLot.update({
    where: { id: lot.id },
    data: { status: usable === 0 ? 'exhausted' : 'active', ...(repaid > 0 ? { remaining: { decrement: repaid } } : {}) },
  });

  await tx.ledgerEntry.create({
    data: {
      accountId: lot.accountId,
      type: 'activate',
      points: 0,
      status: 'active',
      dedupeKey: `activate:${lot.shopifyOrderId}`,
      lotId: lot.id,
      orderId: loyaltyOrderId,
      note: `Activated points for order #${lot.shopifyOrderId}` + (repaid > 0 ? ` (${repaid} used to repay the owed balance)` : ''),
    },
  });

  await tx.loyaltyAccount.update({
    where: { id: lot.accountId },
    data: {
      pending: { decrement: lot.remaining },
      ...(usable > 0 ? { available: { increment: usable } } : {}),
      ...(repaid > 0 ? { debt: { decrement: repaid } } : {}),
    },
  });
  return usable;
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
      await lockAccount(tx, lot.accountId, 'activate');
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
