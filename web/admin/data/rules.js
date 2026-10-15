// web/admin/data/rules.js: the Rules view and its editing.
//
//   GET  /admin/api/rules          the shop's LoyaltyConfig, field by field, plus the limits the form uses
//   POST /admin/api/rules/preview  validate a change and show the diff and warnings; writes nothing
//   POST /admin/api/rules          validate and save it: one transaction that locks the config row, writes the
//                                  change and one AuditLog row ("rules_changed", previous and new value per field)
//
// Only the fields in FIELDS are editable. Everything else (currency, excluded collections, shortfall policy,
// campaign and expiry flags, ledgerStartAt) is refused by name, so a request can never reach it. A save carries
// `expected` (the updatedAt the form was loaded with): if someone else changed the rules since, it is refused
// instead of silently overwriting. Changing a rule affects NEW orders and NEW redemptions only; nothing already
// in the ledger or in a customer's hands is rewritten.

import { prisma } from '../../lib/prisma.js';
import { validateConfig } from '../../loyalty/rules/config.js';
import { decimal, iso } from './util.js';

const ENUMS = {
  rounding: ['floor', 'round', 'block'],
  basis: ['after_discount', 'before_discount'],
  taxHandling: ['inclusive', 'exclusive'],
};
const MAX_PAISE = 100_000_000; // 1,000,000.00 in the shop's currency

/** The editable fields. kind: money (decimal string in, paise stored) | int | enum | bool. */
export const FIELDS = {
  spend: { db: 'spendAmountPaise', kind: 'money', min: 1, max: MAX_PAISE, label: 'Spend' },
  points: { db: 'pointsPerUnit', kind: 'int', min: 1, max: 1_000_000, label: 'Points earned' },
  rounding: { db: 'pointsRounding', kind: 'enum', values: ENUMS.rounding, label: 'Rounding' },
  basis: { db: 'earnBasis', kind: 'enum', values: ENUMS.basis, label: 'Calculated on' },
  taxHandling: { db: 'taxHandling', kind: 'enum', values: ENUMS.taxHandling, label: 'Tax' },
  includeShipping: { db: 'shippingEarning', kind: 'bool', label: 'Shipping earns points' },
  excludeGiftCards: { db: 'excludeGiftCards', kind: 'bool', label: 'Gift cards are excluded' },
  pointsPerReward: { db: 'pointsPerReward', kind: 'int', min: 1, max: 1_000_000, label: 'Points per reward' },
  rewardValue: { db: 'rewardValue', kind: 'money', min: 1, max: MAX_PAISE, label: 'Reward value' },
  holdPeriodDays: { db: 'holdPeriodDays', kind: 'int', min: 0, max: 365, label: 'Holding period (days)' },
  codeValidDays: { db: 'rewardExpiryDays', kind: 'int', min: 1, max: 365, label: 'Reward code valid (days)' },
  returnPointsOnCodeExpiry: { db: 'returnPointsOnCodeExpiry', kind: 'bool', label: 'Return points when an unused code expires' },
  restoreRewardOnFullRefund: { db: 'restoreRewardOnFullRefund', kind: 'bool', label: 'Return reward points when its order is fully refunded or cancelled' },
};

/** What the form needs to validate before it asks the server. */
export const LIMITS = Object.fromEntries(Object.entries(FIELDS).filter(([, f]) => f.kind === 'int' || f.kind === 'money').map(([k, f]) => [k, { min: f.kind === 'money' ? decimal(f.min) : f.min, max: f.kind === 'money' ? decimal(f.max) : f.max }]));

const bad = (field, message) => ({ ok: false, status: 400, body: { ok: false, error: 'INVALID_RULE', field, message } });

/** A stored value in the form the API shows: money as a decimal string, the rest as is. */
const shown = (key, config) => (FIELDS[key].kind === 'money' ? decimal(config[FIELDS[key].db]) : config[FIELDS[key].db]);

/** "12" or "12.5" or "12.50" -> paise; anything else -> null. */
const moneyToPaise = (value) => {
  if (typeof value !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, frac = ''] = value.trim().split('.');
  return Number(whole) * 100 + Number(`${frac}00`.slice(0, 2));
};

/**
 * Pure: validates `changes` against the current config row and works out the diff.
 * @returns {{ ok: false, status: number, body: object } | { ok: true, incoming: object, changes: Array, warnings: string[], notes: string[], next: object }}
 */
