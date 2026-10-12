// web/admin/data/util.js: helpers shared by the admin console's data builders.
// Every builder in this folder returns plain objects made field by field: no database row is passed through.

/** Paise (integer) to a decimal money string: 134991 -> "1349.91". */
export const decimal = (paise) => {
  const n = Math.round(Number(paise) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

export const iso = (date) => (date ? date.toISOString() : null);

/** What `points` points are worth under the shop's rule, in paise (rounded). */
export const pointsValuePaise = (points, rule) => (rule.pointsPerReward > 0 ? Math.round((points * rule.rewardValue) / rule.pointsPerReward) : 0);

export const ruleOf = (config) => ({
  pointsPerReward: config.pointsPerReward,
  rewardValue: config.rewardValue, // paise
  currency: config.currency,
  holdPeriodDays: config.holdPeriodDays,
});

/** ?limit= as an integer between 1 and `max`, default `fallback`. */
export const limitOf = (value, fallback = 25, max = 100) => {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
};

/** A cursor is an opaque row id: 1 to 64 characters of [A-Za-z0-9-]. Anything else is ignored. */
export const cursorOf = (value) => (typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : undefined);
