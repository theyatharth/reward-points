// test/loyalty/topics.test.js
// The explicit topic map (web/loyalty/service/topics.js). Pure: no database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOPIC_MAP, normalizeTopic, isKnownTopic } from '../../web/loyalty/service/topics.js';

const EXPECTED = {
  ORDERS_PAID: 'orders/paid',
  REFUNDS_CREATE: 'refunds/create',
  ORDERS_CANCELLED: 'orders/cancelled',
  APP_UNINSTALLED: 'app/uninstalled',
  CUSTOMERS_DATA_REQUEST: 'customers/data_request',
  CUSTOMERS_REDACT: 'customers/redact',
  SHOP_REDACT: 'shop/redact',
};

test('the map is exactly the seven agreed pairs (and frozen)', () => {
  assert.deepStrictEqual({ ...TOPIC_MAP }, EXPECTED);
  assert.ok(Object.isFrozen(TOPIC_MAP));
});

test('every enum form normalises to its slash form', () => {
  for (const [enumForm, slash] of Object.entries(EXPECTED)) {
    assert.strictEqual(normalizeTopic(enumForm), slash, enumForm);
  }
});

test('a slash form passes through unchanged', () => {
  for (const slash of Object.values(EXPECTED)) assert.strictEqual(normalizeTopic(slash), slash);
});

test('anything else is returned exactly as given (no guessing, no case folding)', () => {
  for (const other of ['products/update', 'orders_paid', 'Orders/Paid', 'ORDERS_PAID ', '', 'toString', '__proto__']) {
    assert.strictEqual(normalizeTopic(other), other, JSON.stringify(other));
  }
  assert.strictEqual(normalizeTopic(undefined), undefined);
  assert.strictEqual(normalizeTopic(null), null);
});

test('isKnownTopic is true for both forms of the seven topics and false otherwise', () => {
  for (const [enumForm, slash] of Object.entries(EXPECTED)) {
    assert.ok(isKnownTopic(enumForm), enumForm);
    assert.ok(isKnownTopic(slash), slash);
  }
  for (const other of ['products/update', 'orders_paid', '', undefined, null, 'toString', 'constructor']) {
    assert.strictEqual(isKnownTopic(other), false, String(other));
  }
});
