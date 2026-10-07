// test/loyalty/config.test.js
// Unit tests for web/loyalty/rules/config.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfig, diffConfig } from '../../web/loyalty/rules/config.js';

// ---------------------------------------------------------------------------
// validateConfig: valid inputs pass
// ---------------------------------------------------------------------------
test('accepts the default config unchanged', () => {
  assert.doesNotThrow(() => validateConfig(DEFAULT_CONFIG));
});

test('accepts a valid custom config', () => {
  const result = validateConfig({
    earnMode: 'fixed_per_order',
    taxHandling: 'inclusive',
    shippingEarning: true,
    pointsRounding: 'round',
    pointsPerUnit: 5,
    pointsPerReward: 200,
    rewardValue: 2000,
    rewardExpiryDays: 30,
    holdPeriodDays: 7,
    currency: 'INR',
  });
  assert.strictEqual(result.earnMode, 'fixed_per_order');
  assert.strictEqual(result.taxHandling, 'inclusive');
  assert.strictEqual(result.pointsPerUnit, 5);
});

// ---------------------------------------------------------------------------
// validateConfig: Phase 1 locked fields are always overridden
// ---------------------------------------------------------------------------
test('Phase 1: campaignEnabled is always forced to false', () => {
  const result = validateConfig({ campaignEnabled: true });
  assert.strictEqual(result.campaignEnabled, false);
});

test('Phase 1: expiryEnabled is always forced to false', () => {
  const result = validateConfig({ expiryEnabled: true });
  assert.strictEqual(result.expiryEnabled, false);
});

test('Phase 1: shortfallPolicy is always forced to owe_only', () => {
  const result = validateConfig({ shortfallPolicy: 'write_off' });
  assert.strictEqual(result.shortfallPolicy, 'owe_only');
});

// ---------------------------------------------------------------------------
// validateConfig: invalid rule refused
// ---------------------------------------------------------------------------
test('invalid earnMode is refused', () => {
  assert.throws(() => validateConfig({ earnMode: 'magic' }), /earnMode/);
});

test('invalid taxHandling is refused', () => {
  assert.throws(() => validateConfig({ taxHandling: 'vat' }), /taxHandling/);
});

test('invalid pointsRounding is refused', () => {
  assert.throws(() => validateConfig({ pointsRounding: 'ceil' }), /pointsRounding/);
});

test('pointsPerUnit zero is refused', () => {
  assert.throws(() => validateConfig({ pointsPerUnit: 0 }), /pointsPerUnit/);
});

test('pointsPerUnit negative is refused', () => {
  assert.throws(() => validateConfig({ pointsPerUnit: -1 }), /pointsPerUnit/);
});

test('pointsPerReward zero is refused', () => {
  assert.throws(() => validateConfig({ pointsPerReward: 0 }), /pointsPerReward/);
});

test('rewardValue zero is refused', () => {
  assert.throws(() => validateConfig({ rewardValue: 0 }), /rewardValue/);
});

test('holdPeriodDays negative is refused', () => {
  assert.throws(() => validateConfig({ holdPeriodDays: -1 }), /holdPeriodDays/);
});

test('holdPeriodDays zero is allowed', () => {
  assert.doesNotThrow(() => validateConfig({ holdPeriodDays: 0 }));
});

test('invalid ledgerStartAt is refused', () => {
  assert.throws(() => validateConfig({ ledgerStartAt: 'not-a-date' }), /ledgerStartAt/);
});

test('valid ledgerStartAt ISO string is accepted and converted to Date', () => {
  const result = validateConfig({ ledgerStartAt: '2026-10-05T00:00:00Z' });
  assert.ok(result.ledgerStartAt instanceof Date);
});

test('ledgerStartAt null is accepted', () => {
  const result = validateConfig({ ledgerStartAt: null });
  assert.strictEqual(result.ledgerStartAt, null);
});

test('empty currency string is refused', () => {
  assert.throws(() => validateConfig({ currency: '' }), /currency/);
});

// ---------------------------------------------------------------------------
// diffConfig: rule change recorded
// ---------------------------------------------------------------------------
test('diffConfig: no change → empty array', () => {
  const changes = diffConfig(DEFAULT_CONFIG, DEFAULT_CONFIG);
  assert.strictEqual(changes.length, 0);
});

test('diffConfig: changed pointsPerUnit is recorded', () => {
  const newCfg = { ...DEFAULT_CONFIG, pointsPerUnit: 5 };
  const changes = diffConfig(DEFAULT_CONFIG, newCfg);
  const entry = changes.find((c) => c.key === 'pointsPerUnit');
  assert.ok(entry, 'pointsPerUnit change should be in the diff');
  assert.strictEqual(entry.oldValue, 1);
  assert.strictEqual(entry.newValue, 5);
});

