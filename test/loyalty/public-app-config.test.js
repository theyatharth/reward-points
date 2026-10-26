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
  assert.match(noComments, /^url = "https:\/\/integrations\.platinuminfo\.tech\/reward-points-app\/api\/proxy"$/m);
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

test('public app: its own client id and URLs under /reward-points-app, no placeholder left', () => {
  assert.match(noComments, /^client_id = "390831a870f228d74b15950a9b1f3043"$/m);
  assert.match(noComments, /^application_url = "https:\/\/integrations\.platinuminfo\.tech\/reward-points-app"$/m);
  const redirects = noComments.match(/redirect_urls = \[([^\]]*)\]/)[1].split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
  assert.deepEqual(redirects, ['https://integrations.platinuminfo.tech/reward-points-app/api/auth', 'https://integrations.platinuminfo.tech/reward-points-app/api/auth/callback']);
  assert.ok(!/REPLACE/.test(toml));
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

test('hosting files agree with the toml and with each other: names, port 3004, /reward-points-app, no secrets', async () => {
  const { createRequire } = await import('node:module');
  const eco = createRequire(import.meta.url)('../../deploy/ecosystem.public.config.cjs');
  const [web, worker] = eco.apps;
  assert.deepEqual(eco.apps.map((a) => a.name), ['reward-points-app', 'reward-points-app-worker']);
  assert.deepEqual([web.script, worker.script], ['index.js', 'worker.js']);
  assert.ok(web.cwd.startsWith('/home/ubuntu/reward-points-app') && worker.cwd.startsWith('/home/ubuntu/reward-points-app'));
  assert.equal(web.env.PORT, 3004);
  assert.equal(web.env.APP_BASE_PATH, '/reward-points-app');
  assert.equal(web.env.ADMIN_AUTH, 'shopify');
  assert.equal(web.env.APP_ENV, 'production');
  assert.equal(worker.env.APP_ENV, 'production');
  // The base path in the toml's application_url is the one the app is started with.
  assert.ok(noComments.match(/^application_url = "([^"]*)"/m)[1].endsWith(web.env.APP_BASE_PATH));
  // Only names the public app needs; no secret or database URL in the file.
  for (const key of [...Object.keys(web.env), ...Object.keys(worker.env)]) assert.ok(!/SECRET|PASSWORD|DATABASE_URL|API_KEY/.test(key), key);
  const nginx = read('deploy/nginx-reward-points-app.conf.example');
  assert.match(nginx, /location \/reward-points-app\/ \{[^}]*proxy_pass http:\/\/127\.0\.0\.1:3004\/;/);
  assert.match(nginx, /location = \/reward-points-app \{[^}]*proxy_pass http:\/\/127\.0\.0\.1:3004\/;/);
  assert.ok(!/reward-points-dev|3001/.test(nginx.replace(/^#.*$/gm, '')), 'no dev app routing in the public app block');
});
