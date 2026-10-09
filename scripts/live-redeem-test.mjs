#!/usr/bin/env node
// scripts/live-redeem-test.mjs
//
// ONE real redemption against the dev test store: the real ledger code and the REAL Shopify gateway
// (discountCodeBasicCreate: customer-bound, single use, expiry from config, value from config).
// Run it on the EC2 box, through the database wrapper, against the dev database only:
//
//   node .tmp/run-db.mjs dev node scripts/live-redeem-test.mjs --shop platinum-ecofynd-test-store.myshopify.com --customer <shopify customer id>
//
// Options:
//   --show-code   print the whole code (default: masked). The code is bound to that customer and single use.
//
// It refuses to run unless the customer's account already has enough AVAILABLE points (grant some with the
// adjustment service or the admin first). It performs exactly one redeem with a fresh idempotency key,
// then asks Shopify whether the discount exists. It prints counts and the masked code, never tokens or URLs.
// Afterwards: apply the code at checkout as that customer; the orders/paid webhook marks it used.

import '../web/lib/load-env.js'; // first: prisma.js reads DATABASE_URL on import
import { prisma } from '../web/lib/prisma.js';
import { assertNotProtected } from '../web/lib/db-guard.js';
import { redeem } from '../web/loyalty/service/redemption.js';
import { ShopifyGateway } from '../web/loyalty/adapters/gateway.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const shop = opt('--shop');
const customer = opt('--customer');
const showCode = args.includes('--show-code');
const die = (msg) => { console.error('[live-redeem] ' + msg); process.exit(1); };
if (!shop || !customer || !/^\d+$/.test(customer)) die('Usage: --shop <myshopify-domain> --customer <numeric Shopify customer id> [--show-code]');
if (process.env.NODE_ENV === 'test') die('NODE_ENV=test would use the fake gateway; run without it');

assertNotProtected(process.env.DATABASE_URL || '');
const mask = (code) => (showCode ? code : `${code.slice(0, 4)}-${'*'.repeat(Math.max(0, code.length - 5))}`);

try {
  const dbName = new URL(process.env.DATABASE_URL).pathname.slice(1).split('?')[0];
  console.log(`[live-redeem] database: ${dbName} | shop: ${shop} | customer: ${customer}`);
  if (dbName !== 'reward_points_dev') die('this script only runs against reward_points_dev');

  const config = await prisma.loyaltyConfig.findUnique({ where: { shop } });
  if (!config) die('no LoyaltyConfig for this shop');
  const account = await prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: customer } } });
  if (!account) die('this customer has no loyalty account');
  console.log(`[live-redeem] balance: available ${account.available}, pending ${account.pending}, owed ${account.debt} | rule: ${config.pointsPerReward} points -> ${config.rewardValue} paise, valid ${config.rewardExpiryDays} days`);
  if (account.debt > 0) die('the customer owes points; redemption would be refused');
  if (account.available < config.pointsPerReward) die(`needs ${config.pointsPerReward - account.available} more AVAILABLE points (pending points are not spendable until the hold period ends); grant some first`);

  const key = `live-test-${Date.now()}`;
  const r = await redeem({ shop, shopifyCustomerId: customer, idempotencyKey: key });
  if (!r.ok) die(`redeem refused: ${r.reason}: ${r.message}`);
  console.log(`[live-redeem] redeem ok: status ${r.status}, points used ${r.pointsUsed}, value ${r.valuePaise} paise, expires ${r.expiresAt?.toISOString()}, balance now ${r.available}`);
  if (!r.code) die(`the redemption is still "${r.status}" (no code yet); the worker or a replay will settle it`);
  console.log(`[live-redeem] code: ${mask(r.code)}`);

  const found = await new ShopifyGateway(shop).findDiscountByCode(r.code);
  console.log(`[live-redeem] Shopify has the discount: ${found ? 'YES' : 'NO (check the store admin)'}`);
  if (!found) process.exitCode = 1;
  console.log('[live-redeem] next: use the code at checkout as that customer; the orders/paid webhook will mark it used.');
} catch (err) {
  console.error('[live-redeem] failed:', err.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
