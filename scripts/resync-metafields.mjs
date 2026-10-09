#!/usr/bin/env node
// scripts/resync-metafields.mjs
//
// Marks every loyalty account of a shop (and the shop's redeem rule) as needing a storefront
// metafield sync. The worker then rewrites custom.reward_points, pending_points,
// pending_points_available_at and earned_discount_code for each customer, and the app metafield
// rewards.redeem_rule, within a minute or two. Use it after scripts/reset-metafields.mjs wiped them.
//
//   node .tmp/run-db.mjs dev node scripts/resync-metafields.mjs --shop platinum-ecofynd-test-store.myshopify.com
//
// Writes only two counters in the database (no Shopify call, no ledger row). The database guard applies.

import '../web/lib/load-env.js'; // first: prisma.js reads DATABASE_URL on import
import { prisma } from '../web/lib/prisma.js';
import { assertNotProtected } from '../web/lib/db-guard.js';
import { markAllAccountsDirty } from '../web/loyalty/service/metafield-sync.js';

const args = process.argv.slice(2);
const i = args.indexOf('--shop');
const shop = i === -1 ? null : args[i + 1];
if (!shop) { console.error('Usage: node scripts/resync-metafields.mjs --shop <myshopify-domain>'); process.exit(1); }
assertNotProtected(process.env.DATABASE_URL || '');

try {
  const dbName = new URL(process.env.DATABASE_URL).pathname.slice(1).split('?')[0];
  const accounts = await markAllAccountsDirty(shop);
  const rule = await prisma.loyaltyConfig.updateMany({ where: { shop }, data: { ruleSeq: { increment: 1 } } });
  console.log(`[resync] database: ${dbName} | shop: ${shop} | accounts marked: ${accounts} | rule marked: ${rule.count}`);
} catch (err) {
  console.error('[resync] failed:', err.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
