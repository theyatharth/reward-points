#!/usr/bin/env node
// scripts/run-reconciliation.mjs
//
// Runs the ledger reconciliation for one shop on demand and prints the summary.
//
//   node scripts/run-reconciliation.mjs --shop platinum-ecofynd-test-store.myshopify.com
//   node scripts/run-reconciliation.mjs --shop <shop> --repair     (also rebuilds wrong cached balances)
//
// Report only by default. With --repair, accounts whose cached balances disagree with their
// lots and the ledger are rebuilt (each rebuild writes an AuditLog row); an account the ledger
// cannot explain is reported, never changed. The full result is also saved as a JobRun
// (jobType "reconcile", trigger "manual"). The database guard in web/lib/prisma.js applies.
// Prints counts and customer ids only: no names, emails or phone numbers exist in the ledger.

import '../web/lib/load-env.js'; // first: prisma.js reads DATABASE_URL on import
import { prisma } from '../web/lib/prisma.js';
import { assertNotProtected } from '../web/lib/db-guard.js';
import { runReconciliation } from '../web/loyalty/service/reconcile.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const shop = opt('--shop');
const repair = args.includes('--repair');
if (!shop) { console.error('Usage: node scripts/run-reconciliation.mjs --shop <myshopify-domain> [--repair]'); process.exit(1); }

assertNotProtected(process.env.DATABASE_URL || '');

try {
  const dbName = new URL(process.env.DATABASE_URL).pathname.slice(1).split('?')[0];
  console.log(`[reconcile] database: ${dbName} | shop: ${shop} | ${repair ? 'REPAIR' : 'report only'}`);
  const r = await runReconciliation({ shop, repair, trigger: 'manual' });
  console.log(`[reconcile] accounts checked: ${r.accountsChecked}, with discrepancies: ${r.accountsWithDiscrepancies} (${r.discrepancyCount} findings)`);
  for (const [code, n] of Object.entries(r.byCode)) console.log(`[reconcile]   ${code}: ${n}`);
  for (const d of r.discrepancies.slice(0, 20)) console.log(`[reconcile]   customer ${d.shopifyCustomerId}: ${d.code} ${d.expected !== undefined ? `(expected ${d.expected}, found ${d.found})` : ''}`);
  if (repair) console.log(`[reconcile] rebuilt: ${r.repaired}, needs a person: ${r.unrepairable.length}`);
  console.log(`[reconcile] events: ${JSON.stringify(r.eventHealth)}`);
} catch (err) {
  console.error('[reconcile] failed:', err.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
