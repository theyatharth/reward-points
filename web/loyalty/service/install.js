// web/loyalty/service/install.js
//
// Install setup for the public app: when a shop first opens the app (token exchange, or the OAuth callback), read its currency
// from the Admin API and create its LoyaltyConfig from the seed profile (hold 30 days, ledgerStartAt = now). No script, no
// operator. Three rules:
//   * idempotent: a shop that already has a config is left exactly as it is (a reinstall, a second tab, a retry);
//   * never fails the request: runInstallSetup logs and returns; ensureShopConfig reports { status: 'failed' } and the callers
//     that matter retry it (the worker, when an event finds no config, and every console start);
//   * never guesses: if the currency cannot be read there is NO config (a made-up currency would put wrong amounts on every
//     order). A currency with other than two decimals still gets its config; rules/currency.js isTwoDecimalCurrency() is the
//     "not supported" flag the currency guard (step 6) reads from the stored code.

import { prisma } from '../../lib/prisma.js';
import { normalizeCurrency, isTwoDecimalCurrency } from '../rules/currency.js';
import { createShopConfig } from './onboarding.js';

export const INSTALL_HOLD_DAYS = 30;

/**
 * @param {string} shop
 * @param {{ getShopCurrency: () => Promise<string> }} gateway
 * @returns {Promise<{ status: 'exists' | 'created' | 'failed', currency?: string, supported?: boolean, error?: string }>}
 */
export async function ensureShopConfig(shop, gateway) {
  const existing = await prisma.loyaltyConfig.findUnique({ where: { shop }, select: { currency: true } });
  if (existing) return { status: 'exists', currency: existing.currency, supported: isTwoDecimalCurrency(existing.currency) };

  let currency;
  try {
    currency = normalizeCurrency(await gateway.getShopCurrency());
    if (!currency) throw new Error('Shopify returned a currency that is not a three-letter code');
  } catch (err) {
    return { status: 'failed', error: `could not read the shop currency: ${err.message}` };
  }

  const created = await createShopConfig({ shop, currency, holdDays: INSTALL_HOLD_DAYS });
  const supported = isTwoDecimalCurrency(currency);
  if (created) {
    await prisma.auditLog.create({ data: { shop, adminId: null, action: 'app_installed', detail: { currency, supported, holdPeriodDays: INSTALL_HOLD_DAYS } } })
      .catch((err) => console.error('[install] audit write failed:', err.message));
  }
  return { status: created ? 'created' : 'exists', currency, supported };
}

/**
 * The shopifyApp() afterAuth hook body. Never throws: whatever goes wrong is logged and the request carries on.
 * @param {{ session: { shop: string } }} arg
 * @param {(shop: string) => { getShopCurrency: () => Promise<string> }} gatewayFor
 */
export async function runInstallSetup({ session }, gatewayFor, log = console) {
  const shop = session?.shop;
  try {
    if (typeof shop !== 'string' || shop === '') return { status: 'failed', error: 'no shop in the session' };
    const result = await ensureShopConfig(shop, gatewayFor(shop));
    if (result.status === 'failed') log.error(`[install] ${shop}: ${result.error}. The shop will be set up on its next console visit or when its first event is processed.`);
    else if (result.status === 'created') log.log(`[install] ${shop}: configuration created (${result.currency}, hold ${INSTALL_HOLD_DAYS} days${result.supported ? '' : ', currency NOT supported: no points will be earned or redeemed'})`);
    return result;
  } catch (err) {
    log.error(`[install] ${shop}: setup failed: ${err.message}`);
    return { status: 'failed', error: err.message };
  }
}
