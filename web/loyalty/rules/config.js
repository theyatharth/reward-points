// web/loyalty/rules/config.js
//
// T1.4: Loyalty program configuration — defaults, validation, Phase 1
// restrictions, and a flatten-and-diff helper for audit records.
//
// No database, no Shopify, no clock — pure functions only.

/**
 * Phase 1 default configuration values.
 * These match the client's prototype defaults and the live settings
 * (spend 100, earn 100 points, redeem 100 pts for ₹10) seeded at M5.
 */
/**
 * The longest holding period. Shopify gives an app holding only `read_orders` the last 60 days of orders, and when a hold ends the
 * worker reads that order from Shopify (the J3 refund check in ledger.js activatePendingLot) and will not unlock without it. A hold
 * of N days means the order is N days plus a little old at that moment, so N = 60 would already be outside the window. 55 leaves
 * five days of room for a late webhook or a retried job. Web docs say 60 days; the installed @shopify packages say nothing either way.
 */
export const MAX_HOLD_DAYS = 55;

export const DEFAULT_CONFIG = {
  earnMode: 'per_currency_unit',  // 'per_currency_unit' | 'fixed_per_order'
  spendAmountPaise: 100,          // spend this much (paise: 100 = ₹1) ...
  pointsPerUnit: 1,               // ... to earn this many points (default 1 point per ₹1)
  // 'inclusive' means "the order's prices include tax, so STRIP the included
  // tax before earning" (₹419 with 5% GST included earns 399). 'exclusive'
  // means use the raw line price. The names are historical; values are not renamed.
  taxHandling: 'exclusive',       // 'inclusive' | 'exclusive'
  shippingEarning: false,
  pointsRounding: 'floor',        // 'floor' | 'round' | 'block'
  earnBasis: 'after_discount',    // 'after_discount' | 'before_discount'
  excludeGiftCards: true,         // gift-card lines earn nothing
  excludedCollectionIds: [],      // Shopify collection ids whose products earn nothing

  pointsPerReward: 100,           // 100 points = 1 reward
  rewardValue: 1000,              // 1 reward = ₹10 (1000 paise)
  rewardExpiryDays: 90,           // discount code expires after 90 days

  holdPeriodDays: 30,             // 30-day hold before points are spendable

  restoreRewardOnFullRefund: true,   // J2: return a reward's points when its order is cancelled / fully refunded
  returnPointsOnCodeExpiry: false,   // J2: return a reward's points when its unused code expires

  shortfallPolicy: 'owe_only',    // Phase 1 only: owed balance stays until paid

  // Phase 1 restrictions — these cannot be changed via the admin UI:
  campaignEnabled: false,
  expiryEnabled: false,           // reward expiry is for discount codes only

  currency: 'INR',
  ledgerStartAt: null,            // set at M5 cutover
};

/**
 * The M5 seed profile (plan section 9, "Config to seed"): what a new shop starts with. Anything not listed
 * comes from DEFAULT_CONFIG. Used by scripts/seed-config.mjs and scripts/onboard-shop.mjs.
 * 'inclusive' = strip the tax included in prices; spend 100.00 earns 100 points; 100 points = 10.00.
 */
export const SEED_PROFILE = {
  spendAmountPaise: 10000,
  pointsPerUnit: 100,
  earnBasis: 'after_discount',
  excludeGiftCards: true,
  taxHandling: 'inclusive',
  restoreRewardOnFullRefund: true,
  returnPointsOnCodeExpiry: false,
};

// ---------------------------------------------------------------------------
// Phase 1 restrictions: these fields cannot be changed even if supplied.
// ---------------------------------------------------------------------------
const PHASE1_LOCKED = {
  campaignEnabled: false,
  expiryEnabled: false,
  shortfallPolicy: 'owe_only',
};

const VALID_EARN_MODES    = ['per_currency_unit', 'fixed_per_order'];
const VALID_TAX_HANDLING  = ['inclusive', 'exclusive'];
const VALID_ROUNDING      = ['floor', 'round', 'block'];
const VALID_SHORTFALL     = ['owe_only'];
const VALID_EARN_BASIS    = ['after_discount', 'before_discount'];
const MAX_EXCLUDED_COLLECTIONS = 250;

/**
 * Validate and normalise an incoming config change object.
 *
 * Throws a descriptive Error for any invalid value.
 * Silently enforces Phase 1 locked fields (they are not user-changeable).
 *
 * @param {Partial<typeof DEFAULT_CONFIG>} incoming
 * @param {typeof DEFAULT_CONFIG} [current] - existing config (defaults to DEFAULT_CONFIG)
 * @returns {typeof DEFAULT_CONFIG} normalised, fully-populated config
 */
