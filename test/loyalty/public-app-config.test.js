// test/loyalty/public-app-config.test.js
// shopify.app.production.toml (the public app) says what the brief says, and the dev app's config is left alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const toml = read('shopify.app.production.toml');
const noComments = toml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const list = (re) => {
  const m = noComments.match(re);
  assert.ok(m, `not found: ${re}`);
  return m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
};

test('public app: embedded, named Reward Points, own proxy path', () => {
  assert.match(noComments, /^embedded = true$/m);
  assert.match(noComments, /^name = "Reward Points"$/m);
  assert.match(noComments, /^prefix = "apps"$/m);
  assert.match(noComments, /^subpath = "reward-points"$/m);
  assert.match(noComments, /^url = "https:\/\/REPLACE_HOST\/api\/proxy"$/m);
});

test('public app: exactly the four scopes, no product scopes', () => {
  const scopes = noComments.match(/^scopes = "([^"]*)"/m)[1].split(',').map((s) => s.trim()).sort();
  assert.deepEqual(scopes, ['read_customers', 'read_orders', 'write_customers', 'write_discounts']);
});

test('public app: the five event topics and the three compliance topics go to /api/webhooks', () => {
  const topics = list(/^\s*topics = \[([^\]]*)\]/m);
  assert.deepEqual(topics.sort(), ['app/scopes_update', 'app/uninstalled', 'orders/cancelled', 'orders/paid', 'refunds/create']);
  const compliance = list(/compliance_topics = \[([^\]]*)\]/);
  assert.deepEqual(compliance.sort(), ['customers/data_request', 'customers/redact', 'shop/redact']);
  const uris = [...noComments.matchAll(/^\s*uri = "([^"]*)"/gm)].map((m) => m[1]);
  assert.deepEqual(uris, ['/api/webhooks', '/api/webhooks']);
});

test('public app: no client id of the dev or old production app', () => {
  assert.ok(!toml.includes('0f07160caeafdddae72336eb51421e05'));
  assert.ok(!toml.includes('6e567e94d670cf3de3188db6baa5f026'));
});

test('the dev app config is unchanged: dev proxy subpath and its own client id', () => {
  const dev = read('shopify.app.toml');
  assert.match(dev, /subpath = "rewards-dev"/);
  assert.match(dev, /client_id = "0f07160caeafdddae72336eb51421e05"/);
});

test('theme blocks and the storefront client default to /apps/reward-points', () => {
  for (const f of ['extensions/rewards-widget/blocks/rewards-widget.liquid', 'extensions/rewards-widget/blocks/rewards-page.liquid']) {
    const s = read(f);
    assert.match(s, /default: '\/apps\/reward-points'/, f);
    assert.match(s, /"default": "\/apps\/reward-points"/, f);
    assert.ok(!/'\/apps\/rewards'/.test(s), f);
  }
  assert.match(read('extensions/rewards-widget/assets/rewards-client.js'), /DEFAULT_PROXY = '\/apps\/reward-points'/);
});
