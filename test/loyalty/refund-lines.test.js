// test/loyalty/refund-lines.test.js
// web/loyalty/rules/refund-lines.js (decision D1): pure, no database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refundEntries, priorQuantities, computeLineReversal, RefundDataError } from '../../web/loyalty/rules/refund-lines.js';

const line = (id, quantity, eligiblePaise, excluded = false) => ({
  shopifyLineItemId: String(id), quantity, eligiblePaise, excluded: excluded, excludedReason: excluded ? 'gift_card' : null,
});

// The numbers of real test order #1019: 2 units of one line, 1349.91 eligible, 1349 points.
const ORDER_1019 = { lines: [line('A', 2, 134991)], pointsEarned: 1349, eligibleAmountPaise: 134991 };

test('refundEntries: line_item_id, falling back to line_item.id; duplicates merged', () => {
  assert.deepStrictEqual(refundEntries({ refund_line_items: [{ line_item_id: 7, quantity: 1 }, { line_item: { id: 8 }, quantity: 2 }, { line_item_id: 7, quantity: 3 }] }),
    [{ shopifyLineItemId: '7', quantity: 4 }, { shopifyLineItemId: '8', quantity: 2 }]);
});

test('refundEntries: none, empty, or money-only gives no entries', () => {
  assert.deepStrictEqual(refundEntries({}), []);
  assert.deepStrictEqual(refundEntries({ refund_line_items: [] }), []);
});

test('refundEntries: malformed entries throw a permanent RefundDataError', () => {
  for (const bad of [
    { refund_line_items: [{ quantity: 1 }] },
    { refund_line_items: [{ line_item_id: 1 }] },
    { refund_line_items: [{ line_item_id: 1, quantity: 1.5 }] },
    { refund_line_items: [{ line_item_id: 1, quantity: -1 }] },
    { refund_line_items: 'x' },
  ]) {
    assert.throws(() => refundEntries(bad), (e) => e instanceof RefundDataError && e.permanent === true);
  }
});

test('#1019: R1 (one unit) reverses 675, R2 (the other unit) reverses 674: 1349 in total', () => {
  const r1 = computeLineReversal({ ...ORDER_1019, entries: [{ shopifyLineItemId: 'A', quantity: 1 }], prior: new Map(), alreadyReversed: 0 });
  assert.strictEqual(r1.pointsToReverse, 675);
  assert.strictEqual(r1.totalRefundedPaise, 67496, '134991 / 2 = 67495.5, rounded half up');
  assert.deepStrictEqual(r1.lineRecords, [{ shopifyLineItemId: 'A', quantity: 1, counted: true, reason: null }]);

  const r2 = computeLineReversal({ ...ORDER_1019, entries: [{ shopifyLineItemId: 'A', quantity: 1 }], prior: priorQuantities([r1.lineRecords]), alreadyReversed: 675 });
  assert.strictEqual(r2.pointsToReverse, 674);
  assert.strictEqual(r1.pointsToReverse + r2.pointsToReverse, 1349);
});

test('a gift-card line reverses 0 and is recorded as not counted; a money-only refund reverses 0', () => {
  const order = { lines: [line('P', 1, 67496), line('G', 1, 0, true)], pointsEarned: 674, eligibleAmountPaise: 67496 };
  const gift = computeLineReversal({ ...order, entries: [{ shopifyLineItemId: 'G', quantity: 1 }], prior: new Map(), alreadyReversed: 0 });
  assert.strictEqual(gift.pointsToReverse, 0);
  assert.deepStrictEqual(gift.lineRecords, [{ shopifyLineItemId: 'G', quantity: 1, counted: false, reason: 'gift_card' }]);
  const money = computeLineReversal({ ...order, entries: [], prior: new Map(), alreadyReversed: 0 });
  assert.strictEqual(money.pointsToReverse, 0);
  assert.deepStrictEqual(money.lineRecords, []);
});

test('a line missing from the snapshot reverses 0', () => {
  const r = computeLineReversal({ ...ORDER_1019, entries: [{ shopifyLineItemId: 'ZZZ', quantity: 1 }], prior: new Map(), alreadyReversed: 0 });
  assert.strictEqual(r.pointsToReverse, 0);
  assert.strictEqual(r.lineRecords[0].counted, false);
  assert.strictEqual(r.lineRecords[0].reason, 'not_in_snapshot');
});