export function validateConfig(incoming, current = DEFAULT_CONFIG) {
  const merged = { ...current, ...incoming };

  // Enforce Phase 1 locked values regardless of what was supplied.
  Object.assign(merged, PHASE1_LOCKED);

  // earnMode
  if (!VALID_EARN_MODES.includes(merged.earnMode)) {
    throw new Error(`[config] earnMode must be one of: ${VALID_EARN_MODES.join(', ')} (got "${merged.earnMode}")`);
  }

  // pointsPerUnit: must be a positive integer
  if (!Number.isInteger(merged.pointsPerUnit) || merged.pointsPerUnit < 1) {
    throw new Error(`[config] pointsPerUnit must be a positive integer (got ${merged.pointsPerUnit})`);
  }

  // spendAmountPaise: positive integer paise
  if (!Number.isInteger(merged.spendAmountPaise) || merged.spendAmountPaise < 1) {
    throw new Error(`[config] spendAmountPaise must be a positive integer (paise) (got ${merged.spendAmountPaise})`);
  }

  // taxHandling
  if (!VALID_TAX_HANDLING.includes(merged.taxHandling)) {
    throw new Error(`[config] taxHandling must be one of: ${VALID_TAX_HANDLING.join(', ')} (got "${merged.taxHandling}")`);
  }

  // shippingEarning: boolean
  if (typeof merged.shippingEarning !== 'boolean') {
    throw new Error(`[config] shippingEarning must be a boolean (got ${typeof merged.shippingEarning})`);
  }

  // pointsRounding
  if (!VALID_ROUNDING.includes(merged.pointsRounding)) {
    throw new Error(`[config] pointsRounding must be one of: ${VALID_ROUNDING.join(', ')} (got "${merged.pointsRounding}")`);
  }

  // earnBasis
  if (!VALID_EARN_BASIS.includes(merged.earnBasis)) {
    throw new Error(`[config] earnBasis must be one of: ${VALID_EARN_BASIS.join(', ')} (got "${merged.earnBasis}")`);
  }

  // excludeGiftCards, restoreRewardOnFullRefund, returnPointsOnCodeExpiry: booleans
  for (const key of ['excludeGiftCards', 'restoreRewardOnFullRefund', 'returnPointsOnCodeExpiry']) {
    if (typeof merged[key] !== 'boolean') {
      throw new Error(`[config] ${key} must be a boolean (got ${typeof merged[key]})`);
    }
  }

  // excludedCollectionIds: array of non-empty strings (Shopify ids), no duplicates
  if (!Array.isArray(merged.excludedCollectionIds)
      || merged.excludedCollectionIds.length > MAX_EXCLUDED_COLLECTIONS
      || merged.excludedCollectionIds.some((id) => typeof id !== 'string' || id.trim() === '')
      || new Set(merged.excludedCollectionIds).size !== merged.excludedCollectionIds.length) {
    throw new Error(`[config] excludedCollectionIds must be an array of at most ${MAX_EXCLUDED_COLLECTIONS} unique non-empty strings`);
  }

  // pointsPerReward: positive integer
  if (!Number.isInteger(merged.pointsPerReward) || merged.pointsPerReward < 1) {
    throw new Error(`[config] pointsPerReward must be a positive integer (got ${merged.pointsPerReward})`);
  }

  // rewardValue: positive integer paise
  if (!Number.isInteger(merged.rewardValue) || merged.rewardValue < 1) {
    throw new Error(`[config] rewardValue must be a positive integer (paise) (got ${merged.rewardValue})`);
  }

  // rewardExpiryDays: positive integer
  if (!Number.isInteger(merged.rewardExpiryDays) || merged.rewardExpiryDays < 1) {
    throw new Error(`[config] rewardExpiryDays must be a positive integer (got ${merged.rewardExpiryDays})`);
  }

  // holdPeriodDays: non-negative integer, at most MAX_HOLD_DAYS. The cap applies to a value being SET: a row saved earlier with a
  // longer hold can still have its other rules edited.
  if (!Number.isInteger(merged.holdPeriodDays) || merged.holdPeriodDays < 0) {
    throw new Error(`[config] holdPeriodDays must be a non-negative integer (got ${merged.holdPeriodDays})`);
  }
  if (merged.holdPeriodDays > MAX_HOLD_DAYS && (incoming === undefined || Object.hasOwn(incoming, 'holdPeriodDays'))) {
    throw new Error(`[config] holdPeriodDays cannot be more than ${MAX_HOLD_DAYS} (got ${merged.holdPeriodDays})`);
  }

  // shortfallPolicy (Phase 1: always owe_only — locked above, validated for completeness)
  if (!VALID_SHORTFALL.includes(merged.shortfallPolicy)) {
    throw new Error(`[config] shortfallPolicy must be one of: ${VALID_SHORTFALL.join(', ')} (got "${merged.shortfallPolicy}")`);
  }

  // ledgerStartAt: Date, null, or ISO string
  if (merged.ledgerStartAt !== null && merged.ledgerStartAt !== undefined) {
    const d = merged.ledgerStartAt instanceof Date
      ? merged.ledgerStartAt
      : new Date(merged.ledgerStartAt);
    if (isNaN(d.getTime())) {
      throw new Error(`[config] ledgerStartAt must be a valid date (got "${merged.ledgerStartAt}")`);
    }
    merged.ledgerStartAt = d;
  } else {
    merged.ledgerStartAt = null;
  }

  // currency: non-empty string
  if (typeof merged.currency !== 'string' || merged.currency.trim() === '') {
    throw new Error(`[config] currency must be a non-empty string (got "${merged.currency}")`);
  }

  return merged;
}

/**
 * Flatten a config object to a map of key → value pairs, then diff two
 * flattened configs and return an array of per-key audit records.
 *
 * Each audit record is:
 *   { key: string, oldValue: any, newValue: any }
 *
 * Only changed keys are included.
 *
 * @param {typeof DEFAULT_CONFIG} oldConfig
 * @param {typeof DEFAULT_CONFIG} newConfig
 * @returns {Array<{ key: string, oldValue: any, newValue: any }>}
 */
export function diffConfig(oldConfig, newConfig) {
  const changes = [];
  const allKeys = new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)]);

  for (const key of allKeys) {
    const oldVal = oldConfig[key];
    const newVal = newConfig[key];

    // Compare by value (handle Date objects and primitives)
    const str = (v) => (v instanceof Date ? v.toISOString() : Array.isArray(v) ? JSON.stringify(v) : String(v));
    const oldStr = str(oldVal);
    const newStr = str(newVal);

    if (oldStr !== newStr) {
      changes.push({ key, oldValue: oldVal, newValue: newVal });
    }
  }

  return changes;
}
