// scripts/reconcile-missing-orders.mjs
//
// READ-ONLY reconciliation report.
//
// This script does NOT write to the database (no prisma .create/.update/
// .upsert/.delete calls anywhere in this file) and does NOT call any
// Shopify mutation (only a single GraphQL `orders` QUERY, paginated).
// It exists purely to find paid orders that were never processed during
// the outage caused by the duplicate `handleRefundsCreate` declaration +
// missing `handleOrdersPaid` in web/routes/webhook.routes.js (introduced
// in commit 0fdc1ff, 2026-09-08, fixed after this).
//
// Cross-references live Shopify order data against the local
// ProcessedOrder idempotency table: any paid order with no matching
// ProcessedOrder row was never awarded points.
//
// Commit 0fdc1ff timestamp (verified via `git show -s --format=%cI 0fdc1ff`):
// 2026-09-08T16:58:40+05:30 = 2026-09-08T11:28:40Z. That's LATER than the
// START_DATE below, so the safely-inclusive default is used as-is rather
// than the (later) commit time, to make sure no affected order is missed.

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Import shopify.js BEFORE prisma.js: shopify.js loads the root .env file
// as a side effect at import time, and prisma.js's PrismaClient needs
// DATABASE_URL to already be in process.env when it's constructed.
import shopify from '../web/shopify.js';
import { prisma } from '../web/lib/prisma.js';
import { getClientForShop } from '../web/lib/shopify-sync.js';
import { calculateEarnedPoints } from '../web/lib/points.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --shop <myshopify-domain> is required
const shopArg = process.argv.find((a) => a.startsWith('--shop='))?.slice(7)
  ?? (process.argv[process.argv.indexOf('--shop') + 1]);
if (!shopArg || shopArg.startsWith('--')) {
  console.error('Usage: node scripts/reconcile-missing-orders.mjs --shop <myshopify-domain>');
  process.exit(1);
}
const SHOP = shopArg;
const START_DATE = '2026-09-08T00:00:00Z';

async function main() {
  console.log(`=== Reconciliation report for ${SHOP} ===`);
  console.log(`Checking paid orders created on/after ${START_DATE}\n`);

  const client = await getClientForShop(
    { sessionStorage: shopify.config.sessionStorage, api: shopify.api },
    SHOP
  );

  if (!client) {
    console.error(
      `No offline session found for ${SHOP}. Has the app been installed on this store yet? Nothing to reconcile without an authenticated session.`
    );
    process.exitCode = 1;
    return;
  }

  const ordersQuery = `
    query getOrders($cursor: String) {
      orders(first: 50, after: $cursor, query: "financial_status:paid created_at:>=${START_DATE}") {
        edges {
          node {
            id
            name
            createdAt
            customer { id }
            subtotalPriceSet { shopMoney { amount } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const allOrders = [];
  let cursor = null;
  let hasNextPage = true;
  let pageNumber = 0;

  while (hasNextPage) {
    pageNumber++;
    const response = await client.request(ordersQuery, { variables: { cursor } });
    const connection = response.data.orders;
    const nodes = connection.edges.map((edge) => edge.node);
    allOrders.push(...nodes);

    console.log(`Page ${pageNumber}: fetched ${nodes.length} orders (running total: ${allOrders.length})`);

    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  console.log(`\nTotal paid orders found since ${START_DATE}: ${allOrders.length}\n`);

  const settings = (await prisma.shopSettings.findUnique({ where: { shop: SHOP } })) || {
    spendAmount: 100,
    earnPoints: 1,
  };

  const missing = [];
  let guestOrdersSkipped = 0;

  for (const order of allOrders) {
    const orderId = order.id.replace('gid://shopify/Order/', '');

    const processed = await prisma.processedOrder.findUnique({
      where: { orderId_shop: { orderId, shop: SHOP } },
    });

    if (processed) continue; // already handled correctly — not missing

    if (!order.customer?.id) {
      guestOrdersSkipped++;
      continue; // guest checkouts were never eligible anyway, same as production logic
    }

    const subtotal = parseFloat(order.subtotalPriceSet?.shopMoney?.amount || '0');
    const pointsOwed = calculateEarnedPoints(subtotal, settings);

    missing.push({
      orderName: order.name,
      orderId,
      customerGid: order.customer.id,
      createdAt: order.createdAt,
      subtotal,
      pointsOwed,
    });
  }

  const totalPointsOwed = missing.reduce((sum, m) => sum + m.pointsOwed, 0);

  const byCustomer = {};
  for (const m of missing) {
    if (!byCustomer[m.customerGid]) {
      byCustomer[m.customerGid] = { pointsOwed: 0, orderCount: 0, orders: [] };
    }
    byCustomer[m.customerGid].pointsOwed += m.pointsOwed;
    byCustomer[m.customerGid].orderCount += 1;
    byCustomer[m.customerGid].orders.push(m.orderName);
  }

  // --- Console report ---
  console.log('=== RECONCILIATION REPORT ===');
  console.log(`Total paid orders checked:              ${allOrders.length}`);
  console.log(`Guest-checkout orders skipped:           ${guestOrdersSkipped}`);
  console.log(`Missing (never processed) orders:        ${missing.length}`);
  console.log(`Total points owed across missing orders: ${totalPointsOwed}\n`);

  if (missing.length > 0) {
    console.log('Order Name | Order ID | Customer GID | Subtotal | Points Owed | Created At');
    console.log('-----------|----------|--------------|----------|-------------|------------');
    for (const m of missing) {
      console.log(
        `${m.orderName} | ${m.orderId} | ${m.customerGid} | ${m.subtotal} | ${m.pointsOwed} | ${m.createdAt}`
      );
    }
    console.log('');

    console.log('=== BY CUSTOMER (what actually needs crediting per person) ===');
    for (const [gid, data] of Object.entries(byCustomer)) {
      console.log(`${gid}: ${data.pointsOwed} points owed across ${data.orderCount} order(s) [${data.orders.join(', ')}]`);
    }
    console.log('');
  } else {
    console.log('No missing orders found — every paid order in this window was already processed.\n');
  }

  // --- JSON report file ---
  const today = new Date().toISOString().slice(0, 10);
  const reportPath = join(__dirname, `reconciliation-report-${today}.json`);
  const report = {
    shop: SHOP,
    startDate: START_DATE,
    generatedAt: new Date().toISOString(),
    totalPaidOrdersChecked: allOrders.length,
    guestOrdersSkipped,
    missingOrdersCount: missing.length,
    totalPointsOwed,
    missingOrders: missing,
    byCustomer,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Full report written to ${reportPath}`);
}

main()
  .catch((err) => {
    console.error('Reconciliation script failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
