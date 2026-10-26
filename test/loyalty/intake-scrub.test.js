// test/loyalty/intake-scrub.test.js
//
// web/lib/intake-scrub.js: names, e-mails, phones and addresses never reach the database; the customer id, line items, discounts,
// taxes and refunds do, unchanged. Pure tests, then through storeWebhook with the real fixtures (made personal again first).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { scrubPayload } from '../../web/lib/intake-scrub.js';
import { computeEarningFromOrder } from '../../web/loyalty/rules/earning.js';
import { DEFAULT_CONFIG } from '../../web/loyalty/rules/config.js';
import { storeWebhook } from '../../web/loyalty/service/webhook.js';
import { uniqueId } from '../helpers/ids.js';

const PII = ['jane.doe@example.com', 'Jane', 'Doe', '98765 43210', '+1 (555) 625-1199', '1 Main St', 'Pune', '411001', 'Acme', '203.0.113.7', 'abc123tokenvalue', 'SECRETKEY123', 'back door', 'Happy birthday', 'For Jane', 'Mozilla', 'GATEWAY-AUTH-1', 'tracking-777'];

const sample = () => ({
  id: 5678901234567, name: '#1001', email: 'jane.doe@example.com', contact_email: 'jane.doe@example.com', phone: '+91 98765 43210',
  note: 'Please leave at the back door', token: 'abc123tokenvalue', order_status_url: 'https://shop.example.com/1/orders/abc/authenticate?key=SECRETKEY123',
  browser_ip: '203.0.113.7', created_at: '2026-09-24T10:00:00+05:30', currency: 'INR', total_price: '559.00', taxes_included: false,
  discount_codes: [{ code: 'WELCOME10', amount: '50.00', type: 'percentage' }],
  discount_applications: [{ type: 'discount_code', code: 'WELCOME10', value: '10.0', value_type: 'percentage', allocation_method: 'across', target_selection: 'all', target_type: 'line_item' }],
  customer: { id: 9001, admin_graphql_api_id: 'gid://shopify/Customer/9001', first_name: 'Jane', last_name: 'Doe', email: 'jane.doe@example.com', phone: '+1 (555) 625-1199', state: 'enabled', tags: 'vip, Jane', note: 'Jane likes tea', orders_count: 4, default_address: { address1: '1 Main St', city: 'Pune' } },
  billing_address: { first_name: 'Jane', name: 'Jane Doe', address1: '1 Main St', city: 'Pune', zip: '411001', company: 'Acme', country_code: 'IN' },
  shipping_address: { name: 'Jane Doe', address1: '2 Side Rd', city: 'Pune', zip: '411001' },
  client_details: { browser_ip: '203.0.113.7', user_agent: 'Mozilla/5.0' },
  note_attributes: [{ name: 'gift', value: 'Happy birthday Sam' }],
  line_items: [
    { id: 1004, name: 'Physical Product', title: 'Physical Product', price: '499.00', quantity: 1, gift_card: false, sku: 'SKU-1', properties: [{ name: 'Engraving', value: 'For Jane' }],
      tax_lines: [{ title: 'GST', price: '89.82', rate: 0.18 }], discount_allocations: [{ amount: '50.00', discount_application_index: 0 }] },
    { id: 1005, title: 'Gift Card', price: '110.00', quantity: 1, gift_card: true },
  ],
  shipping_lines: [{ id: 1, title: 'Standard', price: '30.00', tax_lines: [] }],
  fulfillments: [{ id: 3, tracking_number: 'tracking-777', tracking_url: 'https://track.example/tracking-777', status: 'success' }],
  refunds: [{ id: 77, note: 'Customer Jane called', user_id: 1234, refund_line_items: [{ id: 8, quantity: 1, line_item_id: 1004, subtotal: 449, line_item: { id: 1004, properties: [{ name: 'Engraving', value: 'For Jane' }], price: '499.00' } }],
    transactions: [{ id: 5, amount: '449.00', kind: 'refund', authorization: 'GATEWAY-AUTH-1', message: 'Refunded to jane.doe@example.com', receipt: { x: 'Jane' }, payment_details: { credit_card_name: 'Jane Doe' } }] }],
});

