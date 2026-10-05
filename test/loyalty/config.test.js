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
