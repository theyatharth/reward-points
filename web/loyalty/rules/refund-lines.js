// web/loyalty/rules/refund-lines.js
//
// Refund reversal by LINE IDENTITY (decision D1). Pure functions: no database,
// no Shopify, no clock.
//
// A refund reverses points only for the order lines it names:
//   * each refund_line_items entry is matched to the order's earn snapshot by
//     line_item_id (fallback line_item.id);
//   * a line that is missing from the snapshot, or excluded (gift card), reverses 0;
//   * otherwise the refunded share of the line's eligible value is
//     eligiblePaise x refundedQty / lineQty, summed cumulatively per line (never
//     above the line quantity), rounded half up to whole paise per line;
//   * the cumulative total goes to computeReversal as totalRefundedPaise, and the
//     refund that completes every eligible line is the final one (exact, no drift);
//   * a money-only refund (no refund_line_items) reverses 0, and order_adjustments
//     are never added.
//
// Anything that cannot be matched without guessing throws a RefundDataError, which
// is permanent: retrying the same payload cannot help, so the event fails visibly.

import { computeReversal } from './reversal.js';

export class RefundDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RefundDataError';
    this.permanent = true;
  }
}

const idOf = (v) => (v === undefined || v === null ? null : String(v));

/**
 * Reads the refunded lines out of a refunds/create payload.
 * Entries naming the same line are merged. An entry with no line id, or a quantity
 * that is not a whole number >= 0, is malformed and throws.
 *
 * @param {Object} payload refunds/create body
 * @returns {Array<{ shopifyLineItemId: string, quantity: number }>}
 */
export function refundEntries(payload) {
  const list = payload.refund_line_items;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new RefundDataError('refund_line_items is not an array');

  const byLine = new Map();
  list.forEach((entry, i) => {
    const id = idOf(entry?.line_item_id ?? entry?.line_item?.id);
    if (id === null) throw new RefundDataError(`refund_line_items[${i}] has neither line_item_id nor line_item.id`);
    const quantity = entry.quantity;
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new RefundDataError(`refund_line_items[${i}].quantity is not a whole number of units`);
    }
    byLine.set(id, (byLine.get(id) || 0) + quantity);
  });
  return [...byLine].map(([shopifyLineItemId, quantity]) => ({ shopifyLineItemId, quantity }));
}

/** Sums the line quantities of earlier refunds (LoyaltyRefund.lines) into a Map of line id -> units. */
export function priorQuantities(refundLineArrays) {
  const sum = new Map();
  for (const lines of refundLineArrays) {
    for (const l of Array.isArray(lines) ? lines : []) {
      if (l.counted === false) continue; // missing from the snapshot or excluded: never used units
      sum.set(l.shopifyLineItemId, (sum.get(l.shopifyLineItemId) || 0) + l.quantity);
    }
  }
  return sum;
}

// round half up of (eligible x units / lineQty), integers only
const shareOfLine = (eligiblePaise, units, lineQty) => Math.floor((2 * eligiblePaise * units + lineQty) / (2 * lineQty));

/**
 * Cumulative eligible paise refunded, and whether every eligible line is now fully refunded.
 * @param {Array} lines   earn snapshot
 * @param {Map<string, number>} cumulative  line id -> units refunded so far (including this refund)
 */
function cumulativeRefunded(lines, cumulative) {
  let totalRefundedPaise = 0;
  let eligibleLines = 0;
  let fullyRefunded = 0;
  for (const line of lines) {
    if (line.excluded || line.eligiblePaise <= 0 || line.shopifyLineItemId === null) continue;
    eligibleLines++;
    const units = cumulative.get(line.shopifyLineItemId) || 0;
    totalRefundedPaise += shareOfLine(line.eligiblePaise, units, line.quantity);
    if (units >= line.quantity) fullyRefunded++;
  }
  return { totalRefundedPaise, allEligibleLinesRefunded: eligibleLines > 0 && fullyRefunded === eligibleLines };
}

/**
 * Points to reverse for one refund.
 *
 * @param {Object} p
 * @param {Array}  p.lines                earn snapshot: { shopifyLineItemId, quantity, eligiblePaise, excluded, excludedReason }
 * @param {Array}  p.entries              refundEntries(payload)
 * @param {Map<string, number>} p.prior   priorQuantities(...) of the order's earlier refunds
 * @param {number} p.pointsEarned
 * @param {number} p.eligibleAmountPaise
 * @param {number} p.alreadyReversed      points reversed so far on the order (refunds and cancel)
 * @returns {{ pointsToReverse: number, totalRefundedPaise: number, deltaRefundedPaise: number,
 *             lineRecords: Array<{ shopifyLineItemId: string, quantity: number, counted: boolean, reason: string|null }> }}
 *   lineRecords is what LoyaltyRefund.lines stores for this refund.
 */
export function computeLineReversal({ lines, entries, prior, pointsEarned, eligibleAmountPaise, alreadyReversed }) {
  const snapshot = new Map(lines.filter((l) => l.shopifyLineItemId !== null).map((l) => [l.shopifyLineItemId, l]));
  const cumulative = new Map(prior);
  const lineRecords = [];

  for (const { shopifyLineItemId, quantity } of entries) {
    const line = snapshot.get(shopifyLineItemId);
    if (!line) {
      lineRecords.push({ shopifyLineItemId, quantity, counted: false, reason: 'not_in_snapshot' });
      continue;
    }
    if (line.excluded) {
      lineRecords.push({ shopifyLineItemId, quantity, counted: false, reason: line.excludedReason || 'excluded' });
      continue;
    }
    const units = (cumulative.get(shopifyLineItemId) || 0) + quantity;
    if (units > line.quantity) {
      throw new RefundDataError(
        `refunded quantity above the line quantity for line ${shopifyLineItemId}: ${units} refunded in total, line quantity ${line.quantity}`
      );
    }
    cumulative.set(shopifyLineItemId, units);
    lineRecords.push({ shopifyLineItemId, quantity, counted: true, reason: null });
  }

  const before = cumulativeRefunded(lines, prior);
  const after = cumulativeRefunded(lines, cumulative);
  const deltaRefundedPaise = after.totalRefundedPaise - before.totalRefundedPaise;

  const { pointsToReverse } = computeReversal({
    pointsEarned,
    eligibleAmountPaise,
    totalRefundedPaise: after.totalRefundedPaise,
    alreadyReversed,
    isFinalRefund: after.allEligibleLinesRefunded,
  });

  return { pointsToReverse, totalRefundedPaise: after.totalRefundedPaise, deltaRefundedPaise, lineRecords };
}
