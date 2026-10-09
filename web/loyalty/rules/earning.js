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
//   • Per-line discount: with earnBasis='after_discount' (default) subtract the
//     explicit discount_allocations amounts for the line; with 'before_discount'
//     ignore them. A line with no allocations earns on its full price. (No
//     proportional redistribution of order-level discounts is implemented: it
//     is never needed, because Shopify's allocations are always explicit.)
//   • Gift-card lines: excluded by default (excludeGiftCards=true), so a gift
//     card purchase earns nothing. Shopify never allocates a discount to a
//     gift-card line (see the gift-card fixture), so with excludeGiftCards=false
//     the line earns on its full price while the discount reduces only the
//     other lines. The flag is what separates the 449-point and 559-point
//     results for that fixture.
//   • Rounding is applied once on the total eligible order value, not per line.
//   • Shipping: included only if config.shippingEarning is true.
//
// No database, no Shopify, no clock.

import { parsePaise, multiplyPoints } from './money.js';

/**
 * @typedef {Object} LineItem
 * @property {string|number} price          - Unit price (decimal string or number)
 * @property {number}        quantity
 * @property {string|number} [id]          - Shopify line item id (kept in the per-line result)
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
 * @property {number}        [spendAmountPaise] - config.spendAmountPaise: pointsPerUnit points are earned per this
 *                                                much spend (default 100 paise = ₹1)
 * @property {string}        [earnBasis]       - 'after_discount' (default) | 'before_discount'
 * @property {boolean}       [excludeGiftCards] - default true
 */

/**
 * Compute how many points are earned for an order.
 *
 * @param {EarningInput} input
 * @returns {{ points: number, eligibleAmountPaise: number, lines: Array<{ shopifyLineItemId: string|null, quantity: number, eligiblePaise: number, excluded: boolean, excludedReason: string|null }> }}
 *   points              — integer points earned
 *   eligibleAmountPaise — total eligible order value in paise (for the ledger)
 *   lines               — the same eligible value split per line (the earn snapshot used by refunds):
 *                         eligiblePaise is the line's WHOLE value (all units); an excluded line is 0.
 *                         Shipping, when it earns, is in eligibleAmountPaise but in no line.
 */
// ---------------------------------------------------------------------------
// Tax-line amount.
//
// VERIFIED by a real capture (test order #1018, test/fixtures/shopify/real/): a tax
// line is { rate, price, title, price_set, channel_liable }. The amount is under
// `price` (a decimal string); there is no `amount` key. We read `price` and keep
// `amount` as a fallback only because the old hand-made fixtures used it.
//
// STILL UNVERIFIED: several tax lines on ONE line item (CGST + SGST: we sum them,
// but Shopify has not been seen sending that) and any non-USD taxed order.
//
// The amount is the tax for the WHOLE line (all quantity), like the line total it
// is subtracted from. Only used when tax stripping is on. An entry with neither a
// parsable `price` nor `amount` THROWS, listing the key names found (never values),
// so the event fails visibly: parsePaise(undefined) is 0, which would otherwise
// silently earn points on the gross price including tax.
// ---------------------------------------------------------------------------
function taxLineAmountPaise(taxLine) {
  if (taxLine === null || typeof taxLine !== 'object' || Array.isArray(taxLine)) {
    throw new Error(`[earning] tax line is not an object (found: ${taxLine === null ? 'null' : Array.isArray(taxLine) ? 'array' : typeof taxLine})`);
  }
  for (const field of ['price', 'amount']) {
    const raw = taxLine[field];
    if (raw === undefined || raw === null || raw === '') continue;
    try {
      return parsePaise(raw);
    } catch {
      // not parsable: try the next field
    }
  }
  throw new Error(
    `[earning] tax line has neither a parsable "price" nor "amount" (keys found: ${Object.keys(taxLine).join(', ') || 'none'})`
  );
}

export function computeEarning(input) {
  const {
    lineItems = [],
    shippingTotal = '0',
    taxesIncluded = false,
    taxHandling,
    shippingEarning,
    pointsPerUnit,
    pointsRounding,
    spendAmountPaise = 100,
    earnBasis = 'after_discount',
    excludeGiftCards = true,
  } = input;

  // Determine whether to strip tax from line prices.
  // taxHandling='inclusive' AND the order's taxes_included=true → strip tax.
  // taxHandling='exclusive' → use raw price (tax is separate, not in price).
  const stripTax = taxHandling === 'inclusive' && taxesIncluded;

  let eligiblePaise = 0;
  const lines = [];

  for (const line of lineItems) {
    const shopifyLineItemId = line.id === undefined || line.id === null ? null : String(line.id);
    const qty = line.quantity || 1;
    if (excludeGiftCards && line.is_gift_card) {
      lines.push({ shopifyLineItemId, quantity: qty, eligiblePaise: 0, excluded: true, excludedReason: 'gift_card' });
      continue;
    }

    const unitPricePaise = parsePaise(line.price);
    let linePaise = unitPricePaise * qty;

    // Strip included tax from the line price (proportional per line).
    if (stripTax && line.tax_lines && line.tax_lines.length > 0) {
      // Sum the tax amounts for this line (price, falling back to amount; see taxLineAmountPaise).
      const taxPaise = line.tax_lines.reduce(
        (sum, t) => sum + taxLineAmountPaise(t),
        0
      );
      linePaise = Math.max(0, linePaise - taxPaise);
    }

    // Subtract per-line discount.
    if (earnBasis === 'after_discount' && line.discount_allocations && line.discount_allocations.length > 0) {
      // Explicit allocations — use them directly.
      const discountPaise = line.discount_allocations.reduce(
        (sum, d) => sum + parsePaise(d.amount),
        0
      );
      linePaise = Math.max(0, linePaise - discountPaise);
    }
    // No allocations (or earnBasis='before_discount'): the line earns on its full price.

    eligiblePaise += linePaise;
    lines.push({ shopifyLineItemId, quantity: qty, eligiblePaise: linePaise, excluded: false, excludedReason: null });
  }

  // Add shipping if the config allows it.
  if (shippingEarning) {
    eligiblePaise += parsePaise(shippingTotal);
  }

  // Compute points: pointsPerUnit points per spendAmountPaise of eligible value.
  // multiplyPoints handles all three rounding modes with integer arithmetic.
  const points = multiplyPoints(
    eligiblePaise,
    pointsPerUnit,
    spendAmountPaise,
    pointsRounding
  );

  return { points, eligibleAmountPaise: eligiblePaise, lines };
}

/**
 * Compute earning from a Shopify webhook-style order object (the "simple"
 * entry point used by the adapter layer).
 *
 * @param {Object} shopifyOrder   - parsed Shopify orders/paid payload
 * @param {Object} config         - LoyaltyConfig row (or DEFAULT_CONFIG)
 * @returns {{ points: number, eligibleAmountPaise: number, lines: Array }} see computeEarning
 */
export function computeEarningFromOrder(shopifyOrder, config) {
  const lineItems = (shopifyOrder.line_items || []).map((li) => ({
    id: li.id,
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
    spendAmountPaise: config.spendAmountPaise ?? 100,
    earnBasis: config.earnBasis ?? 'after_discount',
    excludeGiftCards: config.excludeGiftCards ?? true,
  });
}
