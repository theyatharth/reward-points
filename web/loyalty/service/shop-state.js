// web/loyalty/service/shop-state.js
//
// Whether the app is installed on a shop (ShopInstall). The uninstall webhook marks a shop "uninstalled"; the access token is
// dropped with its sessions; the shop's data stays until Shopify sends shop/redact (48 hours later). While a shop is
// uninstalled the background jobs leave it alone (they would call Shopify with no token): events wait, lots stay pending, nothing is
// synced. A reinstall (the next token exchange runs the afterAuth hook) marks it active again and everything resumes.
// A shop with no ShopInstall row counts as active (shops that were onboarded before this table existed).

import { prisma } from '../../lib/prisma.js';
import { now } from '../adapters/clock.js';

/** Shops currently uninstalled. Small list, read by the jobs once per run. */
export async function inactiveShops() {
  const rows = await prisma.shopInstall.findMany({ where: { status: 'uninstalled' }, select: { shop: true } });
  return rows.map((r) => r.shop);
}

/** A shop name list that can never match everything: Prisma's `notIn: []` is fine, SQL's `<> ALL('{}')` is true for every row. */
export const notInactive = (inactive) => (inactive.length ? { notIn: inactive } : undefined);

/** True only for a shop explicitly marked uninstalled (no row = active). */
export async function isMarkedUninstalled(shop) {
  const row = await prisma.shopInstall.findUnique({ where: { shop }, select: { status: true } });
  return row?.status === 'uninstalled';
}

export async function markUninstalled(shop) {
  const t = now();
  await prisma.shopInstall.upsert({
    where: { shop },
    create: { shop, status: 'uninstalled', uninstalledAt: t },
    update: { status: 'uninstalled', uninstalledAt: t, updatedAt: t },
  });
}

/** A first install or a reinstall: active again. Scopes are kept when given. */
export async function markInstalled(shop, scopes) {
  const t = now();
  const text = typeof scopes === 'string' && scopes ? scopes : undefined;
  const row = await prisma.shopInstall.upsert({
    where: { shop },
    create: { shop, status: 'active', installedAt: t, scopes: text },
    update: { status: 'active', uninstalledAt: null, updatedAt: t, ...(text ? { scopes: text } : {}) },
  });
  return row;
}

/** app/scopes_update: the scopes the merchant granted now. Also written to the stored session, whose scope the library checks. */
export async function updateScopes(shop, scopes) {
  const list = (Array.isArray(scopes) ? scopes : []).filter((s) => typeof s === 'string' && /^[a-z_]{1,60}$/.test(s));
  const text = [...new Set(list)].join(',');
  const t = now();
  await prisma.shopInstall.upsert({
    where: { shop },
    create: { shop, status: 'active', installedAt: t, scopes: text },
    update: { scopes: text, updatedAt: t },
  });
  await prisma.session.updateMany({ where: { shop }, data: { scope: text } });
  return text;
}
