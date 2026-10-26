// web/admin/data/program.js: what the console shell needs about the shop's program on every page (GET /admin/api/meta -> program):
// the program's name (the console's heading) and whether the currency is supported (the banner), and whether to open on "Get started".

import { prisma } from '../../lib/prisma.js';
import { DEFAULT_PROGRAM_NAME } from '../../loyalty/rules/config.js';
import { shouldShowGetStarted } from './get-started.js';
import { isTwoDecimalCurrency, unsupportedCurrencyReason } from '../../loyalty/rules/currency.js';

/** @returns {Promise<{ configured: boolean, name: string, currency: string|null, currencySupported: boolean, currencyMessage: string|null }>} */
export async function programInfo(shop) {
  const config = await prisma.loyaltyConfig.findUnique({ where: { shop }, select: { currency: true, programName: true } });
  const showGetStarted = await shouldShowGetStarted(shop);
  if (!config) return { configured: false, name: DEFAULT_PROGRAM_NAME, currency: null, currencySupported: true, currencyMessage: null, showGetStarted };
  const supported = isTwoDecimalCurrency(config.currency);
  return {
    configured: true,
    name: config.programName,
    currency: config.currency,
    currencySupported: supported,
    currencyMessage: supported ? null : `${unsupportedCurrencyReason(config.currency)}. Events from this shop are skipped and customers cannot redeem.`,
    showGetStarted, // true: the console opens on "Get started" (no setup-done mark, no order yet)
  };
}