describe('scrubPayload', () => {
  test('no personal value survives anywhere in the output', () => {
    const out = JSON.stringify(scrubPayload(sample()));
    for (const secret of PII) assert.ok(!out.includes(secret), `"${secret}" must not survive`);
    for (const key of ['email', 'phone', 'first_name', 'last_name', 'billing_address', 'shipping_address', 'default_address', 'note_attributes', 'client_details', 'properties', 'browser_ip', 'tracking_number', 'authorization']) {
      assert.ok(!out.includes(`"${key}"`), `key ${key} is dropped`);
    }
  });

  test('what the points need is kept exactly: ids, lines, discounts, taxes, shipping, refunds and transaction amounts', () => {
    const before = sample();
    const out = scrubPayload(before);
    assert.equal(out.id, 5678901234567);
    assert.equal(out.name, '#1001');
    assert.equal(out.total_price, '559.00');
    assert.equal(out.currency, 'INR');
    assert.equal(out.created_at, '2026-09-24T10:00:00+05:30');
    assert.deepEqual(out.discount_codes, before.discount_codes);
    assert.deepEqual(out.discount_applications, before.discount_applications);
    assert.deepEqual(out.shipping_lines, before.shipping_lines);
    assert.deepEqual(out.customer, { id: 9001, admin_graphql_api_id: 'gid://shopify/Customer/9001' });
    const { properties, ...line } = before.line_items[0];
    assert.deepEqual(out.line_items[0], line);
    assert.deepEqual(out.line_items[1], before.line_items[1]);
    assert.deepEqual(out.refunds[0].refund_line_items[0].line_item, { id: 1004, price: '499.00' });
    assert.equal(out.refunds[0].refund_line_items[0].subtotal, 449);
    assert.deepEqual(out.refunds[0].transactions, [{ id: 5, amount: '449.00', kind: 'refund' }]);
    assert.equal(out.refunds[0].id, 77);
    assert.equal(out.fulfillments[0].status, 'success');
  });

  test('a stray e-mail, IP or phone in a field no rule names is still swept; the input is not changed; repeating changes nothing', () => {
    const p = { id: 1, customer: { id: 2 }, line_items: [{ id: 1, title: 'Mug for bob@example.com', quantity: 1, price: '1.00' }], custom_field: '+91 98765 43210', where: 'from 203.0.113.9 today' };
    const copy = JSON.stringify(p);
    const out = scrubPayload(p);
    assert.equal(JSON.stringify(p), copy);
    assert.ok(!JSON.stringify(out).includes('bob@example.com') && !JSON.stringify(out).includes('98765') && !JSON.stringify(out).includes('203.0.113.9'));
    assert.deepEqual(scrubPayload(out), out);
  });

  test('guest orders, odd shapes and bad input', () => {
    assert.deepEqual(scrubPayload({ id: 1, customer: null }), { id: 1, customer: null });
    assert.deepEqual(scrubPayload({ id: 1, customer: [] }), { id: 1, customer: [] });
    assert.equal(scrubPayload(null), null);
    assert.equal(scrubPayload('text'), 'text');
    assert.deepEqual(scrubPayload([1, { email: 'a@b.co', id: 2 }]), [1, { id: 2 }]);
    let deep = { id: 1 };
    for (let i = 0; i < 5000; i++) deep = { id: 1, child: deep };
    assert.doesNotThrow(() => scrubPayload(deep));
  });
});

describe('through the intake', () => {
  after(async () => { await prisma.$disconnect(); });

  test('storeWebhook keeps no personal data in the database, for orders/paid, refunds/create and orders/cancelled', async () => {
    const shop = `scrub-${Date.now()}.myshopify.com`;
    const o = sample();
    for (const [topic, payload] of [['orders/paid', o], ['refunds/create', o.refunds[0]], ['orders/cancelled', o]]) {
      const e = await storeWebhook({ shop, topic, payload, shopifyWebhookId: crypto.randomUUID() });
      const row = await prisma.webhookEvent.findUnique({ where: { id: e.id } });
      for (const secret of PII) assert.ok(!JSON.stringify(row.payload).includes(secret), `${topic}: "${secret}"`);
      assert.ok(row.payload.id);
    }
  });

  test('the real fixtures, made personal again, earn exactly the same points scrubbed as not, and keep every kept key', () => {
    const dir = new URL('../fixtures/shopify/real/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.startsWith('orders-paid-'));
    assert.ok(files.length >= 7);
    for (const f of files) {
      const original = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      const personal = { ...original, email: 'jane.doe@example.com', phone: '+91 98765 43210', note: 'back door', billing_address: { name: 'Jane Doe', address1: '1 Main St' }, customer: { ...(original.customer ?? { id: 1 }), first_name: 'Jane', email: 'jane.doe@example.com' } };
      const scrubbed = scrubPayload(personal);
      assert.ok(!JSON.stringify(scrubbed).includes('jane.doe@example.com'), f);
      const a = computeEarningFromOrder(personal, DEFAULT_CONFIG);
      const b = computeEarningFromOrder(scrubbed, DEFAULT_CONFIG);
      assert.deepEqual(b, a, f);
      assert.deepEqual(scrubbed.line_items, scrubPayload(original).line_items, f);
    }
    for (const f of readdirSync(dir).filter((x) => x.startsWith('refunds-create-'))) {
      const original = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      const scrubbed = scrubPayload({ ...original, note: 'Jane called', user_id: 5 });
      assert.deepEqual(scrubbed.refund_line_items?.map((r) => [r.id, r.line_item_id, r.quantity, r.subtotal]), original.refund_line_items?.map((r) => [r.id, r.line_item_id, r.quantity, r.subtotal]), f);
      assert.deepEqual(scrubbed.transactions?.map((t) => [t.id, t.amount, t.kind]), original.transactions?.map((t) => [t.id, t.amount, t.kind]), f);
    }
  });
});
