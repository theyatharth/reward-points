// web/loyalty/service/onboarding.js
//
// Onboarding a shop: the LoyaltyConfig row from the seed profile (rules/config.js SEED_PROFILE) with the shop's currency and
// holding period and ledgerStartAt = now, plus, optionally, its first admin user. Idempotent: a shop that already has a
// config is reported and left exactly as it is (change a rule in the admin console, which audits it). The CLI is
// scripts/onboard-shop.mjs, which also refuses a protected database; this module only does the work.

import { randomBytes } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { hashPassword } from '../../lib/passwords.js';
import { DEFAULT_CONFIG, SEED_PROFILE, validateConfig } from '../rules/config.js';
import { normalizeCurrency } from '../rules/currency.js';
import { now } from '../adapters/clock.js';

export const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
const EMAIL = /^[^@\s]{1,100}@[^@\s]{1,150}\.[^@\s]{2,20}$/;

export class OnboardingError extends Error {}

/** The config fields an operator needs to see, no ids. */
const summary = (c) => ({
  shop: c.shop, currency: c.currency, holdPeriodDays: c.holdPeriodDays,
  earn: `${c.pointsPerUnit} points per ${c.spendAmountPaise / 100} ${c.currency} spent`,
  redeem: `${c.pointsPerReward} points = ${c.rewardValue / 100} ${c.currency}`,
  taxHandling: c.taxHandling, earnBasis: c.earnBasis, rounding: c.pointsRounding, codeValidDays: c.rewardExpiryDays,
  restoreRewardOnFullRefund: c.restoreRewardOnFullRefund, returnPointsOnCodeExpiry: c.returnPointsOnCodeExpiry,
  ledgerStartAt: c.ledgerStartAt ? c.ledgerStartAt.toISOString() : null,
});

/**
 * @param {Object} p
 * @param {string} p.shop         the shop's myshopify.com domain
 * @param {string} p.currency     ISO code, e.g. "INR"
 * @param {number} p.holdDays     0 to 365
 * @param {string} [p.adminEmail] also create this admin (one-time password, must change at first sign-in)
 * @returns {Promise<{ created: boolean, differences: string[], config: object, installed: boolean, admin: null | { created: boolean, email: string, oneTimePassword?: string } }>}
 */
export async function onboardShop({ shop, currency, holdDays, adminEmail }) {
  if (typeof shop !== 'string' || !SHOP_DOMAIN.test(shop)) throw new OnboardingError('--shop must be the shop\'s myshopify.com domain, e.g. my-store.myshopify.com');
  const code = normalizeCurrency(currency);
  if (!code) throw new OnboardingError('--currency must be a three-letter ISO code, e.g. INR');
  if (!Number.isInteger(holdDays) || holdDays < 0 || holdDays > 365) throw new OnboardingError('--hold-days must be a whole number from 0 to 365');
  const email = adminEmail === undefined ? null : String(adminEmail).trim().toLowerCase();
  if (email !== null && !EMAIL.test(email)) throw new OnboardingError('--admin-email is not an e-mail address');

  const seed = validateConfig({ ...DEFAULT_CONFIG, ...SEED_PROFILE, currency: code, holdPeriodDays: holdDays });
  const inserted = await prisma.loyaltyConfig.createMany({
    data: [{
      shop, earnMode: seed.earnMode, spendAmountPaise: seed.spendAmountPaise, pointsPerUnit: seed.pointsPerUnit, taxHandling: seed.taxHandling,
      shippingEarning: seed.shippingEarning, pointsRounding: seed.pointsRounding, earnBasis: seed.earnBasis, excludeGiftCards: seed.excludeGiftCards,
      excludedCollectionIds: seed.excludedCollectionIds, pointsPerReward: seed.pointsPerReward, rewardValue: seed.rewardValue,
      rewardExpiryDays: seed.rewardExpiryDays, holdPeriodDays: seed.holdPeriodDays, restoreRewardOnFullRefund: seed.restoreRewardOnFullRefund,
      returnPointsOnCodeExpiry: seed.returnPointsOnCodeExpiry, shortfallPolicy: seed.shortfallPolicy, campaignEnabled: seed.campaignEnabled,
      expiryEnabled: seed.expiryEnabled, currency: code, ledgerStartAt: now(),
    }],
    skipDuplicates: true,
  });
  const created = inserted.count === 1;
  const config = await prisma.loyaltyConfig.findUnique({ where: { shop } });

  // An existing config is never changed here; say where it differs from what was asked.
  const differences = [];
  if (!created) {
    if (config.currency !== code) differences.push(`currency is ${config.currency}, not ${code}`);
    if (config.holdPeriodDays !== holdDays) differences.push(`holding period is ${config.holdPeriodDays} days, not ${holdDays}`);
  }

  let admin = null;
  if (email !== null) {
    const existing = await prisma.adminUser.findFirst({ where: { shop, email: { equals: email, mode: 'insensitive' } } });
    if (existing) {
      admin = { created: false, email: existing.email };
    } else {
      const oneTimePassword = randomBytes(18).toString('base64url');
      await prisma.adminUser.create({ data: { shop, email, passwordHash: await hashPassword(oneTimePassword), mustChangePassword: true } });
      admin = { created: true, email, oneTimePassword };
    }
  }

  const installed = (await prisma.session.count({ where: { shop, isOnline: false } })) > 0;
  return { created, differences, config: summary(config), installed, admin };
}