export function planChange(config, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return bad('changes', 'Send the fields to change as an object.');
  const incoming = {};
  for (const [key, value] of Object.entries(changes)) {
    const f = Object.hasOwn(FIELDS, key) ? FIELDS[key] : null;
    if (!f) return { ok: false, status: 400, body: { ok: false, error: 'UNKNOWN_FIELD', field: /^[A-Za-z]{1,40}$/.test(key) ? key : '?', message: 'That field cannot be changed here.' } };
    if (f.kind === 'money') {
      const paise = moneyToPaise(value);
      if (paise === null) return bad(key, `${f.label}: enter an amount such as 100 or 100.50.`);
      if (paise < f.min || paise > f.max) return bad(key, `${f.label}: between ${decimal(f.min)} and ${decimal(f.max)}.`);
      incoming[f.db] = paise;
    } else if (f.kind === 'int') {
      if (!Number.isInteger(value)) return bad(key, `${f.label}: a whole number.`);
      if (value < f.min || value > f.max) return bad(key, `${f.label}: between ${f.min} and ${f.max}.`);
      incoming[f.db] = value;
    } else if (f.kind === 'enum') {
      if (typeof value !== 'string' || !f.values.includes(value)) return bad(key, `${f.label}: choose one of the listed options.`);
      incoming[f.db] = value;
    } else {
      if (typeof value !== 'boolean') return bad(key, `${f.label}: yes or no.`);
      incoming[f.db] = value;
    }
  }

  // The shared rule validator is the backstop (it also guards the seed script).
  let next;
  try {
    next = validateConfig(incoming, config);
  } catch (err) {
    return bad('rules', String(err.message).replace(/^\[config\]\s*/, ''));
  }

  const diff = [];
  for (const [key, f] of Object.entries(FIELDS)) {
    if (!Object.hasOwn(incoming, f.db)) continue;
    const previous = shown(key, config);
    const value = shown(key, next);
    if (previous !== value) diff.push({ field: key, label: f.label, previous, next: value });
  }

  const warnings = [];
  const notes = [];
  const spend = next.spendAmountPaise / 100;
  const backPct = ((next.pointsPerUnit / spend) * (next.rewardValue / 100 / next.pointsPerReward)) * 100;
  if (diff.length > 0 && backPct > 25) warnings.push(`These rules give customers back about ${Math.round(backPct)}% of what they spend as rewards.`);
  if (diff.some((c) => c.field === 'holdPeriodDays') && next.holdPeriodDays === 0) notes.push('With no holding period, points can be spent as soon as the worker activates them (within a minute). A refund after the customer has spent them leaves an owed balance.');
  if (diff.length > 0) notes.push('Changes apply to new orders and new redemptions. Points already earned, codes already issued and the ledger are not rewritten.');
  return { ok: true, incoming, changes: diff, warnings, notes, next };
}

/** The rules view. */
export async function rules(shop) {
  const c = await prisma.loyaltyConfig.findUnique({ where: { shop } });
  if (!c) return { configured: false };
  return {
    configured: true,
    earn: {
      spend: decimal(c.spendAmountPaise),
      points: c.pointsPerUnit,
      rounding: c.pointsRounding,
      basis: c.earnBasis,
      taxHandling: c.taxHandling,
      includeShipping: c.shippingEarning,
      excludeGiftCards: c.excludeGiftCards,
      excludedCollectionIds: c.excludedCollectionIds.map(String).slice(0, 100),
    },
    redeem: {
      pointsPerReward: c.pointsPerReward,
      rewardValue: decimal(c.rewardValue),
      currency: c.currency,
      codeValidDays: c.rewardExpiryDays,
      holdPeriodDays: c.holdPeriodDays,
    },
    returns: {
      shortfallPolicy: c.shortfallPolicy,
      restoreRewardOnFullRefund: c.restoreRewardOnFullRefund,
      returnPointsOnCodeExpiry: c.returnPointsOnCodeExpiry,
    },
    program: { campaignEnabled: c.campaignEnabled, expiryEnabled: c.expiryEnabled, ledgerStartAt: iso(c.ledgerStartAt), updatedAt: iso(c.updatedAt) },
    limits: LIMITS,
    options: ENUMS,
  };
}

/** Validates a requested change and shows what it would do. Writes nothing. */
export async function previewRules({ shop, body }) {
  const config = await prisma.loyaltyConfig.findUnique({ where: { shop } });
  if (!config) return { status: 404, body: { ok: false, error: 'NOT_CONFIGURED' } };
  const plan = planChange(config, body?.changes);
  if (!plan.ok) return { status: plan.status, body: plan.body };
  return { status: 200, body: { ok: true, changes: plan.changes, warnings: plan.warnings, notes: plan.notes, expected: iso(config.updatedAt) } };
}

/**
 * Saves a requested change: config row locked, optimistic check on `expected`, the update and its AuditLog row
 * in one transaction. A request that would change nothing is a successful no-op (a repeated save is harmless).
 */
export async function saveRules({ shop, adminId, ip, body }) {
  const expectedMs = new Date(body?.expected).getTime();
  if (!body || typeof body.expected !== 'string' || Number.isNaN(expectedMs)) return bad('expected', 'Reload the page and try again.');

  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "LoyaltyConfig" WHERE shop = ${shop} FOR UPDATE`;
    const config = await tx.loyaltyConfig.findUnique({ where: { shop } });
    if (!config) return { status: 404, body: { ok: false, error: 'NOT_CONFIGURED' } };
    const plan = planChange(config, body.changes);
    if (!plan.ok) return { status: plan.status, body: plan.body };
    if (plan.changes.length === 0) return { status: 200, body: { ok: true, changed: 0, changes: [] } };
    if (config.updatedAt.getTime() !== expectedMs) {
      return { status: 409, body: { ok: false, error: 'STALE_RULES', message: 'The rules were changed by someone else since you opened this page. Reload to see the current rules.' } };
    }
    if (plan.warnings.length > 0 && body.acknowledgeWarnings !== true) {
      return { status: 409, body: { ok: false, error: 'WARNINGS_NOT_ACKNOWLEDGED', warnings: plan.warnings } };
    }
    await tx.loyaltyConfig.update({ where: { shop }, data: plan.incoming });
    await tx.auditLog.create({
      data: {
        shop,
        adminId,
        ip: typeof ip === 'string' ? ip.slice(0, 64) : null,
        action: 'rules_changed',
        detail: { currency: config.currency, changes: plan.changes, warningsAcknowledged: plan.warnings.length > 0 },
      },
    });
    return { status: 200, body: { ok: true, changed: plan.changes.length, changes: plan.changes, warnings: plan.warnings, notes: plan.notes } };
  }, { timeout: 10_000 });
  return outcome;
}
