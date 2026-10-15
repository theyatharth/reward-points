// scripts/seed-config.mjs
//
// Seeds a LoyaltyConfig row for a given shop with the client's production
// defaults, or updates ledgerStartAt when --set-ledger-start is passed.
//
// Usage:
//   node scripts/seed-config.mjs --shop <myshopify-domain>
//   node scripts/seed-config.mjs --shop <myshopify-domain> --set-ledger-start now
//   node scripts/seed-config.mjs --shop <myshopify-domain> --set-ledger-start 2026-10-05T12:00:00Z
//
// Safety: refuses the production database (reward_points) and any database
// not in the allow-list defined in web/lib/db-guard.js.

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
try {
  const dotenv = require('dotenv');
  dotenv.config({ path: join(__dirname, '..', '.env') });
} catch { /* rely on env vars from the environment */ }

import { assertNotProtected } from '../web/lib/db-guard.js';
// prisma.js calls assertDbAllowed on import — no need to repeat here.
import { prisma } from '../web/lib/prisma.js';
import { DEFAULT_CONFIG, validateConfig } from '../web/loyalty/rules/config.js';
import { formatPaise } from '../web/loyalty/rules/money.js';

// M5 seed profile (plan section 9, "Config to seed"). Anything not listed here
// comes from DEFAULT_CONFIG. 'inclusive' = strip the tax included in prices
// (₹419 with 5% GST included earns 399); spend ₹100 earns 100 points.
const SEED_PROFILE = {
  spendAmountPaise: 10000,
  pointsPerUnit: 100,
  earnBasis: 'after_discount',
  excludeGiftCards: true,
  taxHandling: 'inclusive',
  restoreRewardOnFullRefund: true,
  returnPointsOnCodeExpiry: false,
};

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

const shopArg = args.find((a) => a.startsWith('--shop='))?.slice(7)
  ?? args[args.indexOf('--shop') + 1];
if (!shopArg || shopArg.startsWith('--')) {
  console.error('Usage: node scripts/seed-config.mjs --shop <myshopify-domain> [--set-ledger-start now|<iso-date>]');
  process.exit(1);
}
const SHOP = shopArg;

const ledgerStartIdx = args.indexOf('--set-ledger-start');
const ledgerStartArg = ledgerStartIdx !== -1 ? args[ledgerStartIdx + 1] : null;

// ---------------------------------------------------------------------------
// Guard: refuse production database
// ---------------------------------------------------------------------------
assertNotProtected(process.env.DATABASE_URL || '');

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`[seed-config] Shop: ${SHOP}`);
  console.log(`[seed-config] Database: ${new URL(process.env.DATABASE_URL || 'postgresql://localhost/unknown').pathname.slice(1)}`);

  if (ledgerStartArg !== null) {
    // --set-ledger-start mode: update only ledgerStartAt
    if (!ledgerStartArg || ledgerStartArg.startsWith('--')) {
      console.error('[seed-config] --set-ledger-start requires a value: "now" or an ISO date string');
      process.exit(1);
    }

    const ledgerStartAt = ledgerStartArg === 'now' ? new Date() : new Date(ledgerStartArg);
    if (isNaN(ledgerStartAt.getTime())) {
      console.error(`[seed-config] Invalid date: "${ledgerStartArg}"`);
      process.exit(1);
    }

    const existing = await prisma.loyaltyConfig.findUnique({ where: { shop: SHOP } });
    if (!existing) {
      console.error(`[seed-config] No LoyaltyConfig found for ${SHOP}. Run without --set-ledger-start first to seed the initial config.`);
      process.exit(1);
    }

    await prisma.loyaltyConfig.update({
      where: { shop: SHOP },
      data: { ledgerStartAt },
    });
    console.log(`[seed-config] ledgerStartAt set to ${ledgerStartAt.toISOString()} for ${SHOP}`);
    return;
  }

  // Upsert the full config with the M5 seed profile (validated first).
  const seed = validateConfig({ ...DEFAULT_CONFIG, ...SEED_PROFILE });
  const config = await prisma.loyaltyConfig.upsert({
    where: { shop: SHOP },
    update: {}, // Don't overwrite existing config on re-runs — only create if missing
    create: {
      shop: SHOP,
      earnMode: seed.earnMode,
      spendAmountPaise: seed.spendAmountPaise,
      pointsPerUnit: seed.pointsPerUnit,
      taxHandling: seed.taxHandling,
      shippingEarning: seed.shippingEarning,
      pointsRounding: seed.pointsRounding,
      earnBasis: seed.earnBasis,
      excludeGiftCards: seed.excludeGiftCards,
      excludedCollectionIds: seed.excludedCollectionIds,
      pointsPerReward: seed.pointsPerReward,
      rewardValue: seed.rewardValue,
      rewardExpiryDays: seed.rewardExpiryDays,
      holdPeriodDays: seed.holdPeriodDays,
      restoreRewardOnFullRefund: seed.restoreRewardOnFullRefund,
      returnPointsOnCodeExpiry: seed.returnPointsOnCodeExpiry,
      shortfallPolicy: seed.shortfallPolicy,
      campaignEnabled: seed.campaignEnabled,
      expiryEnabled: seed.expiryEnabled,
      currency: seed.currency,
      ledgerStartAt: null,
    },
  });

  console.log(`[seed-config] LoyaltyConfig for ${SHOP}:`);
  console.log(`  id:               ${config.id}`);
  console.log(`  earnMode:         ${config.earnMode}`);
  console.log(`  spend / earn:     spend ${config.spendAmountPaise} paise -> ${config.pointsPerUnit} points`);
  console.log(`  taxHandling:      ${config.taxHandling}`);
  console.log(`  earnBasis:        ${config.earnBasis}`);
  console.log(`  excludeGiftCards: ${config.excludeGiftCards}`);
  console.log(`  excluded collections: ${config.excludedCollectionIds.length}`);
  console.log(`  restoreRewardOnFullRefund: ${config.restoreRewardOnFullRefund}`);
  console.log(`  returnPointsOnCodeExpiry:  ${config.returnPointsOnCodeExpiry}`);
  console.log(`  pointsRounding:   ${config.pointsRounding}`);
  console.log(`  pointsPerReward:  ${config.pointsPerReward}`);
  console.log(`  rewardValue:      ${config.rewardValue} paise (${formatPaise(config.rewardValue, config.currency)})`);
  console.log(`  holdPeriodDays:   ${config.holdPeriodDays}`);
  console.log(`  currency:         ${config.currency}`);
  console.log(`  ledgerStartAt:    ${config.ledgerStartAt ?? '(not set — run with --set-ledger-start before cutover)'}`);
  console.log('[seed-config] Done.');
}

main()
  .catch((err) => {
    console.error('[seed-config] Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