test('refunding every eligible line in full reverses all points exactly, even with shipping in the eligible total', () => {
  // 100.00 of lines plus 7.77 of shipping that earns: eligible 10777 paise, 1 point per 100 paise -> 107 points.
  const order = { lines: [line('L', 1, 10000)], pointsEarned: 107, eligibleAmountPaise: 10777 };
  const r = computeLineReversal({ ...order, entries: [{ shopifyLineItemId: 'L', quantity: 1 }], prior: new Map(), alreadyReversed: 0 });
  assert.strictEqual(r.pointsToReverse, 107);
});

test('a line refunded in two parts is counted cumulatively (3 units: 1 then 2)', () => {
  const order = { lines: [line('L', 3, 29970)], pointsEarned: 299, eligibleAmountPaise: 29970 }; // 99.90 per unit
  const a = computeLineReversal({ ...order, entries: [{ shopifyLineItemId: 'L', quantity: 1 }], prior: new Map(), alreadyReversed: 0 });
  assert.strictEqual(a.pointsToReverse, 100); // round(299 x 9990 / 29970) = round(99.67)
  const b = computeLineReversal({ ...order, entries: [{ shopifyLineItemId: 'L', quantity: 2 }], prior: priorQuantities([a.lineRecords]), alreadyReversed: 100 });
  assert.strictEqual(b.pointsToReverse, 199);
});

test('a refunded quantity above the line quantity throws, in one refund or cumulatively', () => {
  assert.throws(() => computeLineReversal({ ...ORDER_1019, entries: [{ shopifyLineItemId: 'A', quantity: 3 }], prior: new Map(), alreadyReversed: 0 }),
    (e) => e instanceof RefundDataError && /above the line quantity/.test(e.message));
  assert.throws(() => computeLineReversal({ ...ORDER_1019, entries: [{ shopifyLineItemId: 'A', quantity: 2 }], prior: new Map([['A', 1]]), alreadyReversed: 0 }),
    RefundDataError);
});

test('a refund after the points were all reversed (a cancel came first) reverses 0 more', () => {
  const r = computeLineReversal({ ...ORDER_1019, entries: [{ shopifyLineItemId: 'A', quantity: 2 }], prior: new Map(), alreadyReversed: 1349 });
  assert.strictEqual(r.pointsToReverse, 0);
});

test('an order whose only lines are excluded never counts as fully refunded', () => {
  const order = { lines: [line('G', 1, 0, true)], pointsEarned: 0, eligibleAmountPaise: 0 };
  const r = computeLineReversal({ ...order, entries: [{ shopifyLineItemId: 'G', quantity: 1 }], prior: new Map(), alreadyReversed: 0 });
  assert.strictEqual(r.pointsToReverse, 0);
});

test('lines without an id in the snapshot can never be matched', () => {
  const order = { lines: [{ shopifyLineItemId: null, quantity: 1, eligiblePaise: 10000, excluded: false, excludedReason: null }], pointsEarned: 100, eligibleAmountPaise: 10000 };
  const r = computeLineReversal({ ...order, entries: [{ shopifyLineItemId: '1', quantity: 1 }], prior: new Map(), alreadyReversed: 0 });
  assert.strictEqual(r.pointsToReverse, 0);
});

test('allLinesRefunded: every line in full, gift cards included; unknown ids and empty orders never count', async () => {
  const { allLinesRefunded } = await import('../../web/loyalty/rules/refund-lines.js');
  const lines = [line('A', 2, 1000), line('G', 1, 0, true)];
  assert.strictEqual(allLinesRefunded(lines, new Map([['A', 2], ['G', 1]])), true);
  assert.strictEqual(allLinesRefunded(lines, new Map([['A', 2]])), false, 'the gift card line is not refunded');
  assert.strictEqual(allLinesRefunded(lines, new Map([['A', 1], ['G', 1]])), false);
  assert.strictEqual(allLinesRefunded([], new Map()), false);
  assert.strictEqual(allLinesRefunded([{ shopifyLineItemId: null, quantity: 1, eligiblePaise: 1, excluded: false }], new Map()), false);
  // priorQuantities with includeUncounted keeps the gift-card units
  const recs = [{ shopifyLineItemId: 'G', quantity: 1, counted: false, reason: 'gift_card' }];
  assert.strictEqual(priorQuantities([recs]).get('G'), undefined);
  assert.strictEqual(priorQuantities([recs], { includeUncounted: true }).get('G'), 1);
});
