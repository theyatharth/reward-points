// web/admin/data/program.js: what the console shell needs about the shop's program on every page (GET /admin/api/meta -> program):
// whether the currency is supported (the banner), and, later, the program's name.

import { prisma } from '../../lib/prisma.js';
import { isTwoDecimalCurrency, unsupportedCurrencyReason } from '../../loyalty/rules/currency.js';

/** @returns {Promise<{ configured: boolean, currency: string|null, currencySupported: boolean, currencyMessage: string|null }>} */
export async function programInfo(shop) {
  const config = await prisma.loyaltyConfig.findUnique({ where: { shop }, select: { currency: true } });
  if (!config) return { configured: false, currency: null, currencySupported: true, currencyMessage: null };
  const supported = isTwoDecimalCurrency(config.currency);
  return {
    configured: true,
    currency: config.currency,
    currencySupported: supported,
    currencyMessage: supported ? null : `${unsupportedCurrencyReason(config.currency)}. Events from this shop are skipped and customers cannot redeem.`,
  };
}
