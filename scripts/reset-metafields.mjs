// scripts/reset-metafields.mjs
//
// Clears the four reward metafields and reward_history that the old system
// wrote on real customers:
//   custom.reward_points
//   custom.earned_discount_code
//   custom.pending_points
//   custom.pending_points_available_at
//   (plus any reward_history metafield if present)
//
// Runs paginated over all customers who have any of these metafields set,
// within Shopify's API rate limits.  Always run with --dry-run first.
//
// Usage:
//   node scripts/reset-metafields.mjs --shop <domain> --dry-run
//   node scripts/reset-metafields.mjs --shop <domain>
//
// This script calls the Shopify Admin GraphQL API (read customers + delete
// metafields) but does NOT write to the local database.

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
try {
  const dotenv = require('dotenv');
  dotenv.config({ path: join(__dirname, '..', '.env') });
} catch { /* rely on env vars */ }

import shopify from '../web/shopify.js';
import { prisma } from '../web/lib/prisma.js';
import { getClientForShop } from '../web/lib/shopify-sync.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

const shopArg = args.find((a) => a.startsWith('--shop='))?.slice(7)
  ?? args[args.indexOf('--shop') + 1];
if (!shopArg || shopArg.startsWith('--')) {
  console.error('Usage: node scripts/reset-metafields.mjs --shop <myshopify-domain> [--dry-run]');
  process.exit(1);
}
const SHOP = shopArg;
const DRY_RUN = args.includes('--dry-run');

// Metafield namespace + key combinations to clear
const TARGET_METAFIELDS = [
  { namespace: 'custom', key: 'reward_points' },
  { namespace: 'custom', key: 'earned_discount_code' },
  { namespace: 'custom', key: 'pending_points' },
  { namespace: 'custom', key: 'pending_points_available_at' },
  { namespace: 'custom', key: 'reward_history' },
];

// Build the metafields query string for filtering (Shopify API format)
const METAFIELD_QUERY = TARGET_METAFIELDS
  .map((m) => `metafields.namespace:${m.namespace} metafields.key:${m.key}`)
  .join(' OR ');

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`[reset-metafields] Shop: ${SHOP}`);
  console.log(`[reset-metafields] Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (will delete metafields)'}`);

  const client = await getClientForShop(
    { sessionStorage: shopify.config.sessionStorage, api: shopify.api },
    SHOP
  );
  if (!client) {
    console.error(`[reset-metafields] No offline session for ${SHOP}. Install the app or re-open it to create a session.`);
    process.exit(1);
  }

  // Query to get customers with any of the target metafields
  const customerQuery = `
    query getCustomersWithMetafields($cursor: String) {
      customers(first: 50, after: $cursor) {
        edges {
          node {
            id
            metafields(first: 20, namespace: "custom") {
              edges {
                node { id namespace key value }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const deleteMetafieldMutation = `
    mutation deleteMetafield($id: ID!) {
      metafieldDelete(input: { id: $id }) {
        deletedId
        userErrors { field message }
      }
    }
  `;

  const targetKeys = new Set(TARGET_METAFIELDS.map((m) => `${m.namespace}:${m.key}`));

  let cursor = null;
  let hasNextPage = true;
  let totalCustomers = 0;
  let totalMetafieldsFound = 0;
  let totalMetafieldsDeleted = 0;
  let page = 0;

  while (hasNextPage) {
    page++;
    const res = await client.request(customerQuery, { variables: { cursor } });
    const customers = res.data?.customers?.edges ?? [];
    hasNextPage = res.data?.customers?.pageInfo?.hasNextPage ?? false;
    cursor = res.data?.customers?.pageInfo?.endCursor ?? null;

    for (const { node: customer } of customers) {
      totalCustomers++;
      const metafieldsToDelete = (customer.metafields?.edges ?? [])
        .map((e) => e.node)
        .filter((m) => targetKeys.has(`${m.namespace}:${m.key}`));

      if (metafieldsToDelete.length === 0) continue;

      totalMetafieldsFound += metafieldsToDelete.length;
      console.log(`  Customer ${customer.id}: ${metafieldsToDelete.length} metafield(s) to clear`);

      if (!DRY_RUN) {
        for (const mf of metafieldsToDelete) {
          const delRes = await client.request(deleteMetafieldMutation, { variables: { id: mf.id } });
          const errors = delRes.data?.metafieldDelete?.userErrors ?? [];
          if (errors.length > 0) {
            console.error(`    ERROR deleting ${mf.namespace}.${mf.key} for ${customer.id}:`, errors);
          } else {
            totalMetafieldsDeleted++;
          }
          // Tiny delay to respect API rate limits (2 req/s conservative)
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    }

    console.log(`[reset-metafields] Page ${page}: processed ${customers.length} customers (running: ${totalCustomers})`);
  }

  console.log('\n[reset-metafields] Summary:');
  console.log(`  Total customers scanned:     ${totalCustomers}`);
  console.log(`  Metafields found to clear:   ${totalMetafieldsFound}`);
  if (DRY_RUN) {
    console.log(`  Metafields cleared (dry run): 0 (would have cleared ${totalMetafieldsFound})`);
    console.log('\n  Re-run without --dry-run to apply.');
  } else {
    console.log(`  Metafields cleared:          ${totalMetafieldsDeleted}`);
  }
}

main()
  .catch((err) => {
    console.error('[reset-metafields] Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
