// scripts/check-real-order.mjs
//
// READ-ONLY proof of the real unlock check (J3): fetches one real order with the REAL ShopifyGateway.getOrder
// (the exact REST call the worker makes before it activates a lot), prints which keys came back and the refund ids,
// and compares them with our LoyaltyRefund rows for that order. It writes nothing: one Shopify GET, a few SELECTs.
//
// Run it on the server through the guard wrapper (dev database only):
//   node $D/.tmp/run-db.mjs dev node scripts/check-real-order.mjs --shop <domain> --order <shopify order id>
//   node $D/.tmp/run-db.mjs dev node scripts/check-real-order.mjs --shop <domain>        # lists the shop's orders to pick from
//
// Prints no customer values: only key NAMES, ids, counts and points. Refuses a protected database (db-guard).

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
try {
  // Does not override variables the wrapper already set (DATABASE_URL).
  require('dotenv').config({ path: join(__dirname, '..', '.env') });
} catch { /* rely on the environment */ }

import { assertNotProtected } from '../web/lib/db-guard.js';
import { prisma } from '../web/lib/prisma.js';
import { ShopifyGateway } from '../web/loyalty/adapters/gateway.js';
import { checkLotJ3 } from '../web/loyalty/service/ledger.js';

const arg = (name) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
};

const shop = arg('shop');
const orderId = arg('order');
if (!shop) {
  console.error('Usage: node scripts/check-real-order.mjs --shop <domain> [--order <shopify order id>]');
  process.exit(1);
}
if (process.env.NODE_ENV === 'test') {
  console.error('[check-real-order] NODE_ENV=test would use the fake gateway; this script needs the real one. Use the dev target.');
  process.exit(1);
}
assertNotProtected(process.env.DATABASE_URL || '');

const shortErr = (err) => `${err?.constructor?.name ?? 'Error'}: ${String(err?.message ?? err).split('\n')[0].slice(0, 200)}${err?.response?.code ? ` (HTTP ${err.response.code})` : ''}`;

async function main() {
  console.log(`[check-real-order] database: ${new URL(process.env.DATABASE_URL).pathname.slice(1)}`);
  console.log(`[check-real-order] shop: ${shop}`);

  if (!orderId) {
    const orders = await prisma.loyaltyOrder.findMany({ where: { shop }, orderBy: { createdAt: 'desc' }, take: 15, select: { shopifyOrderId: true, pointsEarned: true, processedAt: true } });
    console.log(`Pick one of the shop's ${orders.length} most recent orders with --order <id>:`);
    for (const o of orders) console.log(`  ${o.shopifyOrderId}  paid ${o.processedAt.toISOString().slice(0, 10)}  earned ${o.pointsEarned}`);
    return;
  }
  if (!/^\d{1,20}$/.test(orderId)) throw new Error('--order must be a numeric Shopify order id');

  // 1. The exact call the worker makes, plus the version it was made on.
  const { default: shopify } = await import('../web/shopify.js');
  console.log(`[check-real-order] Admin API version configured: ${shopify.api.config.apiVersion}`);
  const gateway = new ShopifyGateway(shop);

  let order;
  try {
    order = await gateway.getOrder(orderId);
  } catch (err) {
    console.log(`RESULT: getOrder FAILED -> ${shortErr(err)}`);
    console.log('        The unlock check would treat this as "lookup_failed" and keep the points pending.');
    process.exitCode = 2;
    return;
  }
  if (!order || typeof order !== 'object') {
    console.log('RESULT: getOrder returned no order object (the unlock check would see zero refunds: the check is NOT effective).');
    process.exitCode = 2;
    return;
  }
  console.log('getOrder: OK (an order object came back)');
  console.log(`  keys: ${Object.keys(order).sort().join(', ')}`);
  const refunds = Array.isArray(order.refunds) ? order.refunds : null;
  console.log(`  refunds key present as an array: ${refunds !== null}`);
  console.log(`  cancelled_at set: ${Boolean(order.cancelled_at)}  processed_at present: ${Boolean(order.processed_at)}`);
  const shopifyIds = (refunds ?? []).map((r) => String(r.id));
  console.log(`  Shopify refund ids (${shopifyIds.length}): ${shopifyIds.join(', ') || '(none)'}`);
  if (refunds?.[0]) console.log(`  keys of a refund object: ${Object.keys(refunds[0]).sort().join(', ')}`);

  // 2. Our side.
  const loyaltyOrder = await prisma.loyaltyOrder.findFirst({ where: { shop, shopifyOrderId: orderId } });
  if (!loyaltyOrder) {
    console.log('Our side: no LoyaltyOrder for this order in this database (it was never earned here), nothing to compare.');
    return;
  }
  const ours = await prisma.loyaltyRefund.findMany({
    where: { shop, shopifyOrderId: orderId },
    orderBy: { createdAt: 'asc' },
    select: { shopifyRefundId: true, isFullCancellation: true, pointsReversed: true },
  });
  const ourIds = ours.filter((r) => r.shopifyRefundId).map((r) => r.shopifyRefundId);
  console.log(`Our LoyaltyRefund rows (${ours.length}): ${ours.map((r) => `${r.shopifyRefundId ?? 'cancel'}:${r.pointsReversed}pts`).join(', ') || '(none)'}`);

  const missingHere = shopifyIds.filter((id) => !ourIds.includes(id));
  const missingThere = ourIds.filter((id) => !shopifyIds.includes(id));
  console.log(`  in Shopify, not applied by us: ${missingHere.join(', ') || 'none'}`);
  console.log(`  applied by us, not in Shopify's list: ${missingThere.join(', ') || 'none'}`);

  // 3. The real decision function, on the real order (a lot-shaped argument; no lot is read or written).
  const verdict = await checkLotJ3({ shopifyOrderId: orderId }, loyaltyOrder.id, shop);
  console.log(`checkLotJ3 verdict: ${JSON.stringify(verdict)}`);
  console.log(missingHere.length === 0 ? 'MATCH: every Shopify refund is applied; the lot would be allowed to activate.' : 'MISMATCH: the worker would refuse to activate this order\'s lot until those refunds are applied.');
}

main()
  .catch((err) => { console.error(`[check-real-order] failed: ${shortErr(err)}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
