// web/admin/data/customers.js: the Customers view.
//
//   GET  /admin/api/customers?query=         search by Shopify customer id (D5: no name, e-mail or phone exists)
//   GET  /admin/api/customers/:id?cursor=    one account: balances, lots, rewards, orders, a page of the ledger
//   POST /admin/api/customers/:id/adjust     add or deduct points through adjustPoints (audit-logged)
//
// Only fields named here are sent. An admin may see ledger notes and the internal note of an adjustment ("why", the
// support view) and reward codes; nothing else from the rows.

import { prisma } from '../../lib/prisma.js';
import { adjustPoints, ADJUST_REASONS, MIN_NOTE_LENGTH, MAX_ADJUSTMENT } from '../../loyalty/service/adjustment.js';
import { decimal, iso, pointsValuePaise, ruleOf, limitOf, cursorOf } from './util.js';

const accountRow = (a, rule) => ({
  shopifyCustomerId: a.shopifyCustomerId,
  available: a.available,
  pending: a.pending,
  owed: a.debt,
  availableValue: decimal(pointsValuePaise(a.available, rule)),
});

export async function searchCustomers(shop, rawQuery) {
  const config = await prisma.loyaltyConfig.findUnique({ where: { shop } });
  if (!config) return { results: [], hint: 'This shop has no loyalty rule yet.' };
  const rule = ruleOf(config);
  const q = String(rawQuery ?? '').trim();
  if (q && !/^\d{1,20}$/.test(q)) return { results: [], hint: 'Search by Shopify customer id: digits only.' };

  const where = !q ? { shop } : q.length >= 4 ? { shop, shopifyCustomerId: { startsWith: q } } : { shop, shopifyCustomerId: q };
  const rows = await prisma.loyaltyAccount.findMany({ where, orderBy: q ? { shopifyCustomerId: 'asc' } : { updatedAt: 'desc' }, take: 20 });
  return { results: rows.map((a) => accountRow(a, rule)), hint: q ? null : 'Most recently active members' };
}

const sourceKind = (lotTag) => (lotTag.startsWith('reward:') ? 'reward return' : lotTag.startsWith('adjust:') ? 'adjustment' : 'order');

