// @ts-check
import crypto from 'crypto';

/**
 * Calculates how many points a customer earns for a given order subtotal.
 * @param {number} subtotal - Order subtotal in the store's currency
 * @param {{ spendAmount: number, earnPoints: number }} settings
 * @returns {number}
 */
export function calculateEarnedPoints(subtotal, settings) {
  if (!subtotal || subtotal <= 0) return 0;
  if (!settings.spendAmount || settings.spendAmount <= 0) return 0;
  return Math.floor(subtotal / settings.spendAmount) * settings.earnPoints;
}

/**
 * Calculates how many points to deduct for a given refund subtotal.
 * @param {number} refundSubtotal
 * @param {{ spendAmount: number, earnPoints: number }} settings
 * @returns {number}
 */
export function calculateDeductedPoints(refundSubtotal, settings) {
  return calculateEarnedPoints(refundSubtotal, settings);
}

/**
 * Calculates the discount amount for a given point balance and shop settings.
 * Returns { pointsToDeduct, discountAmount }.
 * @param {number} currentPoints
 * @param {{ redeemPoints: number, discountValue: number }} settings
 * @returns {{ pointsToDeduct: number, discountAmount: number } | null}
 */
export function calculateRedemption(currentPoints, settings) {
  if (
    !settings.redeemPoints ||
    settings.redeemPoints <= 0 ||
    currentPoints < settings.redeemPoints
  ) {
    return null;
  }
  const chunks = Math.floor(currentPoints / settings.redeemPoints);
  const pointsToDeduct = chunks * settings.redeemPoints;
  const discountAmount = parseFloat((chunks * settings.discountValue).toFixed(2));
  return { pointsToDeduct, discountAmount };
}

/**
 * Generates a unique reward discount code for this shop.
 * @param {string} shop - e.g. "my-store.myshopify.com"
 * @returns {string}
 */
export function generateDiscountCode(shop) {
  // Use first 4 chars of shop name (uppercased) + a cryptographically random
  // 8-char suffix. Math.random() is not a CSPRNG and can also yield a SHORT
  // string here (base36 of a small float has fewer than 6 digits), which
  // used to occasionally shrink the effective code space even further.
  const prefix = shop.split('.')[0].toUpperCase().slice(0, 4);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids support ambiguity
  const bytes = crypto.randomBytes(8);
  const suffix = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return `${prefix}-${suffix}`;
}

/**
 * Checks whether a discount code in an order payload is one of ours.
 * Our codes follow the pattern: 4LETTERS-6ALPHANUM (e.g. MYSH-AB12CD)
 * @param {any} payload - Shopify order webhook payload
 * @param {string} shop
 * @returns {boolean}
 */
export function wasRewardCodeUsed(payload, shop) {
  const prefix = shop.split('.')[0].toUpperCase().slice(0, 4) + '-';
  const codes = payload.discount_codes || [];
  const apps = payload.discount_applications || [];
  return (
    codes.some(
      (dc) => dc.code && dc.code.toUpperCase().startsWith(prefix)
    ) ||
    apps.some(
      (da) =>
        (da.code && da.code.toUpperCase().startsWith(prefix)) ||
        (da.title && da.title.toUpperCase().startsWith(prefix))
    )
  );
}
