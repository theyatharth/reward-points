// web/loyalty/rules/money.js
//
// T1.3: Integer paise arithmetic for Shopify monetary values.
//
// All amounts in the loyalty system are stored and computed as integer paise
// (the smallest currency unit — 1/100th of a rupee, or 1/100th of whatever
// currency the store uses).  This prevents floating-point drift.
//
// Shopify sends amounts as decimal strings ("629.95") or, occasionally, as
// JSON numbers (629.95).  We parse them once, multiply by 100, and round to
// get integer paise.  All subsequent arithmetic is integer-only.
//
// No database, no Shopify, no clock — pure functions only.

/**
 * Parse a Shopify decimal amount string (or number) into integer paise.
 *
 * Handles:
 *   "629.95"  → 62995
 *   "0.00"    → 0
 *   "1000"    → 100000
 *   629.95    → 62995  (JSON number — treated the same as string)
 *   ""        → 0
 *   null      → 0
 *
 * Rounds half-up (0.005 → 1 paise) to match standard financial rounding.
 *
 * @param {string | number | null | undefined} value
 * @returns {number} integer paise
 */
export function parsePaise(value) {
  if (value === null || value === undefined || value === '') return 0;
  // Convert to string for uniform handling.
  const str = String(value).trim();
  if (str === '0' || str === '0.00' || str === '0.0') return 0;

  // Split at the decimal point.
  const [intPart, fracPart = ''] = str.split('.');

  // Take exactly two decimal digits; pad with zeros if the string has fewer.
  const twoDigits = (fracPart + '00').slice(0, 2);

  const paiseStr = intPart + twoDigits;
  const paise = parseInt(paiseStr, 10);

  if (isNaN(paise)) {
    throw new Error(`[money] Cannot parse "${value}" as a monetary amount.`);
  }
  return paise;
}

/**
 * Format integer paise as a human-readable currency string.
 *
 * @param {number} paise - integer paise
 * @param {string} [currency='INR']
 * @returns {string}  e.g. "₹629.95" or "USD 629.95"
 */
export function formatPaise(paise, currency = 'INR') {
  const major = Math.floor(Math.abs(paise) / 100);
  const minor = Math.abs(paise) % 100;
  const sign = paise < 0 ? '-' : '';
  const formatted = `${major}.${String(minor).padStart(2, '0')}`;

  if (currency === 'INR') return `${sign}₹${formatted}`;
  return `${sign}${currency} ${formatted}`;
}

/**
 * Multiply paise by a ratio (numerator / denominator) and apply a rounding
 * mode.  All intermediate values are integers — no floating point.
 *
 * Rounding modes (match the client's prototype engine):
 *   "floor"  — always round down   (conservative, never over-awards)
 *   "round"  — round half-up       (standard financial rounding)
 *   "block"  — whole spend blocks only: floor(paise / denominator) x numerator
 *              (the client's engine: spend 100 earns 100 points per full block, so 149 earns 100)
 *
 * @param {number} paise       - value in integer paise
 * @param {number} numerator   - e.g. pointsPerUnit
 * @param {number} denominator - e.g. unitSizePaise (1 unit = 100 paise for ₹1)
 * @param {'floor'|'round'|'block'} mode
 * @returns {number} integer points
 */
export function multiplyPoints(paise, numerator, denominator, mode) {
  if (denominator === 0) throw new Error('[money] Denominator cannot be zero.');
  if (paise <= 0 || numerator <= 0) return 0;

  // Compute exact quotient * 100 to avoid floats:
  //   quotient = (paise * numerator) / denominator
  // We keep 2 decimal digits of precision by working in integer centesimal:
  //   quotientCent = Math.floor((paise * numerator * 100) / denominator)
  //   fraction     = quotientCent % 100   (0..99)
  //   whole        = Math.floor(quotientCent / 100)
  const product = paise * numerator;
  const quotientCent = Math.floor((product * 100) / denominator);
  const whole = Math.floor(quotientCent / 100);
  const fraction = quotientCent % 100; // centesimal remainder

  switch (mode) {
    case 'floor':
      return whole;

    case 'round':
      // Round half-up: fraction >= 50 → round up
      return fraction >= 50 ? whole + 1 : whole;

    case 'block':
      // Whole spend blocks only, as the client's engine.pointsFor does: Math.floor(value / spend) * points.
      // (An earlier reading, "nothing unless exact", was wrong: it gave 0 for 149 where the engine gives 100.)
      return Math.floor(paise / denominator) * numerator;

    default:
      throw new Error(`[money] Unknown rounding mode: "${mode}".`);
  }
}

/**
 * Divide paise by another paise amount and return the integer quotient.
 * Used for reversal calculations: how many points does this refund represent
 * out of the total order?
 *
 * Returns 0 if dividend is zero or divisor is larger than dividend.
 *
 * @param {number} dividend - paise
 * @param {number} divisor  - paise
 * @returns {number} integer quotient (no remainder)
 */
export function dividePaise(dividend, divisor) {
  if (divisor <= 0) throw new Error('[money] Divisor must be positive.');
  return Math.floor(dividend / divisor);
}
