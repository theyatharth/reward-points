// scripts/onboard-shop.mjs
//
// Onboards a shop onto the loyalty ledger: creates its LoyaltyConfig from the seed profile with the given currency and holding
// period and ledgerStartAt = now, prints the result, and (with --admin-email) creates its first admin user with a one-time
// password (must be changed at first sign-in). Safe to run twice: an existing config is reported and NOT changed.
//
//   node scripts/onboard-shop.mjs --shop <domain>.myshopify.com --currency INR --hold-days 1 [--admin-email <email>]
//
// On the dev server, through the guard wrapper:  node $D/.tmp/run-db.mjs dev node scripts/onboard-shop.mjs --shop ...
// Refuses any protected database (production, the shared instance, system databases): see web/lib/db-guard.js.

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
try {
  require('dotenv').config({ path: join(__dirname, '..', '.env') });
} catch { /* rely on the environment */ }

import { assertNotProtected } from '../web/lib/db-guard.js';
assertNotProtected(process.env.DATABASE_URL || '');
const { prisma } = await import('../web/lib/prisma.js');
const { onboardShop, OnboardingError } = await import('../web/loyalty/service/onboarding.js');

const arg = (name) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : undefined;
};

const shop = arg('shop');
const currency = arg('currency');
const holdRaw = arg('hold-days');
const adminEmail = arg('admin-email');
if (!shop || !currency || holdRaw === undefined) {
  console.error('Usage: node scripts/onboard-shop.mjs --shop <domain>.myshopify.com --currency INR --hold-days 1 [--admin-email <email>]');
  process.exit(1);
}

try {
  console.log(`[onboard-shop] database: ${new URL(process.env.DATABASE_URL).pathname.slice(1)}`);
  const holdDays = /^\d{1,3}$/.test(holdRaw) ? Number(holdRaw) : NaN;
  const r = await onboardShop({ shop, currency, holdDays, adminEmail });
  console.log(r.created ? `[onboard-shop] CREATED the loyalty config for ${shop}` : `[onboard-shop] ${shop} already has a loyalty config: left unchanged`);
  for (const d of r.differences) console.log(`  note: ${d}. Not changed here; change a rule in the admin console (Earning & redemption).`);
  for (const [k, v] of Object.entries(r.config)) console.log(`  ${k.padEnd(26)} ${v}`);
  if (!r.installed) console.log('  note: no offline session for this shop yet. Install the app on the shop first, or webhooks cannot be verified and nothing can be created in Shopify.');
  if (r.admin) {
    console.log(r.admin.created ? `[onboard-shop] CREATED admin ${r.admin.email} (must change the password at first sign-in)` : `[onboard-shop] admin ${r.admin.email} already exists: left unchanged`);
    if (r.admin.created) console.log(`  one-time password (shown once): ${r.admin.oneTimePassword}`);
  }
} catch (err) {
  console.error(`[onboard-shop] ${err instanceof OnboardingError ? err.message : `failed: ${err.message}`}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
