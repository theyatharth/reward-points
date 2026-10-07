// test/loyalty/earning.test.js
// Unit tests for web/loyalty/rules/earning.js
// Tests the client's earning suite + GST test (₹419 earns 399) + the
// gift-card-with-discount fixture figures: 449 with excludeGiftCards on (the
// default) and 559 with it off. test/loyalty/gift-card-fixture.test.js runs the
// same fixture through the webhook pipeline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEarning } from '../../web/loyalty/rules/earning.js';
import { DEFAULT_CONFIG } from '../../web/loyalty/rules/config.js';

// Shorthand: build standard EarningInput from line items
function makeInput(lineItems, overrides = {}) {
  return {
    lineItems,
    shippingTotal: '0',
    taxesIncluded: false,
    taxHandling: DEFAULT_CONFIG.taxHandling,
    shippingEarning: DEFAULT_CONFIG.shippingEarning,
    pointsPerUnit: DEFAULT_CONFIG.pointsPerUnit,
    pointsRounding: DEFAULT_CONFIG.pointsRounding,
    spendAmountPaise: DEFAULT_CONFIG.spendAmountPaise,
    earnBasis: DEFAULT_CONFIG.earnBasis,
    excludeGiftCards: DEFAULT_CONFIG.excludeGiftCards,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic earning
// ---------------------------------------------------------------------------
test('simple order: ₹629.95 earns 629 pts (floor)', () => {
  const input = makeInput([{ price: '629.95', quantity: 1 }]);
  const { points } = computeEarning(input);
  assert.strictEqual(points, 629);
});

test('two items: ₹100 + ₹50 earns 150 pts', () => {
  const input = makeInput([
    { price: '100.00', quantity: 1 },
    { price: '50.00', quantity: 1 },
  ]);
  assert.strictEqual(computeEarning(input).points, 150);
});

test('quantity > 1: ₹100 × 2 earns 200 pts', () => {
  const input = makeInput([{ price: '100.00', quantity: 2 }]);
  assert.strictEqual(computeEarning(input).points, 200);
});

test('zero-value order earns 0 pts', () => {
  const input = makeInput([{ price: '0.00', quantity: 1 }]);
  assert.strictEqual(computeEarning(input).points, 0);
});

// ---------------------------------------------------------------------------
// Rounding modes
// ---------------------------------------------------------------------------
test('floor rounding: ₹1.50 earns 1 pt', () => {
  const input = makeInput([{ price: '1.50', quantity: 1 }], { pointsRounding: 'floor' });
  assert.strictEqual(computeEarning(input).points, 1);
});

test('round rounding: ₹1.50 earns 2 pts (half-up)', () => {
  const input = makeInput([{ price: '1.50', quantity: 1 }], { pointsRounding: 'round' });
  assert.strictEqual(computeEarning(input).points, 2);
});

test('block rounding: ₹1.50 earns 0 pts (not exact)', () => {
  const input = makeInput([{ price: '1.50', quantity: 1 }], { pointsRounding: 'block' });
  assert.strictEqual(computeEarning(input).points, 0);
});

test('block rounding: ₹2.00 earns 2 pts (exact)', () => {
  const input = makeInput([{ price: '2.00', quantity: 1 }], { pointsRounding: 'block' });
  assert.strictEqual(computeEarning(input).points, 2);
});

// ---------------------------------------------------------------------------
// GST test: ₹419 order with taxes_included, 5% tax → earns 399 pts
// ---------------------------------------------------------------------------
test('GST inclusive (₹419 earns 399): taxes subtracted before points', () => {
  // ₹419.00, taxes_included=true, 5% GST on the single line
  // Tax amount = 419 × 5/105 ≈ ₹19.95 → 1995 paise
  // Eligible = 41900 - 1995 = 39905 → floor(39905/100) = 399 pts
  // (The spec says 399, matching the client prototype)
  const input = makeInput(
    [
      {
        price: '419.00',
        quantity: 1,
        tax_lines: [{ rate: 0.05, amount: '19.95' }],
      },
    ],
    { taxesIncluded: true, taxHandling: 'inclusive', pointsRounding: 'floor' }
  );
  const { points } = computeEarning(input);
  assert.strictEqual(points, 399);
});

test('GST exclusive: ₹419 line with tax_lines earns 419 pts (tax ignored)', () => {
  // taxHandling='exclusive' → raw price used, tax not subtracted
  const input = makeInput(
    [
      {
        price: '419.00',
        quantity: 1,
        tax_lines: [{ rate: 0.05, amount: '19.95' }],
      },
    ],
    { taxesIncluded: true, taxHandling: 'exclusive' }
  );
  assert.strictEqual(computeEarning(input).points, 419);
});

// ---------------------------------------------------------------------------
// Discount allocation tests
// ---------------------------------------------------------------------------
test('10% discount applied via discount_allocations', () => {
  // ₹100 line with ₹10 discount → ₹90 eligible → 90 pts
  const input = makeInput([
    {
      price: '100.00',
      quantity: 1,
      discount_allocations: [{ amount: '10.00' }],
    },
  ]);
  assert.strictEqual(computeEarning(input).points, 90);
});

// ---------------------------------------------------------------------------
// Gift card with discount (figures from orders-paid-gift-card-with-discount.json)
//   product line   ₹499.00, discount allocation ₹50.00  -> 44,900 paise
//   gift-card line ₹110.00, NO discount allocation       -> 11,000 paise
// Shopify never allocates a discount to a gift-card line, so the discount only
// reduces the product line. Whether the gift-card line earns at all is the
// excludeGiftCards flag: on (default) -> 449 points, off -> 559 points.
// ---------------------------------------------------------------------------
const GIFT_CARD_ORDER_LINES = [
  { price: '499.00', quantity: 1, discount_allocations: [{ amount: '50.00' }] },
  { price: '110.00', quantity: 1, is_gift_card: true, discount_allocations: [] },
];

test('gift card + discount, excludeGiftCards ON (default): gift-card line earns nothing → 449 pts', () => {
  const { points, eligibleAmountPaise } = computeEarning(makeInput(GIFT_CARD_ORDER_LINES));
  assert.strictEqual(eligibleAmountPaise, 44900);
  assert.strictEqual(points, 449);
});

test('gift card + discount, excludeGiftCards OFF: gift-card line earns its full price, untouched by the discount → 559 pts', () => {
  const { points, eligibleAmountPaise } = computeEarning(
    makeInput(GIFT_CARD_ORDER_LINES, { excludeGiftCards: false })
  );
  assert.strictEqual(eligibleAmountPaise, 55900); // 44,900 product + 11,000 gift card
  assert.strictEqual(points, 559);
});

// No discount_allocations on any line (e.g. an order with no discount): every
// line that is eligible earns on its full price. This is plain arithmetic of
// the fallback path (509 + 110 = 619); it says nothing about the client's
// prototype numbers.
test('no discount_allocations: each eligible line earns on its full price (flag off: 509 + 110 = 619 pts)', () => {
  const lines = [
    { price: '509.00', quantity: 1 },
    { price: '110.00', quantity: 1, is_gift_card: true },
  ];
  assert.strictEqual(computeEarning(makeInput(lines, { excludeGiftCards: false })).points, 619);
  assert.strictEqual(computeEarning(makeInput(lines)).points, 509, 'flag on: the gift-card line is dropped');
});

// ---------------------------------------------------------------------------
// earnBasis and the spend ratio
// ---------------------------------------------------------------------------
test('earnBasis before_discount ignores discount allocations', () => {
  const lines = [{ price: '100.00', quantity: 1, discount_allocations: [{ amount: '10.00' }] }];
  assert.strictEqual(computeEarning(makeInput(lines, { earnBasis: 'after_discount' })).points, 90);
  assert.strictEqual(computeEarning(makeInput(lines, { earnBasis: 'before_discount' })).points, 100);
});

test('spend ratio: spend ₹100 earn 100 points (spendAmountPaise 10000, pointsPerUnit 100): ₹149 earns 149', () => {
  const input = makeInput([{ price: '149.00', quantity: 1 }], { spendAmountPaise: 10000, pointsPerUnit: 100 });
  assert.strictEqual(computeEarning(input).points, 149);
});

test('spend ratio: spend ₹100 earn 1 point: ₹149 earns 1, ₹250 earns 2', () => {
  const at = (price) => computeEarning(makeInput([{ price, quantity: 1 }], { spendAmountPaise: 10000, pointsPerUnit: 1 })).points;
  assert.strictEqual(at('149.00'), 1);
  assert.strictEqual(at('250.00'), 2);
});

test('inputs without the new fields behave as before (defaults: ₹1 spend, after discount, gift cards excluded)', () => {
  const { spendAmountPaise, earnBasis, excludeGiftCards, ...legacy } = makeInput([
    { price: '100.00', quantity: 1, discount_allocations: [{ amount: '10.00' }] },
    { price: '50.00', quantity: 1, is_gift_card: true },
  ]);
  assert.strictEqual(computeEarning(legacy).points, 90);
});

// ---------------------------------------------------------------------------
// Shipping
// ---------------------------------------------------------------------------
test('shipping excluded by default', () => {
  const input = makeInput(
    [{ price: '100.00', quantity: 1 }],
    { shippingTotal: '50.00', shippingEarning: false }
  );
  assert.strictEqual(computeEarning(input).points, 100);
});

test('shipping included when shippingEarning=true', () => {
  const input = makeInput(
    [{ price: '100.00', quantity: 1 }],
    { shippingTotal: '50.00', shippingEarning: true }
  );
  assert.strictEqual(computeEarning(input).points, 150);
});

// ---------------------------------------------------------------------------
// eligibleAmountPaise is returned
// ---------------------------------------------------------------------------
test('eligibleAmountPaise is returned correctly', () => {
  const input = makeInput([{ price: '629.95', quantity: 1 }]);
  const { eligibleAmountPaise } = computeEarning(input);
  assert.strictEqual(eligibleAmountPaise, 62995);
});
