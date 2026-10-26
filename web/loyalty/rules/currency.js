// web/loyalty/rules/currency.js
//
// The shop's currency symbol, derived from the shop's configured ISO code (LoyaltyConfig.currency), never assumed.
// "INR" -> "₹", "USD" -> "$", "EUR" -> "€", "AED" -> "AED " (a code-like symbol gets a trailing space). A missing or
// malformed code gives NO symbol: an amount is shown bare rather than with the wrong currency.
//
// The same few lines are repeated in two browser files that cannot import this module:
//   web/admin/public/format.js (admin console) and extensions/rewards-widget/assets/rewards-client.js (storefront).
// test/loyalty/currency.test.js proves all three agree.
//
// Amounts are integer minor units at 100 per major unit throughout this system, so currencies with no minor unit
// (JPY) or three (KWD) are not supported; see docs/CLIENT-TEST-GUIDE.md, known gaps.

const cache = new Map();

/** "inr" -> "INR"; anything that is not three letters -> null. */
export function normalizeCurrency(code) {
  const c = typeof code === 'string' ? code.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

/** The symbol to put before an amount: "₹", "$", "€", "AED ", or "" when the code is missing or malformed. */
export function currencySymbol(code) {
  const c = normalizeCurrency(code);
  if (!c) return '';
  if (cache.has(c)) return cache.get(c);
  let symbol = c;
  try {
    const part = new Intl.NumberFormat('en-US', { style: 'currency', currency: c, currencyDisplay: 'symbol' }).formatToParts(0).find((p) => p.type === 'currency');
    if (part?.value) symbol = part.value;
  } catch { /* an unknown code is shown as itself */ }
  if (/[A-Za-z]$/.test(symbol)) symbol += ' ';
  cache.set(c, symbol);
  return symbol;
}

/**
 * An amount with the shop's symbol. Whole amounts drop the decimals ("₹10", "$10"), others show two ("₹10.50").
 * Grouping follows the shop's currency: lakh grouping for INR, thousands otherwise.
 * @param {number|string} value  a decimal amount in major units ("1349.91")
 * @param {string} code          the shop's ISO currency code
 * @returns {string}             "" when value is not a number
 */
export function formatMoney(value, code) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const locale = normalizeCurrency(code) === 'INR' ? 'en-IN' : 'en-US';
  const text = Math.abs(n).toLocaleString(locale, { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${currencySymbol(code)}${text}`;
}

/** Why a shop in this currency earns and redeems nothing (shown in the console, on skipped events and in refusals). */
export const unsupportedCurrencyReason = (code) =>
  `The shop currency (${normalizeCurrency(code) ?? 'unknown'}) is not supported: only currencies with two decimals are, so no points are earned, reversed, redeemed or adjusted`;

/**
 * Whether amounts in this currency can be kept as whole hundredths ("paise"), which every amount in this system assumes.
 * Only currencies with exactly two decimals are supported: JPY (none), KWD (three) and the like are not. The digits come from
 * Intl (ISO 4217); a code Intl does not know is NOT supported.
 */
export function isTwoDecimalCurrency(code) {
  const c = normalizeCurrency(code);
  if (!c) return false;
  try {
    const o = new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).resolvedOptions();
    return o.minimumFractionDigits === 2 && o.maximumFractionDigits === 2;
  } catch {
    return false;
  }
}
