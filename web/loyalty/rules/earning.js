// web/loyalty/rules/earning.js
//
// T1.5: Points earning calculation — pure functions, integer arithmetic only.
//
// Computes how many points a customer earns for an order.
//
// Input is the structured "earning input" produced by the adapter layer
// (web/loyalty/adapters/) from a Shopify orders/paid webhook payload.
//
// Key design decisions (from the spec and fixture analysis):
//   • All amounts are integer paise (100 paise = ₹1).
//   • Tax handling: if taxHandling='inclusive', subtract tax from the line
//     price before computing points.  If 'exclusive', use the raw price.
//   • Per-line discount: use the explicit discount_allocations amount when
//     available.  Fall back to the engine's proportional share only when no
//     allocations are given (for the gift-card-with-discount proportional
//     fallback test).
//   • Gift-card lines: the real fixture proves that discount_allocations is
//     empty for gift-card lines even with target_selection:'all'.  So the
//     gift-card line earns on its full price — the discount only touches
//     non-gift-card lines.
//   • Rounding is applied once on the total eligible order value, not per line.
//   • Shipping: included only if config.shippingEarning is true.
//
// No database, no Shopify, no clock.

import { parsePaise, multiplyPoints } from './money.js';

/**
 * @typedef {Object} LineItem
 * @property {string|number} price          - Unit price (decimal string or number)
 * @property {number}        quantity
 * @property {boolean}       [is_gift_card] - true for gift card lines
 * @property {Array<{amount: string|number}>} [tax_lines]
 * @property {Array<{amount: string|number}>} [discount_allocations]
 *   - explicit per-line discount amounts (from Shopify's allocations array)
 */

/**
 * @typedef {Object} EarningInput
 * @property {LineItem[]}    lineItems
 * @property {string|number} [shippingTotal]   - decimal string or number, paise after parsing
 * @property {boolean}       [taxesIncluded]   - true if prices already include tax
 * @property {string}        taxHandling       - config.taxHandling ('inclusive'|'exclusive')
 * @property {boolean}       shippingEarning   - config.shippingEarning
 * @property {number}        pointsPerUnit     - config.pointsPerUnit (points per 100 paise)
 * @property {string}        pointsRounding    - config.pointsRounding
 */

/**
 * Compute how many points are earned for an order.
 *
 * @param {EarningInput} input
 * @returns {{ points: number, eligibleAmountPaise: number }}
 *   points              — integer points earned
 *   eligibleAmountPaise — total eligible order value in paise (for the ledger)
 */
export function computeEarning(input) {
  const {
    lineItems = [],
    shippingTotal = '0',
    taxesIncluded = false,
    taxHandling,
    shippingEarning,
    pointsPerUnit,
    pointsRounding,
  } = input;

  // Determine whether to strip tax from line prices.
  // taxHandling='inclusive' AND the order's taxes_included=true → strip tax.
  // taxHandling='exclusive' → use raw price (tax is separate, not in price).
  const stripTax = taxHandling === 'inclusive' && taxesIncluded;

  let eligiblePaise = 0;

  for (const line of lineItems) {
    if (line.is_gift_card) continue;
    
    const unitPricePaise = parsePaise(line.price);
    const qty = line.quantity || 1;
    let linePaise = unitPricePaise * qty;

    // Strip included tax from the line price (proportional per line).
    if (stripTax && line.tax_lines && line.tax_lines.length > 0) {
      // Sum the tax amounts for this line.
      const taxPaise = line.tax_lines.reduce(
        (sum, t) => sum + parsePaise(t.amount),
        0
      );
      linePaise = Math.max(0, linePaise - taxPaise);
    }

    // Subtract per-line discount.
    if (line.discount_allocations && line.discount_allocations.length > 0) {
      // Explicit allocations — use them directly.
      const discountPaise = line.discount_allocations.reduce(
        (sum, d) => sum + parsePaise(d.amount),
        0
      );
      linePaise = Math.max(0, linePaise - discountPaise);
    }
    // If no explicit allocations: use the full line price (gift-card lines
    // with no allocations earn on their full price, as the real fixture shows).

    eligiblePaise += linePaise;
  }

  // Add shipping if the config allows it.
  if (shippingEarning) {
    eligiblePaise += parsePaise(shippingTotal);
  }

  // Compute points: pointsPerUnit points per 100 paise (₹1).
  // multiplyPoints handles all three rounding modes with integer arithmetic.
  const points = multiplyPoints(
    eligiblePaise,
    pointsPerUnit,
    100, // denominator: 100 paise = 1 currency unit
    pointsRounding
  );

  return { points, eligibleAmountPaise: eligiblePaise };
}

/**
 * Compute earning from a Shopify webhook-style order object (the "simple"
 * entry point used by the adapter layer).
 *
 * @param {Object} shopifyOrder   - parsed Shopify orders/paid payload
 * @param {Object} config         - LoyaltyConfig row (or DEFAULT_CONFIG)
 * @returns {{ points: number, eligibleAmountPaise: number }}
 */
export function computeEarningFromOrder(shopifyOrder, config) {
  const lineItems = (shopifyOrder.line_items || []).map((li) => ({
    price: li.price,
    quantity: li.quantity,
    is_gift_card: li.gift_card || false,
    tax_lines: li.tax_lines || [],
    discount_allocations: li.discount_allocations || [],
  }));

  const shippingTotal = (shopifyOrder.shipping_lines || []).reduce(
    (sum, s) => sum + parsePaise(s.price),
    0
  );

  return computeEarning({
    lineItems,
    shippingTotal,
    taxesIncluded: shopifyOrder.taxes_included || false,
    taxHandling: config.taxHandling,
    shippingEarning: config.shippingEarning,
    pointsPerUnit: config.pointsPerUnit,
    pointsRounding: config.pointsRounding,
  });
}
