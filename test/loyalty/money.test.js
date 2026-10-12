// test/loyalty/money.test.js
// Unit tests for web/loyalty/rules/money.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePaise, formatPaise, multiplyPoints, dividePaise } from '../../web/loyalty/rules/money.js';

// ---------------------------------------------------------------------------
// parsePaise
// ---------------------------------------------------------------------------
test('parsePaise: "629.95" → 62995', () => {
  assert.strictEqual(parsePaise('629.95'), 62995);
});

test('parsePaise: "0.00" → 0', () => {
  assert.strictEqual(parsePaise('0.00'), 0);
});

test('parsePaise: JSON number 629.95 → 62995', () => {
  assert.strictEqual(parsePaise(629.95), 62995);
});

test('parsePaise: "1000" → 100000', () => {
  assert.strictEqual(parsePaise('1000'), 100000);
});

test('parsePaise: "100.1" → 10010', () => {
  assert.strictEqual(parsePaise('100.1'), 10010);
});

test('parsePaise: "419.00" → 41900', () => {
  assert.strictEqual(parsePaise('419.00'), 41900);
});

test('parsePaise: "" → 0', () => {
  assert.strictEqual(parsePaise(''), 0);
});

test('parsePaise: null → 0', () => {
  assert.strictEqual(parsePaise(null), 0);
});

test('parsePaise: undefined → 0', () => {
  assert.strictEqual(parsePaise(undefined), 0);
});

test('parsePaise: "0" → 0', () => {
  assert.strictEqual(parsePaise('0'), 0);
});

// ---------------------------------------------------------------------------
// formatPaise
// ---------------------------------------------------------------------------
test('formatPaise: 62995 INR → "₹629.95"', () => {
  assert.strictEqual(formatPaise(62995, 'INR'), '₹629.95');
});

test('formatPaise: 1000 INR → "₹10.00"', () => {
  assert.strictEqual(formatPaise(1000, 'INR'), '₹10.00');
});

test('formatPaise: 62995 USD → "USD 629.95"', () => {
  assert.strictEqual(formatPaise(62995, 'USD'), 'USD 629.95');
});

test('formatPaise: negative → sign prefix', () => {
  assert.strictEqual(formatPaise(-1000, 'INR'), '-₹10.00');
});

// ---------------------------------------------------------------------------
// multiplyPoints — floor
// ---------------------------------------------------------------------------
test('multiplyPoints floor: 14900 paise, 1 pt/unit → 149 pts', () => {
  // ₹149 order: 14900 paise, 1 point per ₹1 (per 100 paise)
  assert.strictEqual(multiplyPoints(14900, 1, 100, 'floor'), 149);
});

test('multiplyPoints floor: 39900 paise → 399 pts (GST: ₹419 - 5% GST = ₹399)', () => {
  // ₹419 order with taxes_included, 5% GST (≈₹19.95 tax)
  // eligible = 41900 - 2000 tax = 39900 paise → 399 pts
  assert.strictEqual(multiplyPoints(39900, 1, 100, 'floor'), 399);
});

test('multiplyPoints floor: fractional → rounds down', () => {
  // 150 paise at 1 pt/100 paise = 1.5 → floor = 1
  assert.strictEqual(multiplyPoints(150, 1, 100, 'floor'), 1);
});

test('multiplyPoints round: 150 paise → 2 pts (half-up)', () => {
  assert.strictEqual(multiplyPoints(150, 1, 100, 'round'), 2);
});

test('multiplyPoints block: whole spend blocks only (the client\'s engine): 150 paise at 1 per 100 -> 1 pt', () => {
  assert.strictEqual(multiplyPoints(150, 1, 100, 'block'), 1);
});

test('multiplyPoints block: 200 paise -> 2 pts; 99 paise -> 0 (not a full block)', () => {
  assert.strictEqual(multiplyPoints(200, 1, 100, 'block'), 2);
  assert.strictEqual(multiplyPoints(99, 1, 100, 'block'), 0);
});

test('multiplyPoints block: the client\'s test case, 100 points per 10000 paise: 14900 paise -> 100, 99900 -> 900, floor gives 149 and 999', () => {
  assert.strictEqual(multiplyPoints(14900, 100, 10000, 'block'), 100);
  assert.strictEqual(multiplyPoints(99900, 100, 10000, 'block'), 900);
  assert.strictEqual(multiplyPoints(14900, 100, 10000, 'floor'), 149);
  assert.strictEqual(multiplyPoints(99900, 100, 10000, 'floor'), 999);
  assert.strictEqual(multiplyPoints(14950, 100, 10000, 'round'), 150);
});

test('multiplyPoints: 0 paise → 0 pts', () => {
  assert.strictEqual(multiplyPoints(0, 1, 100, 'floor'), 0);
});

test('multiplyPoints: unknown mode throws', () => {
  assert.throws(() => multiplyPoints(100, 1, 100, 'unknown'), /Unknown rounding mode/);
});

// ---------------------------------------------------------------------------
// dividePaise
// ---------------------------------------------------------------------------
test('dividePaise: 10000 / 100 → 100', () => {
  assert.strictEqual(dividePaise(10000, 100), 100);
});

test('dividePaise: 9999 / 100 → 99 (floor)', () => {
  assert.strictEqual(dividePaise(9999, 100), 99);
});

test('dividePaise: 0 / 100 → 0', () => {
  assert.strictEqual(dividePaise(0, 100), 0);
});

test('dividePaise: zero divisor throws', () => {
  assert.throws(() => dividePaise(100, 0), /Divisor must be positive/);
});
