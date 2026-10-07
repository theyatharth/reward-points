// test/loyalty/differential.test.js
//
// T1.7: Differential test — 10,000 random earning inputs and random refund
// sequences are run through both our implementation and the client's engine.
//
// Earning: zero unexplained mismatches. Float defects in the client engine
// are classified and recorded but do not fail the test.
//
// Refund: INTENDED DIFFERENCE documented:
//   Client engine computes each refund independently as
//     round(pointsEarned × refundAmount / subtotal)
//   Our engine takes the running cumulative total refunded (totalRefundedPaise)
//   and uses a cumulative-target approach, which prevents double-counting
//   and gives the exact total on the final refund. The two approaches can differ
//   by at most N points (1 per refund) — this is intentional.
//   The test fails only if diff > N (unexplained).
//
// Findings written to test/vendor/differential-findings.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { computeEarning } from '../../web/loyalty/rules/earning.js';
import { computeReversal } from '../../web/loyalty/rules/reversal.js';
import { parsePaise } from '../../web/loyalty/rules/money.js';
import { clientEngineEarn } from '../vendor/engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FINDINGS_PATH = join(__dirname, '..', 'vendor', 'differential-findings.json');
const SEED_COUNT = 10_000;
const ROUNDING_MODES = ['floor', 'round', 'block'];

// Seeded PRNG for reproducibility
let _seed = 42;
function rand() {
  _seed = (_seed * 1664525 + 1013904223) & 0xffffffff;
  return ((_seed >>> 0) / 0xffffffff);
}
function randInt(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }
function randDecimal(min, max, dp = 2) { return parseFloat((min + rand() * (max - min)).toFixed(dp)); }

function randomSimpleInput() {
  return {
    subtotal: randDecimal(1, 10000, 2),
    pointsPerUnit: randInt(1, 5),
    roundingMode: ROUNDING_MODES[randInt(0, 2)],
  };
}

function ourEarn({ subtotal, pointsPerUnit, roundingMode }) {
  return computeEarning({
    lineItems: [{ price: subtotal.toFixed(2), quantity: 1, tax_lines: [], discount_allocations: [] }],
    shippingTotal: '0', taxesIncluded: false, taxHandling: 'exclusive',
    shippingEarning: false, pointsPerUnit, pointsRounding: roundingMode,
  }).points;
}

// ---------------------------------------------------------------------------
// Earning differential
// ---------------------------------------------------------------------------
test('differential earning: zero unexplained mismatches across 10,000 inputs', () => {
  const findings = [];
  let floatDefects = 0, unexplained = 0, matched = 0;

  for (let i = 0; i < SEED_COUNT; i++) {
    const input = randomSimpleInput();
    const ours = ourEarn(input);
    const client = clientEngineEarn(input);
    if (ours === client) { matched++; continue; }

    const diff = Math.abs(ours - client);
    const exact = input.subtotal * input.pointsPerUnit;
    const hasFloat = !Number.isInteger(exact * 1e10);
    if (diff === 1 && hasFloat) {
      floatDefects++;
      findings.push({ type: 'FLOAT_DEFECT', input, ours, client });
    } else {
      unexplained++;
      findings.push({ type: 'UNEXPLAINED', input, ours, client });
    }
  }

  mkdirSync(dirname(FINDINGS_PATH), { recursive: true });
  writeFileSync(FINDINGS_PATH, JSON.stringify({
    summary: { total: SEED_COUNT, matched, floatDefects, unexplained },
    intendedDifferences: [
      'Gift card + explicit discount_allocations: our engine uses Shopify allocations (559 pts); client engine uses proportional share (619 pts). Both tested explicitly in earning.test.js.',
      'Refund: client engine rounds per-refund independently; our engine uses cumulative target. Difference ≤ N points for N partial refunds.',
    ],
    findings: findings.slice(0, 200),
  }, null, 2));

  console.log(`[differential-earning] ${matched} matched, ${floatDefects} float defects, ${unexplained} unexplained`);
  assert.strictEqual(unexplained, 0,
    `${unexplained} unexplained earning mismatches. See ${FINDINGS_PATH}`);
});

// ---------------------------------------------------------------------------
// Refund differential
// ---------------------------------------------------------------------------
test('differential refund: zero unexplained mismatches across 10,000 sequences', () => {
  let unexplained = 0, matched = 0, overReversed = 0, finalNotExact = 0;

  for (let i = 0; i < SEED_COUNT; i++) {
    const subtotal = randDecimal(100, 5000, 2);
    const pointsEarned = randInt(10, 500);
    const numRefunds = randInt(1, 4);

    const refundAmounts = [];
    let remaining = subtotal;
    for (let r = 0; r < numRefunds; r++) {
      if (remaining <= 0.01) break;
      const isLast = r === numRefunds - 1;
      const amount = isLast
        ? parseFloat(remaining.toFixed(2))
        : parseFloat(randDecimal(0.5, Math.max(0.5, remaining * 0.8), 2).toFixed(2));
      if (amount <= 0) continue;
      refundAmounts.push(amount);
      remaining = parseFloat((remaining - amount).toFixed(2));
    }
    if (refundAmounts.length === 0) continue;

    // Our engine (cumulative target). The client's amounts are PER refund; ours
    // takes the running CUMULATIVE total refunded (including this refund), in paise.
    let ourReversed = 0;
    let cumulativePaise = 0;
    const eligiblePaise = parsePaise(subtotal.toFixed(2));
    for (let r = 0; r < refundAmounts.length; r++) {
      cumulativePaise += parsePaise(refundAmounts[r].toFixed(2));
      const isLast = r === refundAmounts.length - 1;
      const { pointsToReverse } = computeReversal({
        pointsEarned, eligibleAmountPaise: eligiblePaise,
        totalRefundedPaise: cumulativePaise,
        alreadyReversed: ourReversed,
        isFinalRefund: isLast,
      });
      ourReversed += pointsToReverse;
      // Never reverse more than was earned, at any step.
      if (ourReversed > pointsEarned) overReversed++;
    }
    // The final refund must give the exact total: everything earned, no drift.
    if (ourReversed !== pointsEarned) finalNotExact++;

    // Client engine (independent per-refund — intended different model)
    const clientTotal = Math.min(
      pointsEarned,
      refundAmounts.reduce((s, a) => s + Math.round(pointsEarned * (a / subtotal)), 0)
    );

    // Tolerance: 1 point per partial refund (rounding from their model)
    const diff = Math.abs(ourReversed - clientTotal);
    if (diff <= refundAmounts.length) { matched++; } else { unexplained++; }
  }

  console.log(`[differential-refund] ${matched} within tolerance, ${unexplained} unexplained`);
  assert.strictEqual(overReversed, 0, `${overReversed} sequences reversed more points than were earned`);
  assert.strictEqual(finalNotExact, 0, `${finalNotExact} sequences did not reverse exactly pointsEarned on the final refund`);
  assert.strictEqual(unexplained, 0,
    `${unexplained} unexplained refund mismatches (diff > number of partial refunds)`);
});
