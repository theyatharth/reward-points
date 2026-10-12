// web/admin/data/overview.js: GET /admin/api/overview.
//
// Everything is computed from the ledger, the lots, the rewards and the event queue of ONE shop. Points are integers,
// money is a decimal string in the shop's currency, valued at the shop's redemption rule (pointsPerReward points are
// worth rewardValue). Nothing here comes from an order total: the ledger does not store revenue.

import { prisma } from '../../lib/prisma.js';
import { decimal, iso, pointsValuePaise, ruleOf } from './util.js';

const n = (v) => Number(v ?? 0);

export async function overview(shop) {
  const config = await prisma.loyaltyConfig.findUnique({ where: { shop } });
  if (!config) return { configured: false };
  const rule = ruleOf(config);
  const value = (points) => decimal(pointsValuePaise(points, rule));

  const [sums, members, buyers, byType, expired, rewardRows, openRewards, eventCounts, recent] = await Promise.all([
    prisma.loyaltyAccount.aggregate({ where: { shop }, _sum: { available: true, pending: true, debt: true }, _count: { _all: true } }),
    prisma.$queryRaw`
      SELECT (SELECT COUNT(DISTINCT e."accountId") FROM "LedgerEntry" e JOIN "LoyaltyAccount" a ON a.id = e."accountId"
               WHERE a.shop = ${shop} AND e."createdAt" >= NOW() - INTERVAL '90 days') AS active,
             (SELECT COUNT(*) FROM "LoyaltyAccount" WHERE shop = ${shop} AND "createdAt" >= NOW() - INTERVAL '30 days') AS fresh`,
    prisma.$queryRaw`
      SELECT COUNT(*) AS buyers, COUNT(*) FILTER (WHERE n >= 2) AS returning
        FROM (SELECT "accountId", COUNT(*) AS n FROM "LoyaltyOrder" WHERE shop = ${shop} GROUP BY "accountId") t`,
    prisma.$queryRaw`
      SELECT e.type AS type, COALESCE(SUM(e.points), 0) AS total, COALESCE(SUM(e.points) FILTER (WHERE e.points > 0), 0) AS gained
        FROM "LedgerEntry" e JOIN "LoyaltyAccount" a ON a.id = e."accountId" WHERE a.shop = ${shop} GROUP BY e.type`,
    prisma.$queryRaw`
      SELECT COALESCE(SUM(r."pointsUsed"), 0) AS points FROM "Reward" r
       WHERE r.shop = ${shop} AND r.status = 'expired'
         AND NOT EXISTS (SELECT 1 FROM "LedgerEntry" e WHERE e."rewardId" = r.id AND e.type = 'reward_return')`,
    prisma.reward.groupBy({ by: ['status'], where: { shop }, _count: { _all: true }, _sum: { valueInPaise: true } }),
    prisma.reward.aggregate({ where: { shop, status: 'active', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, _count: { _all: true }, _sum: { valueInPaise: true } }),
    prisma.webhookEvent.groupBy({ by: ['status'], where: { shop }, _count: { _all: true } }),
    prisma.webhookEvent.findMany({ where: { shop }, orderBy: { createdAt: 'desc' }, take: 10, select: { topic: true, status: true, attempts: true, createdAt: true } }),
  ]);

  const t = Object.fromEntries(byType.map((r) => [r.type, { total: n(r.total), gained: n(r.gained) }]));
  const sum = (type) => t[type]?.total ?? 0;
  const issued = sum('earn') + sum('bonus') + (t.adjustment?.gained ?? 0);
  const redeemed = -sum('redemption') - sum('reward_return');
  const reversed = -(sum('refund') + sum('cancel'));
  const pending = sums._sum.pending ?? 0;
  const available = sums._sum.available ?? 0;
  const owed = sums._sum.debt ?? 0;
  const expiredPoints = n(expired[0]?.points);

  const byStatus = Object.fromEntries(rewardRows.map((r) => [r.status, { count: r._count._all, value: r._sum.valueInPaise ?? 0 }]));
  const used = byStatus.used ?? { count: 0, value: 0 };
  const unlocked = rewardRows.reduce((s, r) => s + r._count._all, 0);
  const settled = issued - pending;

  return {
    configured: true,
    asOf: new Date().toISOString(),
    rule: { pointsPerReward: rule.pointsPerReward, rewardValue: decimal(rule.rewardValue), currency: rule.currency, holdPeriodDays: rule.holdPeriodDays },
    members: { total: sums._count._all, active90: n(members[0].active), new30: n(members[0].fresh), buyers: n(buyers[0].buyers), returningBuyers: n(buyers[0].returning) },
    points: { issued, pending, available, redeemed, expired: expiredPoints, reversed, owed },
    values: { issued: value(issued), pending: value(pending), available: value(available), redeemed: value(redeemed), expired: value(expiredPoints), reversed: value(reversed), owed: value(owed) },
    liability: {
      available: { points: available, value: value(available) },
      openCodes: { count: openRewards._count._all, value: decimal(openRewards._sum.valueInPaise ?? 0) },
      pending: { points: pending, value: value(pending) },
      redeemed: { points: redeemed, value: value(redeemed), usedValue: decimal(used.value) },
      expired: { points: expiredPoints, value: value(expiredPoints) },
      owed: { points: owed, value: value(owed) },
    },
    rewards: { unlocked, used: used.count, usedValue: decimal(used.value), open: openRewards._count._all },
    redemptionRate: settled > 0 ? redeemed / settled : null,
    business: { available: false, reason: 'The ledger stores eligible value per order, not order totals or revenue.' },
    events: {
      counts: Object.fromEntries(eventCounts.map((e) => [e.status, e._count._all])),
      recent: recent.map((e) => ({ topic: e.topic, status: e.status, attempts: e.attempts, receivedAt: iso(e.createdAt) })),
    },
  };
}
