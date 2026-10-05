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
import { DEFAULT_CONFIG } from '../web/loyalty/rules/config.js';

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

  // Upsert the full config with production defaults.
  const config = await prisma.loyaltyConfig.upsert({
    where: { shop: SHOP },
    update: {}, // Don't overwrite existing config on re-runs — only create if missing
    create: {
      shop: SHOP,
      earnMode: DEFAULT_CONFIG.earnMode,
      pointsPerUnit: DEFAULT_CONFIG.pointsPerUnit,
      taxHandling: DEFAULT_CONFIG.taxHandling,
      shippingEarning: DEFAULT_CONFIG.shippingEarning,
      pointsRounding: DEFAULT_CONFIG.pointsRounding,
      pointsPerReward: DEFAULT_CONFIG.pointsPerReward,
      rewardValue: DEFAULT_CONFIG.rewardValue,
      rewardExpiryDays: DEFAULT_CONFIG.rewardExpiryDays,
      holdPeriodDays: DEFAULT_CONFIG.holdPeriodDays,
      shortfallPolicy: DEFAULT_CONFIG.shortfallPolicy,
      campaignEnabled: DEFAULT_CONFIG.campaignEnabled,
      expiryEnabled: DEFAULT_CONFIG.expiryEnabled,
      currency: DEFAULT_CONFIG.currency,
      ledgerStartAt: null,
    },
  });

  console.log(`[seed-config] LoyaltyConfig for ${SHOP}:`);
  console.log(`  id:               ${config.id}`);
  console.log(`  earnMode:         ${config.earnMode}`);
  console.log(`  pointsPerUnit:    ${config.pointsPerUnit}`);
  console.log(`  taxHandling:      ${config.taxHandling}`);
  console.log(`  pointsRounding:   ${config.pointsRounding}`);
  console.log(`  pointsPerReward:  ${config.pointsPerReward}`);
  console.log(`  rewardValue:      ${config.rewardValue} paise (₹${(config.rewardValue / 100).toFixed(2)})`);
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
