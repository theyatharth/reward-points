// scripts/backfill-missing-orders.mjs
//
// WRITES to the database (unless --dry-run / no flags — see below).
//
// Backfills PendingPoint / ProcessedOrder / PointTransaction rows for the
// orders identified by scripts/reconcile-missing-orders.mjs as never
// processed during the Sep 8-25 outage (webhook.routes.js failed to load —
// duplicate handleRefundsCreate declaration + missing handleOrdersPaid).
//
// SAFETY:
//   node scripts/backfill-missing-orders.mjs            -> dry run (default)
//   node scripts/backfill-missing-orders.mjs --dry-run   -> dry run (explicit)
//   node scripts/backfill-missing-orders.mjs --live       -> ACTUALLY WRITES
//   --dry-run always wins if both flags are passed together.
//
// Each order is processed in its own interactive prisma.$transaction, which
// re-checks ProcessedOrder for that order INSIDE the transaction (in case a
// Shopify webhook retry already processed it since the report was
// generated) before writing anything. Metafields are NOT touched per-order;
// see the separate sync pass at the end, once per distinct customer.

import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Import shopify.js BEFORE prisma.js: shopify.js loads the root .env file
// as a side effect at import time, and prisma.js's PrismaClient needs
// DATABASE_URL to already be in process.env when it's constructed.
import shopify from '../web/shopify.js';
import { prisma } from '../web/lib/prisma.js';
import { getClientForShop, syncPendingSummary } from '../web/lib/shopify-sync.js';
import { HOLD_PERIOD_DAYS } from '../web/lib/points.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
// --dry-run always wins if both flags are somehow passed together — safety
// override, not just "the default".
const isLive = args.includes('--live') && !args.includes('--dry-run');
const isDryRun = !isLive;

// --shop <myshopify-domain> is required
const shopArg = args.find((a) => a.startsWith('--shop='))?.slice(7)
  ?? (args[args.indexOf('--shop') + 1]);
if (!shopArg || shopArg.startsWith('--')) {
  console.error('Usage: node scripts/backfill-missing-orders.mjs --shop <myshopify-domain> [--live|--dry-run]');
  process.exit(1);
}
const SHOP = shopArg;
const BACKFILL_NOTE = 'Backfill: Sep 8-25 outage';

function findLatestReport() {
  const files = readdirSync(__dirname).filter((f) =>
    /^reconciliation-report-\d{4}-\d{2}-\d{2}\.json$/.test(f)
  );
  if (files.length === 0) {
    throw new Error(
      'No reconciliation-report-*.json file found in scripts/. Run reconcile-missing-orders.mjs first.'
    );
  }
  files.sort(); // ISO date strings in the filename sort chronologically
  return files[files.length - 1];
}

