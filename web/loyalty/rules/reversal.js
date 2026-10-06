// web/loyalty/rules/reversal.js
//
// T1.6: Points reversal calculation for refunds and cancellations.
//
// Computes how many points to reverse when a refund event arrives.
//
// The formula (from spec):
//
//   For each refund event:
//     cumulativeTarget = round(pointsEarned × totalRefundedPaise ÷ eligibleAmountPaise)
//     entrySize        = cumulativeTarget − alreadyReversed
//
//   On the final refund of an order (totalRefundedPaise = eligibleAmountPaise):
//     entrySize = pointsEarned − alreadyReversed  (exact, no rounding error)
//
// Key points:
//   • "round" rounding mode for the cumulative target (half-up).
//   • Per-refund entry size = target minus what has already been reversed.
//   • This eliminates rounding error accumulation across multiple partial refunds.
//   • A full cancellation is treated the same as a full refund of the entire
//     eligible amount.
//
// No database, no Shopify, no clock — pure functions only.

/**
 * Compute how many points to reverse for one refund event.
 *
 * @param {Object} params
 * @param {number} params.pointsEarned      - total points originally earned for the order
 * @param {number} params.eligibleAmountPaise - total eligible order value in paise (from LoyaltyOrder)
 * @param {number} params.totalRefundedPaise  - cumulative total refunded in paise (including this refund)
 * @param {number} params.alreadyReversed   - points already reversed by earlier refunds on this order
 * @param {boolean} [params.isFinalRefund]  - true when totalRefundedPaise covers the full remaining amount
 *                                            (used to force exact reversal and avoid rounding drift)
 * @returns {{ pointsToReverse: number, cumulativeTarget: number }}
 *   pointsToReverse  — points to reverse in this refund entry (>= 0)
 *   cumulativeTarget — running total target after this refund
 */
export function computeReversal({
  pointsEarned,
  eligibleAmountPaise,
  totalRefundedPaise,
  alreadyReversed,
  isFinalRefund = false,
}) {
  if (pointsEarned <= 0) return { pointsToReverse: 0, cumulativeTarget: alreadyReversed };
  if (eligibleAmountPaise <= 0) return { pointsToReverse: 0, cumulativeTarget: alreadyReversed };
  if (totalRefundedPaise <= 0) return { pointsToReverse: 0, cumulativeTarget: alreadyReversed };

  let cumulativeTarget;

  if (isFinalRefund) {
    // Exact total: avoid any rounding drift on the last refund.
    cumulativeTarget = pointsEarned;
  } else {
    // round(pointsEarned × totalRefundedPaise / eligibleAmountPaise)
    // Integer arithmetic: multiply up by 100, divide, then round half-up.
    const product = pointsEarned * totalRefundedPaise * 100;
    const quotient100 = Math.floor(product / eligibleAmountPaise);
    const fraction = quotient100 % 100;
    cumulativeTarget = Math.floor(quotient100 / 100) + (fraction >= 50 ? 1 : 0);

    // Never exceed total earned (can happen with rounding on partial refunds)
    cumulativeTarget = Math.min(cumulativeTarget, pointsEarned);
  }

  const pointsToReverse = Math.max(0, cumulativeTarget - alreadyReversed);

  return { pointsToReverse, cumulativeTarget };
}

/**
 * Compute the reversal for a full order cancellation.
 * Reverses all remaining unreversed points.
 *
 * @param {Object} params
 * @param {number} params.pointsEarned    - total points originally earned
 * @param {number} params.alreadyReversed - points already reversed (e.g. by prior partial refunds)
 * @returns {{ pointsToReverse: number, cumulativeTarget: number }}
 */
export function computeCancellation({ pointsEarned, alreadyReversed }) {
  const pointsToReverse = Math.max(0, pointsEarned - alreadyReversed);
  return { pointsToReverse, cumulativeTarget: pointsEarned };
}
