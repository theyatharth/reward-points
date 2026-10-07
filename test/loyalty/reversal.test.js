// test/loyalty/reversal.test.js
// Unit tests for web/loyalty/rules/reversal.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReversal, computeCancellation } from '../../web/loyalty/rules/reversal.js';

// ---------------------------------------------------------------------------
// Single full refund
// ---------------------------------------------------------------------------
test('full refund: reverses all points', () => {
  const { pointsToReverse, cumulativeTarget } = computeReversal({
    pointsEarned: 629,
    eligibleAmountPaise: 62995,
    totalRefundedPaise: 62995,
    alreadyReversed: 0,
    isFinalRefund: true,
  });
  assert.strictEqual(pointsToReverse, 629);
  assert.strictEqual(cumulativeTarget, 629);
});

// ---------------------------------------------------------------------------
// Partial refund
// ---------------------------------------------------------------------------
test('50% refund: reverses ~half the points (round)', () => {
  // 629 pts, refund ₹315 out of ₹630 eligible
  // round(629 × 31500 / 63000) = round(314.5) = 315
  const { pointsToReverse } = computeReversal({
    pointsEarned: 629,
    eligibleAmountPaise: 63000,
    totalRefundedPaise: 31500,
    alreadyReversed: 0,
  });
  assert.ok(pointsToReverse > 0);
  assert.ok(pointsToReverse <= 315);
});

// ---------------------------------------------------------------------------
// Multiple partial refunds: no double-counting
// ---------------------------------------------------------------------------
test('two partial refunds sum to total', () => {
  // First refund: 30% of ₹10000 eligible = ₹3000
  const first = computeReversal({
    pointsEarned: 100,
    eligibleAmountPaise: 10000,
    totalRefundedPaise: 3000,
    alreadyReversed: 0,
  });

  // Second refund: remaining 70% = ₹7000 (final). The parameter is the CUMULATIVE
  // total refunded so far (3000 + 7000), not this refund's own amount.
  const second = computeReversal({
    pointsEarned: 100,
    eligibleAmountPaise: 10000,
    totalRefundedPaise: 10000,
    alreadyReversed: first.pointsToReverse,
    isFinalRefund: true,
  });

  assert.strictEqual(first.pointsToReverse + second.pointsToReverse, 100);
});

test('three partial refunds: total equals pointsEarned exactly', () => {
  const earned = 97; // prime to stress rounding
  const total = 9700;
  const chunk = Math.floor(total / 3); // 3233 each, 1 leftover

  // Running cumulative totals: chunk, 2 × chunk, then everything.
  const r1 = computeReversal({ pointsEarned: earned, eligibleAmountPaise: total, totalRefundedPaise: chunk, alreadyReversed: 0 });
  const r2 = computeReversal({ pointsEarned: earned, eligibleAmountPaise: total, totalRefundedPaise: chunk * 2, alreadyReversed: r1.cumulativeTarget });
  const r3 = computeReversal({ pointsEarned: earned, eligibleAmountPaise: total, totalRefundedPaise: total, alreadyReversed: r2.cumulativeTarget, isFinalRefund: true });

  assert.strictEqual(r1.pointsToReverse + r2.pointsToReverse + r3.pointsToReverse, earned);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
test('zero points earned → 0 reversed', () => {
  const { pointsToReverse } = computeReversal({
    pointsEarned: 0,
    eligibleAmountPaise: 10000,
    totalRefundedPaise: 5000,
    alreadyReversed: 0,
  });
  assert.strictEqual(pointsToReverse, 0);
});

test('zero refund amount → 0 reversed', () => {
  const { pointsToReverse } = computeReversal({
    pointsEarned: 100,
    eligibleAmountPaise: 10000,
    totalRefundedPaise: 0,
    alreadyReversed: 0,
  });
  assert.strictEqual(pointsToReverse, 0);
});

test('already fully reversed → 0 more reversed', () => {
  const { pointsToReverse } = computeReversal({
    pointsEarned: 100,
    eligibleAmountPaise: 10000,
    totalRefundedPaise: 3000,
    alreadyReversed: 100,
  });
  assert.strictEqual(pointsToReverse, 0);
});

// ---------------------------------------------------------------------------
// Parameter validation: a rename must never again fail silently
// ---------------------------------------------------------------------------
const VALID = { pointsEarned: 100, eligibleAmountPaise: 10000, alreadyReversed: 0 };

test('missing totalRefundedPaise throws (e.g. caller still uses the old refundAmountPaise name)', () => {
  assert.throws(
    () => computeReversal({ ...VALID, refundAmountPaise: 5000 }),
    (err) => err instanceof TypeError && /totalRefundedPaise/.test(err.message) && /refundAmountPaise/.test(err.message)
  );
});

test('non-integer totalRefundedPaise throws (undefined, null, NaN, float, string)', () => {
  for (const bad of [undefined, null, NaN, 3000.5, '3000', Infinity]) {
    assert.throws(
      () => computeReversal({ ...VALID, totalRefundedPaise: bad }),
      TypeError,
      `expected a TypeError for ${String(bad)}`
    );
  }
});

test('validation runs even when the early-return cases would apply (zero points earned)', () => {
  assert.throws(() => computeReversal({ ...VALID, pointsEarned: 0 }), TypeError);
});

test('a zero or negative integer totalRefundedPaise is valid and reverses nothing', () => {
  assert.strictEqual(computeReversal({ ...VALID, totalRefundedPaise: 0 }).pointsToReverse, 0);
  assert.strictEqual(computeReversal({ ...VALID, totalRefundedPaise: -100 }).pointsToReverse, 0);
});

// ---------------------------------------------------------------------------
// computeCancellation
// ---------------------------------------------------------------------------
test('cancellation: reverses all unreversed points', () => {
  const { pointsToReverse, cumulativeTarget } = computeCancellation({
    pointsEarned: 629,
    alreadyReversed: 0,
  });
  assert.strictEqual(pointsToReverse, 629);
  assert.strictEqual(cumulativeTarget, 629);
});

test('cancellation after partial refund: only reverses remaining', () => {
  const { pointsToReverse } = computeCancellation({
    pointsEarned: 100,
    alreadyReversed: 30,
  });
  assert.strictEqual(pointsToReverse, 70);
});

test('cancellation of already-fully-reversed order: 0 reversed', () => {
  const { pointsToReverse } = computeCancellation({
    pointsEarned: 100,
    alreadyReversed: 100,
  });
  assert.strictEqual(pointsToReverse, 0);
});
