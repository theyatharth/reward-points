// web/admin/data/rules.js: the Rules view (read only in this version): GET /admin/api/rules.
// The shop's LoyaltyConfig, field by field. Editing (validated, audited, with a diff) is a later step.

import { prisma } from '../../lib/prisma.js';
import { decimal, iso } from './util.js';

export async function rules(shop) {
  const c = await prisma.loyaltyConfig.findUnique({ where: { shop } });
  if (!c) return { configured: false };
  return {
    configured: true,
    earn: {
      spend: decimal(c.spendAmountPaise),
      points: c.pointsPerUnit,
      rounding: c.pointsRounding,
      basis: c.earnBasis,
      taxHandling: c.taxHandling,
      includeShipping: c.shippingEarning,
      excludeGiftCards: c.excludeGiftCards,
      excludedCollectionIds: c.excludedCollectionIds.map(String).slice(0, 100),
    },
    redeem: {
      pointsPerReward: c.pointsPerReward,
      rewardValue: decimal(c.rewardValue),
      currency: c.currency,
      codeValidDays: c.rewardExpiryDays,
      holdPeriodDays: c.holdPeriodDays,
    },
    returns: {
      shortfallPolicy: c.shortfallPolicy,
      restoreRewardOnFullRefund: c.restoreRewardOnFullRefund,
      returnPointsOnCodeExpiry: c.returnPointsOnCodeExpiry,
    },
    program: { campaignEnabled: c.campaignEnabled, expiryEnabled: c.expiryEnabled, ledgerStartAt: iso(c.ledgerStartAt), updatedAt: iso(c.updatedAt) },
  };
}
