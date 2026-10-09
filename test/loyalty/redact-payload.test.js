// test/loyalty/redact-payload.test.js
// web/lib/redact-payload.js: pure, no database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactPayload, findLeftovers } from '../../web/lib/redact-payload.js';

// A payload shaped like an orders/paid body. Every personal value is fake.
const sample = () => ({
  id: 5678901234567,
  name: '#1001',
  email: 'jane.doe@example.com',
  contact_email: 'jane.doe@example.com',
  phone: '+91 98765 43210',
  note: 'Please leave at the back door, call 98765 43210',
  token: 'abc123tokenvalue',
  order_status_url: 'https://shop.example.com/1/orders/abc123/authenticate?key=SECRETKEY123',
  browser_ip: '203.0.113.7',
  created_at: '2026-09-24T10:00:00+05:30',
  total_price: '559.00',
  taxes_included: false,
  discount_codes: [],
  customer: { id: 9001, admin_graphql_api_id: 'gid://shopify/Customer/9001', first_name: 'Jane', last_name: 'Doe', email: 'jane.doe@example.com', phone: '+1 (555) 625-1199', state: 'enabled', tags: '' },
  billing_address: { first_name: 'Jane', last_name: 'Doe', name: 'Jane Doe', address1: '1 Main St', address2: '', city: 'Pune', zip: '411001', province: 'Maharashtra', province_code: 'MH', country: 'India', country_code: 'IN', phone: '9876543210', company: 'Acme', latitude: 18.52, longitude: 73.85 },
  shipping_address: { name: 'Jane Doe', address1: '2 Side Rd', city: 'Pune', country_code: 'IN', zip: '411002' },
  client_details: { browser_ip: '203.0.113.7', user_agent: 'Mozilla/5.0', accept_language: 'en-IN' },
  note_attributes: [{ name: 'gift_message', value: 'Happy birthday Sam' }],
  line_items: [
    { id: 1004, name: 'Physical Product', title: 'Physical Product', price: '499.00', quantity: 1, gift_card: false, sku: 'SKU-1', properties: [{ name: 'Engraving', value: 'For Jane' }], discount_allocations: [{ amount: '50.00', discount_application_index: 0 }] },
    { id: 1005, title: 'Gift Card', price: '110.00', quantity: 1, gift_card: true },
  ],
});

const keyPaths = (v, base = '') => {
  if (Array.isArray(v)) return v.flatMap((x) => keyPaths(x, `${base}[]`));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => [`${base}.${k}`, ...keyPaths(x, `${base}.${k}`)]);
  return [];
};
const json = (o) => JSON.stringify(o);

test('every key is kept: the redacted payload has the same key paths', () => {
  const before = sample();
  assert.deepStrictEqual(keyPaths(redactPayload(before)).sort(), keyPaths(before).sort());
});

test('personal values are gone from the output, anywhere', () => {
  const out = json(redactPayload(sample()));
  for (const secret of ['jane.doe@example.com', 'Jane', 'Doe', '98765', '9876543210', '1 Main St', 'Pune', '411001', 'Acme',
    '203.0.113.7', 'abc123tokenvalue', 'SECRETKEY123', 'back door', 'Happy birthday', 'Engraving', 'For Jane', 'Mozilla']) {
    assert.ok(!out.includes(secret), `"${secret}" must not survive`);
  }
});

test('non-personal values survive: ids, prices, flags, dates, product fields, country and province codes', () => {
  const out = redactPayload(sample());
  assert.strictEqual(out.id, 5678901234567);
  assert.strictEqual(out.name, '#1001', 'order-level name is not personal');
  assert.strictEqual(out.total_price, '559.00');
  assert.strictEqual(out.taxes_included, false);
  assert.strictEqual(out.created_at, '2026-09-24T10:00:00+05:30', 'a timestamp is not a phone number');
  assert.strictEqual(out.customer.id, 9001);
  assert.strictEqual(out.customer.admin_graphql_api_id, 'gid://shopify/Customer/9001');
  assert.strictEqual(out.customer.state, 'enabled');
  assert.strictEqual(out.billing_address.country_code, 'IN');
  assert.strictEqual(out.billing_address.province_code, 'MH');
  assert.strictEqual(out.line_items[0].name, 'Physical Product', 'a product name is not personal');
  assert.strictEqual(out.line_items[0].sku, 'SKU-1');
  assert.deepStrictEqual(out.line_items[0].discount_allocations, [{ amount: '50.00', discount_application_index: 0 }]);
  assert.strictEqual(out.line_items[1].gift_card, true);
});

