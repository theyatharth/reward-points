// test/helpers/ids.js
//
// Ids for tests that write to a persistent database.
//
// LedgerEntry.dedupeKey ("earn:<orderId>", "refund:<refundId>", ...) is unique
// across ALL shops and ledger rows can never be deleted, and
// WebhookEvent.shopifyWebhookId de-duplicates deliveries. A hard-coded or
// small-range random id therefore works once and then collides on the next run
// against the same database: either a "Duplicate" skip, or (worse) a webhook id
// that silently returns the OLD event so the test asserts nothing. Every id a
// test writes should come from here.

// 2025-01-01T00:00:00Z. Keeps the numeric id small enough for a safe integer.
const EPOCH_MS = 1735689600000;
const SLOT_BITS = 14; // 16,384 ids per millisecond per process
const SLOTS = 2 ** SLOT_BITS;

let counter = Math.floor(Math.random() * SLOTS); // random start: two processes in one ms rarely collide

/**
 * A number unique across runs and across calls: milliseconds since 2025 in the
 * high bits, a per-process counter (random start) in the low 14 bits.
 * Always a safe integer (valid until about 2042), so it behaves like a Shopify
 * numeric id: it survives JSON, String(), Number() and parseInt() unchanged.
 */
export function uniqueId() {
  counter = (counter + 1) % SLOTS;
  const id = (Date.now() - EPOCH_MS) * SLOTS + counter;
  if (!Number.isSafeInteger(id)) throw new Error('[test ids] uniqueId overflowed the safe-integer range');
  return id;
}

/** A string id for webhook ids and idempotency keys, e.g. uniqueKey('wh') -> "wh_58834...". */
export function uniqueKey(prefix = 'id') {
  return `${prefix}_${uniqueId()}`;
}
