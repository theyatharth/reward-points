// web/loyalty/service/metafield-sync.js
//
// Pushes the ledger to the storefront. The theme blocks render the customer's balance on the first
// paint from four customer metafields (custom.reward_points, pending_points, pending_points_available_at,
// earned_discount_code) and the shop's redeem rule from an app metafield (rewards.redeem_rule); they then
// refresh from the signed /history call, which is the source of truth. The ledger is never read back from Shopify.
//
// DIRTY TRACKING. No ledger writer has to remember to mark anything: database triggers (migration 8) bump
// LoyaltyAccount.metafieldSeq when the balances change or one of the account's rewards is created or changes
// status, and LoyaltyConfig.ruleSeq when the redeem rule changes. An account is dirty while
// metafieldSeq > metafieldSyncedSeq. The sync reads metafieldSeq FIRST, then the data, writes to Shopify,
// and finally sets metafieldSyncedSeq to the value it read (only if the row still has it): a change that lands
// during the sync leaves the account dirty and is synced on the next run. Nothing is lost, nothing loops.
//
// Failures: a batch that fails is retried one account at a time; a customer Shopify says no longer exists is
// marked synced (it can never succeed); any other failure leaves the account dirty for the next run.

import { prisma } from '../../lib/prisma.js';
import { Prisma } from '../../../prisma/generated/client/index.js';
import { now } from '../adapters/clock.js';
import { gatewayFactory } from './ledger.js';

const BATCH = 6; // 6 customers x 4 metafields = 24 inputs; metafieldsSet takes at most 25
export const MAX_PER_RUN = 60;

const GONE = /does not exist|not found|invalid owner|no longer exists/i;
const decimal = (paise) => `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;

/** What the theme should show for one account right now. */
async function metafieldValues(accountId) {
  const [account, pending, code] = await Promise.all([
    prisma.loyaltyAccount.findUnique({ where: { id: accountId }, select: { available: true, pending: true } }),
    prisma.pointLot.findFirst({ where: { accountId, status: 'pending', remaining: { gt: 0 } }, orderBy: { activatesAt: 'asc' }, select: { activatesAt: true } }),
    // The newest code that is still usable (an expired one is not shown, even before the expiry job marks it).
    prisma.reward.findMany({ where: { accountId, status: 'active' }, orderBy: { createdAt: 'desc' }, select: { discountCode: true, expiresAt: true }, take: 5 }),
  ]);
  const live = code.find((r) => !r.expiresAt || r.expiresAt > now());
  return {
    available: account.available,
    pending: account.pending,
    pendingAvailableAt: pending?.activatesAt ?? null,
    activeCode: live?.discountCode ?? null,
  };
}

/**
 * Syncs accounts whose storefront metafields are out of date.
 *
 * @param {Object} [options]
 * @param {string} [options.shop]   only this shop (tests, admin)
 * @param {number} [options.limit]  accounts per run (default MAX_PER_RUN)
 * @returns {Promise<{ dirty: number, synced: number, gone: number, failed: Array<{ customerId: string, reason: string }> }>}
 */
export async function syncDirtyAccounts({ shop, limit = MAX_PER_RUN } = {}) {
  const rows = await prisma.$queryRaw`
    SELECT id, shop, "shopifyCustomerId", "metafieldSeq" FROM "LoyaltyAccount"
     WHERE "metafieldSeq" > "metafieldSyncedSeq" AND "redactedAt" IS NULL ${shop ? Prisma.sql`AND shop = ${shop}` : Prisma.empty}
     ORDER BY "updatedAt" ASC
     LIMIT ${limit}`;

  const result = { dirty: rows.length, synced: 0, gone: 0, failed: [] };
  const byShop = new Map();
  for (const r of rows) byShop.set(r.shop, [...(byShop.get(r.shop) || []), r]);

  for (const [shopName, accounts] of byShop) {
    const gw = gatewayFactory(shopName);

    // Read each account's values AFTER its seq (which is already in the row).
    const items = [];
    for (const a of accounts) items.push({ account: a, ...(await metafieldValues(a.id)), customerId: a.shopifyCustomerId });

    const markSynced = (item) => prisma.loyaltyAccount.updateMany({
      where: { id: item.account.id, metafieldSeq: item.account.metafieldSeq },
      data: { metafieldSyncedSeq: item.account.metafieldSeq, metafieldSyncedAt: now() },
    });

    for (let i = 0; i < items.length; i += BATCH) {
      const chunk = items.slice(i, i + BATCH);
      try {
        await gw.setCustomerMetafields(chunk);
        for (const item of chunk) { await markSynced(item); result.synced++; }
        continue;
      } catch {
        // fall through: find out which account is the problem
      }
      for (const item of chunk) {
        try {
          await gw.setCustomerMetafields([item]);
          await markSynced(item);
          result.synced++;
        } catch (err) {
          const text = `${err.message} ${JSON.stringify(err.userErrors ?? '')}`;
          if (GONE.test(text)) {
            await markSynced(item); // the customer no longer exists in Shopify: nothing to sync, ever
            result.gone++;
          } else {
            result.failed.push({ customerId: item.customerId, reason: err.message });
          }
        }
      }
    }
  }
  return result;
}

/**
 * Writes the shop's redeem rule to the app metafield rewards.redeem_rule when it changed.
 *
 * @returns {Promise<{ dirty: number, synced: number, failed: Array<{ shop: string, reason: string }> }>}
 */
export async function syncRuleMetafields({ shop } = {}) {
  const rows = await prisma.$queryRaw`
    SELECT shop, "ruleSeq" FROM "LoyaltyConfig"
     WHERE "ruleSeq" > "ruleSyncedSeq" ${shop ? Prisma.sql`AND shop = ${shop}` : Prisma.empty}`;
  const result = { dirty: rows.length, synced: 0, failed: [] };
  for (const row of rows) {
    try {
      const config = await prisma.loyaltyConfig.findUnique({ where: { shop: row.shop } });
      await gatewayFactory(row.shop).setRuleMetafield({
        pointsPerReward: config.pointsPerReward,
        rewardValue: decimal(config.rewardValue),
        currency: config.currency,
        holdPeriodDays: config.holdPeriodDays,
      });
      await prisma.loyaltyConfig.updateMany({ where: { shop: row.shop, ruleSeq: row.ruleSeq }, data: { ruleSyncedSeq: row.ruleSeq } });
      result.synced++;
    } catch (err) {
      result.failed.push({ shop: row.shop, reason: err.message });
    }
  }
  return result;
}

/** Marks every account of a shop dirty (after the metafields were wiped, e.g. by scripts/reset-metafields.mjs). */
export async function markAllAccountsDirty(shop) {
  const done = await prisma.loyaltyAccount.updateMany({ where: { shop }, data: { metafieldSeq: { increment: 1 } } });
  return done.count;
}