test('"name" is redacted inside customer and address objects only', () => {
  const out = redactPayload(sample());
  assert.match(out.billing_address.name, /^\[redacted/);
  assert.match(out.shipping_address.name, /^\[redacted/);
  assert.strictEqual(out.name, '#1001');
});

test('customer-typed and device subtrees keep their keys but lose every value', () => {
  const out = redactPayload(sample());
  assert.deepStrictEqual(Object.keys(out.client_details).sort(), ['accept_language', 'browser_ip', 'user_agent']);
  assert.ok(Object.values(out.client_details).every((v) => String(v).startsWith('[redacted')));
  assert.strictEqual(out.note_attributes.length, 1, 'array length kept');
  assert.deepStrictEqual(Object.keys(out.note_attributes[0]).sort(), ['name', 'value']);
  assert.strictEqual(out.line_items[0].properties.length, 1);
  assert.ok(!json(out.note_attributes).includes('birthday') && !json(out.line_items[0].properties).includes('Engraving'));
});

test('an email hidden under an UNEXPECTED key is swept out', () => {
  const out = redactPayload({
    id: 1,
    weird_custom_field: 'jane.doe@example.com',
    nested: { deeper: [{ another_unknown: 'reach me at jane.doe+promo@example.com please' }] },
  });
  assert.strictEqual(out.weird_custom_field, '[email]');
  assert.strictEqual(out.nested.deeper[0].another_unknown, 'reach me at [email] please');
  assert.ok(!json(out).includes('@'));
});

test('IP addresses, phone-looking strings and secret URL parameters are swept under unexpected keys', () => {
  const out = redactPayload({
    a: 'client at 198.51.100.23 today',
    b: '+91 98765 43210',
    c: '+1 (555) 625-1199',
    d: 'https://example.com/track?key=TOPSECRET&x=1',
    e: '2001:db8::ff00:42:8329',
    f: 'https://example.com/pay?access_token=abc&signature=def',
  });
  assert.strictEqual(out.a, 'client at [ip] today');
  assert.strictEqual(out.b, '[phone]');
  assert.strictEqual(out.c, '[phone]');
  assert.ok(out.d.includes('key=[redacted]') && out.d.includes('x=1') && !out.d.includes('TOPSECRET'));
  assert.strictEqual(out.e, '[ip]');
  assert.ok(!out.f.includes('abc') && !out.f.includes('def'));
});

test('times, dates, ids and gids are not mangled by the sweeps', () => {
  const input = { t: '2026-09-24T10:00:00+05:30', d: '2026-09-24', n: '5678901234567', g: 'gid://shopify/Order/5678901234567', p: '559.00', v: '10:00:00' };
  assert.deepStrictEqual(redactPayload(input), input);
});

test('the input is not modified, and non-string leaves keep their type', () => {
  const input = sample();
  const copy = JSON.parse(JSON.stringify(input));
  const out = redactPayload(input);
  assert.deepStrictEqual(input, copy, 'input unchanged');
  assert.strictEqual(typeof out.taxes_included, 'boolean');
  assert.strictEqual(typeof out.id, 'number');
  assert.deepStrictEqual(redactPayload({ a: null, b: undefined, c: [] }), { a: null, b: undefined, c: [] });
});

test('findLeftovers reports paths, never values, for what still looks personal', () => {
  const redacted = redactPayload({
    id: 1,
    customer_nickname: 'Jane from Pune',          // personal-looking key, not in the redaction list
    delivery_instructions: 'ring twice',          // free text under an unlisted key
    clean: 'fine',
    title: 'Gift Card',
  });
  const hits = findLeftovers(redacted);
  const paths = hits.map((h) => h.path);
  assert.ok(paths.includes('customer_nickname'), 'a personal-looking key is flagged');
  assert.ok(!paths.includes('clean') && !paths.includes('title'));
  assert.ok(!json(hits).includes('Jane from Pune'), 'values are never reported');
});

test('findLeftovers is quiet on a fully redacted sample', () => {
  const hits = findLeftovers(redactPayload(sample()));
  assert.deepStrictEqual(hits, [], JSON.stringify(hits));
});

test('confirmation_number (a customer-facing order reference) is redacted; nothing around it changes', () => {
  const out = redactPayload({ id: 7211153948869, name: '#1015', confirmation_number: '9FMV7PP8Y', order_number: 1015 });
  assert.match(out.confirmation_number, /^\[redacted/);
  assert.ok(!json(out).includes('9FMV7PP8Y'));
  assert.strictEqual(out.id, 7211153948869);
  assert.strictEqual(out.name, '#1015');
  assert.strictEqual(out.order_number, 1015);
  assert.deepStrictEqual(Object.keys(out), ['id', 'name', 'confirmation_number', 'order_number'], 'key kept, order unchanged');
});

// A refunds/create-shaped transaction: staff id, gateway reference, gateway text, receipt.
const refundSample = () => ({
  id: 998159777989,
  order_id: 7211395645637,
  user_id: 91234567890,
  restock: true,
  note: 'customer asked for it',
  transactions: [{
    id: 8816888578245, kind: 'refund', amount: '749.95', status: 'success', gateway: 'bogus', currency: 'USD',
    user_id: 91234567890,
    authorization: 'auth-SECRET-REF-1',
    message: 'Bogus Gateway: Forced success for jane.doe@example.com',
    receipt: { paid_amount: '749.95', nested: { ref: 'rcpt-SECRET-1', ok: true } },
  }],
});

test('user_id, transactions[].authorization and transactions[].message are redacted, keys kept', () => {
  const before = refundSample();
  const out = redactPayload(before);
  assert.match(out.user_id, /^\[redacted/);
  assert.match(out.transactions[0].user_id, /^\[redacted/);
  assert.match(out.transactions[0].authorization, /^\[redacted/);
  assert.match(out.transactions[0].message, /^\[redacted/);
  for (const secret of ['91234567890', 'auth-SECRET-REF-1', 'Forced success', 'jane.doe@example.com']) {
    assert.ok(!json(out).includes(secret), `"${secret}" must not survive`);
  }
  assert.deepStrictEqual(keyPaths(out).sort(), keyPaths(before).sort(), 'every key kept');
});

test('receipt is a redacted subtree: keys kept, every value replaced, including nested ones', () => {
  const out = redactPayload(refundSample()).transactions[0].receipt;
  assert.deepStrictEqual(Object.keys(out).sort(), ['nested', 'paid_amount']);
  assert.deepStrictEqual(Object.keys(out.nested).sort(), ['ok', 'ref']);
  assert.ok(!json(out).includes('749.95') && !json(out).includes('rcpt-SECRET-1'));
  assert.match(out.paid_amount, /^\[redacted/);
});

test('null user_id / authorization stay null; money, ids, kind, status and gateway survive', () => {
  const out = redactPayload({ id: 1, user_id: null, transactions: [{ id: 2, kind: 'refund', amount: '10.00', status: 'success', gateway: 'bogus', authorization: null, message: null, receipt: null }] });
  assert.strictEqual(out.user_id, null);
  assert.strictEqual(out.transactions[0].authorization, null);
  assert.strictEqual(out.transactions[0].message, null);
  assert.strictEqual(out.transactions[0].receipt, null);
  const kept = redactPayload(refundSample());
  assert.strictEqual(kept.id, 998159777989);
  assert.strictEqual(kept.order_id, 7211395645637);
  assert.strictEqual(kept.restock, true);
  assert.strictEqual(kept.transactions[0].amount, '749.95');
  assert.strictEqual(kept.transactions[0].kind, 'refund');
  assert.strictEqual(kept.transactions[0].gateway, 'bogus');
});

test('redacting an already-redacted payload again changes nothing (idempotent)', () => {
  const once = redactPayload(refundSample());
  assert.deepStrictEqual(redactPayload(once), once);
});