export async function customerDetail(shop, shopifyCustomerId, { cursor, limit } = {}) {
  const config = await prisma.loyaltyConfig.findUnique({ where: { shop } });
  const account = config && (await prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: String(shopifyCustomerId) } } }));
  if (!account) return null;
  const rule = ruleOf(config);
  const take = limitOf(limit, 25, 100);

  const [byType, lots, rewards, orders, entries] = await Promise.all([
    prisma.$queryRaw`SELECT type, COALESCE(SUM(points), 0) AS total, COALESCE(SUM(points) FILTER (WHERE points > 0), 0) AS gained FROM "LedgerEntry" WHERE "accountId" = ${account.id} GROUP BY type`,
    prisma.pointLot.findMany({ where: { accountId: account.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 30 }),
    prisma.reward.findMany({ where: { accountId: account.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20 }),
    prisma.loyaltyOrder.findMany({ where: { accountId: account.id }, orderBy: [{ processedAt: 'desc' }, { id: 'desc' }], take: 20, include: { refunds: { select: { pointsReversed: true, isFullCancellation: true } } } }),
    prisma.ledgerEntry.findMany({
      where: { accountId: account.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursorOf(cursor) ? { cursor: { id: cursorOf(cursor) }, skip: 0 } : {}),
    }),
  ]);

  const t = Object.fromEntries(byType.map((r) => [r.type, { total: Number(r.total), gained: Number(r.gained) }]));
  const sum = (k) => t[k]?.total ?? 0;
  const lifetimeEarned = sum('earn') + sum('bonus') + (t.adjustment?.gained ?? 0) + sum('refund') + sum('cancel');
  const lifetimeRedeemed = -sum('redemption') - sum('reward_return');

  const page = entries.slice(0, take);
  const nextCursor = entries.length > take ? entries[take].id : null;

  // The order and the admin's own note behind each entry (support view).
  const orderIds = [...new Set(page.map((e) => e.orderId).filter(Boolean))];
  const orderRefs = new Map((await prisma.loyaltyOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, shopifyOrderId: true } })).map((o) => [o.id, o.shopifyOrderId]));
  const adjustIds = page.filter((e) => e.type === 'adjustment' || e.type === 'bonus').map((e) => e.id);
  const audits = adjustIds.length === 0 ? [] : await prisma.$queryRaw`
    SELECT l.detail->>'ledgerEntryId' AS entry, l.detail->>'note' AS note, l.detail->>'reason' AS reason, COALESCE(u.email, CASE WHEN l."shopifyUserId" IS NOT NULL THEN 'Shopify user ' || l."shopifyUserId" END) AS admin
      FROM "AuditLog" l LEFT JOIN "AdminUser" u ON u.id = l."adminId"
     WHERE l.shop = ${shop} AND l.action = 'points_adjusted' AND l.detail->>'ledgerEntryId' = ANY(${adjustIds}::text[])`;
  const why = new Map(audits.map((a) => [a.entry, a]));

  return {
    account: {
      ...accountRow(account, rule),
      pendingValue: decimal(pointsValuePaise(account.pending, rule)),
      owedValue: decimal(pointsValuePaise(account.debt, rule)),
      memberSince: iso(account.createdAt),
      lifetimeEarned,
      lifetimeRedeemed,
    },
    rule: { pointsPerReward: rule.pointsPerReward, rewardValue: decimal(rule.rewardValue), currency: rule.currency, holdPeriodDays: rule.holdPeriodDays },
    lots: lots.map((l) => ({
      status: l.status, originalPoints: l.originalPoints, remaining: l.remaining, activatesAt: iso(l.activatesAt), createdAt: iso(l.createdAt),
      source: sourceKind(l.shopifyOrderId), orderRef: sourceKind(l.shopifyOrderId) === 'order' ? l.shopifyOrderId : null,
    })),
    rewards: rewards.map((r) => ({
      code: r.discountCode, status: r.status, pointsUsed: r.pointsUsed, value: decimal(r.valueInPaise), createdAt: iso(r.createdAt),
      expiresAt: iso(r.expiresAt), usedOrderRef: r.usedOrderId, deletePending: r.needsShopifyDelete,
    })),
    orders: orders.map((o) => {
      const reversed = o.refunds.reduce((s, r) => s + r.pointsReversed, 0);
      const cancelled = o.refunds.some((r) => r.isFullCancellation);
      return {
        orderRef: o.shopifyOrderId, processedAt: iso(o.processedAt), eligible: decimal(o.eligibleAmountPaise), pointsEarned: o.pointsEarned, pointsReversed: reversed,
        state: cancelled ? 'cancelled' : reversed === 0 ? 'earned' : reversed >= o.pointsEarned ? 'fully reversed' : 'partly reversed',
      };
    }),
    ledger: {
      entries: page.map((e) => {
        const w = why.get(e.id);
        return {
          id: e.id, createdAt: iso(e.createdAt), type: e.type, points: e.points, status: e.status, note: e.note,
          source: e.dedupeKey ? e.dedupeKey.split(':')[0] : null, orderRef: e.orderId ? orderRefs.get(e.orderId) ?? null : null,
          adminNote: w?.note ?? null, adminReason: w?.reason ?? null, adminEmail: w?.admin ?? null,
        };
      }),
      nextCursor,
    },
  };
}

/**
 * @returns {Promise<{ status: number, body: Object }>}
 */
export async function adjustCustomer({ shop, adminId, shopifyUserId = null, shopifyCustomerId, body }) {
  const { points, reason, note, idempotencyKey } = body || {};
  if (!Number.isInteger(points) || points === 0 || Math.abs(points) > MAX_ADJUSTMENT) {
    return { status: 400, body: { ok: false, error: 'INVALID_POINTS', message: 'Enter a whole number of points other than 0.' } };
  }
  const allowed = points > 0 ? ADJUST_REASONS.add : ADJUST_REASONS.deduct;
  if (typeof reason !== 'string' || !allowed.includes(reason)) {
    return { status: 400, body: { ok: false, error: 'INVALID_REASON', message: 'Choose a reason from the list.' } };
  }
  const result = await adjustPoints({ shop, shopifyCustomerId: String(shopifyCustomerId), points, reason, note, adminId, shopifyUserId, idempotencyKey });
  if (result.ok) {
    return { status: 200, body: { ok: true, replayed: result.replayed, type: result.type, points: result.points, available: result.available, owed: result.debt } };
  }
  const status = result.reason === 'EXCEEDS_AVAILABLE' ? 409 : result.reason === 'NO_ACCOUNT' ? 404 : 400;
  return { status, body: { ok: false, error: result.reason, message: result.message } };
}

export const adjustMeta = { reasons: ADJUST_REASONS, minNoteLength: MIN_NOTE_LENGTH, maxPoints: MAX_ADJUSTMENT };