async function main() {
  console.log(
    isLive
      ? '=== LIVE RUN — this WILL write to the database ==='
      : '=== DRY RUN — no database writes, no metafield syncs ==='
  );
  console.log(
    isLive
      ? '(Re-run with --dry-run, or no flags, to preview without writing.)'
      : '(Pass --live to actually perform these writes.)'
  );

  const reportFile = findLatestReport();
  const reportPath = join(__dirname, reportFile);
  console.log(`\nUsing report: ${reportFile}`);

  const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
  const missingOrders = report.missingOrders || [];
  console.log(`Report has ${missingOrders.length} missing order(s) to consider.\n`);

  let backfilled = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];
  const touchedCustomers = new Set(); // GIDs actually (or, in dry-run, would-be) written this run

  for (const order of missingOrders) {
    const { orderName, orderId, customerGid, createdAt, pointsOwed } = order;
    const eligibleAt = new Date(new Date(createdAt).getTime() + HOLD_PERIOD_DAYS * 24 * 60 * 60 * 1000);

    if (isDryRun) {
      // Still do the re-check (a read, not a write) so dry-run output
      // matches live behavior exactly, including which orders would skip.
      const alreadyProcessed = await prisma.processedOrder.findUnique({
        where: { orderId_shop: { orderId, shop: SHOP } },
      });

      if (alreadyProcessed) {
        console.log(`WOULD SKIP       ${orderName} (${customerGid}) — already processed since report was generated.`);
        skipped++;
        continue;
      }

      console.log(
        `WOULD BACKFILL   ${orderName} | ${customerGid} | +${pointsOwed} pts | eligibleAt=${eligibleAt.toISOString()}`
      );
      backfilled++;
      touchedCustomers.add(customerGid);
      continue;
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const alreadyProcessed = await tx.processedOrder.findUnique({
          where: { orderId_shop: { orderId, shop: SHOP } },
        });
        if (alreadyProcessed) {
          return { skipped: true };
        }

        await tx.processedOrder.create({ data: { orderId, shop: SHOP } });

        await tx.pendingPoint.create({
          data: {
            shopifyCustomerId: customerGid,
            shop: SHOP,
            orderId,
            points: pointsOwed,
            eligibleAt,
          },
        });

        await tx.pointTransaction.create({
          data: {
            shopifyCustomerId: customerGid,
            shop: SHOP,
            action: `Order ${orderName} (${BACKFILL_NOTE})`,
            points: pointsOwed,
            status: 'Pending',
            orderId,
          },
        });

        return { skipped: false };
      });

      if (result.skipped) {
        console.log(`SKIP        ${orderName} (${customerGid}) — already processed since report was generated.`);
        skipped++;
      } else {
        console.log(
          `BACKFILLED  ${orderName} | ${customerGid} | +${pointsOwed} pts | eligibleAt=${eligibleAt.toISOString()}`
        );
        backfilled++;
        touchedCustomers.add(customerGid);
      }
    } catch (err) {
      if (err.code === 'P2002') {
        // Something claimed ProcessedOrder for this order between our
        // in-transaction check and our create — a genuine concurrent
        // backfill/retry race, not a failure.
        console.log(`SKIP        ${orderName} (${customerGid}) — claimed concurrently during backfill.`);
        skipped++;
      } else {
        console.error(`FAILED      ${orderName} (${customerGid}) [order ${orderId}]: ${err.message}`);
        failed++;
        failures.push({ orderName, orderId, customerGid, error: err.message });
      }
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`${isDryRun ? 'Would backfill' : 'Backfilled'}: ${backfilled}`);
  console.log(`Skipped (already processed): ${skipped}`);
  console.log(`Failed: ${failed}`);

  if (failures.length > 0) {
    console.log('\n=== FAILURES ===');
    for (const f of failures) {
      console.log(`  ${f.orderName} (${f.customerGid}) [order ${f.orderId}]: ${f.error}`);
    }
  }

  // --- Metafield sync pass: once per distinct customer, not once per order ---
  console.log(`\n=== METAFIELD SYNC PASS (${touchedCustomers.size} distinct customer(s)) ===`);

  if (isDryRun) {
    console.log('(dry run — no metafield syncs performed)');
    for (const gid of touchedCustomers) {
      console.log(`  WOULD SYNC pending summary for ${gid}`);
    }
  } else if (touchedCustomers.size === 0) {
    console.log('Nothing to sync.');
  } else {
    const client = await getClientForShop(
      { sessionStorage: shopify.config.sessionStorage, api: shopify.api },
      SHOP
    );

    if (!client) {
      console.error(
        `No offline session for ${SHOP} — could not sync metafields for ${touchedCustomers.size} customer(s). ` +
          `Their PendingPoint rows are correct in the DB regardless; metafields will catch up the next time ` +
          `promotePendingPoints() or a webhook runs for each customer.`
      );
    } else {
      let syncedCount = 0;
      let syncFailedCount = 0;

      for (const gid of touchedCustomers) {
        try {
          const pending = await prisma.pendingPoint.findMany({
            where: { shop: SHOP, shopifyCustomerId: gid },
            orderBy: { eligibleAt: 'asc' },
          });
          const pendingTotal = pending.reduce((sum, p) => sum + p.points, 0);
          await syncPendingSummary(client, gid, pendingTotal, pending[0]?.eligibleAt ?? null);
          console.log(`  Synced ${gid}: ${pendingTotal} pending points.`);
          syncedCount++;
        } catch (err) {
          console.error(`  Metafield sync FAILED for ${gid}: ${err.message}`);
          syncFailedCount++;
        }
      }

      console.log(
        `\nSynced pending-summary metafields for ${syncedCount} customer(s).` +
          (syncFailedCount > 0 ? ` ${syncFailedCount} failed (logged above; DB writes are unaffected).` : '')
      );
    }
  }
}

main()
  .catch((err) => {
    console.error('Backfill script failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