test('diffConfig: multiple changed fields all appear', () => {
  const newCfg = { ...DEFAULT_CONFIG, pointsPerUnit: 2, holdPeriodDays: 7 };
  const changes = diffConfig(DEFAULT_CONFIG, newCfg);
  assert.ok(changes.find((c) => c.key === 'pointsPerUnit'));
  assert.ok(changes.find((c) => c.key === 'holdPeriodDays'));
});

test('diffConfig: unchanged fields do not appear', () => {
  const newCfg = { ...DEFAULT_CONFIG, pointsPerUnit: 2 };
  const changes = diffConfig(DEFAULT_CONFIG, newCfg);
  assert.ok(!changes.find((c) => c.key === 'taxHandling'));
});

// ---------------------------------------------------------------------------
// Migration 3 fields: spend ratio, earn basis, gift cards, collections, J2 flags
// ---------------------------------------------------------------------------
test('defaults for the migration-3 fields', () => {
  assert.strictEqual(DEFAULT_CONFIG.spendAmountPaise, 100);
  assert.strictEqual(DEFAULT_CONFIG.earnBasis, 'after_discount');
  assert.strictEqual(DEFAULT_CONFIG.excludeGiftCards, true);
  assert.deepStrictEqual(DEFAULT_CONFIG.excludedCollectionIds, []);
  assert.strictEqual(DEFAULT_CONFIG.restoreRewardOnFullRefund, true);
  assert.strictEqual(DEFAULT_CONFIG.returnPointsOnCodeExpiry, false);
});

test('the M5 seed profile is a valid config', () => {
  const seed = validateConfig({
    spendAmountPaise: 10000, pointsPerUnit: 100, earnBasis: 'after_discount',
    excludeGiftCards: true, taxHandling: 'inclusive',
    restoreRewardOnFullRefund: true, returnPointsOnCodeExpiry: false,
  });
  assert.strictEqual(seed.spendAmountPaise, 10000);
  assert.strictEqual(seed.taxHandling, 'inclusive');
});

test('spendAmountPaise must be a positive integer', () => {
  for (const bad of [0, -100, 1.5, '100', null]) {
    assert.throws(() => validateConfig({ spendAmountPaise: bad }), /spendAmountPaise/, String(bad));
  }
});

test('earnBasis must be after_discount or before_discount', () => {
  assert.doesNotThrow(() => validateConfig({ earnBasis: 'before_discount' }));
  assert.throws(() => validateConfig({ earnBasis: 'proportional' }), /earnBasis/);
});

test('excludeGiftCards, restoreRewardOnFullRefund, returnPointsOnCodeExpiry must be booleans', () => {
  for (const key of ['excludeGiftCards', 'restoreRewardOnFullRefund', 'returnPointsOnCodeExpiry']) {
    assert.throws(() => validateConfig({ [key]: 'yes' }), new RegExp(key));
    assert.throws(() => validateConfig({ [key]: 1 }), new RegExp(key));
  }
});

test('excludedCollectionIds: accepts a list of unique ids, refuses malformed lists', () => {
  assert.deepStrictEqual(validateConfig({ excludedCollectionIds: ['111', '222'] }).excludedCollectionIds, ['111', '222']);
  assert.throws(() => validateConfig({ excludedCollectionIds: 'abc' }), /excludedCollectionIds/);
  assert.throws(() => validateConfig({ excludedCollectionIds: [''] }), /excludedCollectionIds/);
  assert.throws(() => validateConfig({ excludedCollectionIds: [123] }), /excludedCollectionIds/);
  assert.throws(() => validateConfig({ excludedCollectionIds: ['1', '1'] }), /excludedCollectionIds/);
  assert.throws(() => validateConfig({ excludedCollectionIds: Array.from({ length: 251 }, (_, i) => String(i)) }), /excludedCollectionIds/);
});

test('diffConfig: a changed collection list is recorded once; an unchanged list is not', () => {
  const a = { ...DEFAULT_CONFIG, excludedCollectionIds: ['1'] };
  const changed = diffConfig(a, { ...a, excludedCollectionIds: ['1', '2'] });
  assert.deepStrictEqual(changed.map((c) => c.key), ['excludedCollectionIds']);
  assert.deepStrictEqual(diffConfig(a, { ...a, excludedCollectionIds: ['1'] }), []);
});
