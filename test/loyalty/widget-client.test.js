// test/loyalty/widget-client.test.js
//
// Task 7b: the theme blocks (extensions/rewards-widget). Pure: no database, no browser.
//  * rewards-client.js is executed in a vm sandbox with a fake fetch and a tiny fake DOM;
//  * the two .liquid blocks are checked statically for the things that were wrong before:
//    HTML-string sinks (XSS), a hardcoded redeem threshold and "30 days", an unescaped customer name,
//    a customer id sent from the browser, a proxy path that cannot be configured, an invalid schema.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions', 'rewards-widget');
const read = (rel) => readFileSync(join(EXT, rel), 'utf8');
const CLIENT = read('assets/rewards-client.js');
const WIDGET = read('blocks/rewards-widget.liquid');
const PAGE = read('blocks/rewards-page.liquid');

// ---- a fake DOM that refuses HTML strings ----

class FakeNode {
  constructor(tag) { this.tagName = tag; this.className = ''; this.children = []; this.attrs = {}; this.style = {}; this._text = ''; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; }
  get firstChild() { return this.children[0] ?? null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  set innerHTML(_v) { throw new Error('innerHTML must never be set'); }
  set outerHTML(_v) { throw new Error('outerHTML must never be set'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML must never be called'); }
}
const allText = (n) => [n.textContent, ...n.children.map(allText)].join('|');

function load({ fetchImpl } = {}) {
  const sandbox = {
    document: { createElement: (tag) => new FakeNode(tag), createTextNode: (t) => { const n = new FakeNode('#text'); n.textContent = t; return n; } },
    navigator: {},
    fetch: fetchImpl,
    crypto: { randomUUID: (() => { let i = 0; return () => `key-${++i}`; })() },
    Math, Date, JSON, String, Number, isNaN,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(CLIENT, sandbox);
  return sandbox.window.EcoRewards;
}

// Objects made inside the vm sandbox have another Object prototype: compare them as plain JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));
const answer = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

describe('rewards-client.js', () => {
  test('safeProxyPath accepts /apps/<subpath> only, ignoring a trailing slash, else falls back to /apps/rewards', () => {
    const E = load();
    assert.equal(E.safeProxyPath('/apps/rewards-dev'), '/apps/rewards-dev');
    assert.equal(E.safeProxyPath('/apps/rewards/'), '/apps/rewards');
    assert.equal(E.safeProxyPath(' /apps/rewards-dev '), '/apps/rewards-dev');
    for (const bad of [undefined, null, '', 'rewards', '/apps/', '/apps/a/b', 'https://evil.example/apps/x', '//evil.example', '/apps/x?y=1', '/apps/UPPER', '/apps/x y', 42]) {
      assert.equal(E.safeProxyPath(bad), '/apps/rewards', String(bad));
    }
  });

  test('progress comes from the rule in the view; it is "unknown" without one, never a hardcoded 100', () => {
    const E = load();
    assert.deepEqual(plain(E.progress({ balance: { available: 120 }, rule: { pointsPerReward: 500 } })), { known: true, pct: 24, needed: 380, ready: false });
    assert.deepEqual(plain(E.progress({ balance: { available: 500 }, rule: { pointsPerReward: 500 } })), { known: true, pct: 100, needed: 0, ready: true });
    assert.deepEqual(plain(E.progress({ balance: { available: 900 }, rule: { pointsPerReward: 500 } })), { known: true, pct: 100, needed: 0, ready: true });
    assert.deepEqual(plain(E.progress({ balance: { available: 150 }, rule: { pointsPerReward: 100 } })), { known: true, pct: 100, needed: 0, ready: true });
    for (const view of [{}, { balance: { available: 5 } }, { balance: { available: 5 }, rule: {} }, { balance: { available: 5 }, rule: { pointsPerReward: 0 } }, null]) {
      assert.equal(E.progress(view).known, false);
      assert.equal(E.progress(view).ready, false);
    }
  });

  test('formatMoney', () => {
    const E = load();
    assert.equal(E.formatMoney('50.00', 'INR'), '₹50');
    assert.equal(E.formatMoney('12.50', 'USD'), '$12.50');
    assert.equal(E.formatMoney('5.00', 'EUR'), 'EUR 5');
  });

  test('redeem posts to <proxy>/redeem with an Idempotency-Key header and body key, and NO customer id', async () => {
    const calls = [];
    const E = load({ fetchImpl: (url, opts) => { calls.push({ url, opts }); return answer(200, { success: true, code: 'ABCD-1234', status: 'active' }); } });
    const r = await E.createRedeemer({ proxyPath: '/apps/rewards-dev' }).run();
    assert.equal(r.kind, 'success');
    assert.equal(calls[0].url, '/apps/rewards-dev/redeem');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers['Idempotency-Key'], 'key-1');
    assert.deepEqual(JSON.parse(calls[0].opts.body), { idempotencyKey: 'key-1' });
    assert.ok(!/customer/i.test(calls[0].opts.body), 'no customer id in the body');
  });

  test('a bad proxy path option falls back to the default (no request to an arbitrary URL)', async () => {
    const calls = [];
    const E = load({ fetchImpl: (url) => { calls.push(url); return answer(200, { success: true, code: 'X' }); } });
    await E.createRedeemer({ proxyPath: 'https://evil.example/steal' }).run();
    assert.equal(calls[0], '/apps/rewards/redeem');
  });

  test('the key survives a network error (a retry replays the same redemption) and is renewed after any real answer', async () => {
    const keys = [];
    let n = 0;
    const E = load({
      fetchImpl: (url, opts) => {
        keys.push(opts.headers['Idempotency-Key']);
        n++;
        if (n === 1) return Promise.reject(new Error('offline'));
        if (n === 2) return answer(200, { success: true, code: 'C1' });
        if (n === 3) return answer(400, { success: false, reason: 'SHORT', message: 'You need 300 more points to redeem.' });
        return answer(200, { success: true, code: 'C2' });
      },
    });
    const redeemer = E.createRedeemer({ proxyPath: '/apps/rewards' });
    assert.deepEqual(plain(await redeemer.run()), { kind: 'network' });
    assert.equal(redeemer.currentKey(), 'key-1', 'kept after the network error');
    assert.equal((await redeemer.run()).kind, 'success');
    assert.equal(redeemer.currentKey(), null, 'settled');
    const refused = await redeemer.run();
    assert.equal(refused.kind, 'refused');
    assert.equal(refused.body.message, 'You need 300 more points to redeem.');
    assert.equal((await redeemer.run()).kind, 'success');
    assert.deepEqual(keys, ['key-1', 'key-1', 'key-2', 'key-3'], 'same key for the retry, a new one for each new attempt');
  });

  test('a code still being created is "creating"; a non-JSON answer counts as a network failure', async () => {
    const E = load({ fetchImpl: () => answer(200, { success: true, status: 'creating', code: null }) });
    assert.equal((await E.createRedeemer({}).run()).kind, 'creating');
    const E2 = load({ fetchImpl: () => Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError('not json')) }) });
    const r2 = E2.createRedeemer({});
    assert.equal((await r2.run()).kind, 'network');
    assert.ok(r2.currentKey(), 'key kept');
  });

  test('loadView reads <proxy>/history', async () => {
    const calls = [];
    const E = load({ fetchImpl: (url) => { calls.push(url); return answer(200, { success: true }); } });
    const res = await E.loadView('/apps/rewards-dev');
    assert.equal(res.ok, true);
    assert.equal(calls[0], '/apps/rewards-dev/history');
  });

  test('renderHistory writes labels as TEXT: markup from the server or a customer stays inert', () => {
    const E = load();
    const container = new FakeNode('div');
    const evil = '<img src=x onerror=alert(1)>';
    E.renderHistory(container, [
      { date: '2026-10-08T12:00:00Z', kind: 'earned', points: 120, label: evil },
      { date: '2026-10-09T12:00:00Z', kind: 'redeemed', points: -500, label: '<script>alert(2)</script>' },
    ], { table: 't', plus: 'plus', minus: 'minus' });
    const text = allText(container);
    assert.ok(text.includes(evil) && text.includes('<script>alert(2)</script>'), 'shown verbatim, as text');
    const rows = container.children[0].children.find((c) => c.tagName === 'tbody').children;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => [r.children[2].className, r.children[2].textContent]), [['plus', '+120'], ['minus', '-500']]);
  });

  test('renderHistory with no entries says so, and clears what was there', () => {
    const E = load();
    const container = new FakeNode('div');
    container.appendChild(new FakeNode('p'));
    E.renderHistory(container, [], { table: 't', plus: 'p', minus: 'm' });
    assert.equal(container.children.length, 1);
    assert.match(allText(container), /No reward history yet/);
  });
});

describe('theme blocks (static checks)', () => {
  const files = { 'rewards-client.js': CLIENT, 'rewards-widget.liquid': WIDGET, 'rewards-page.liquid': PAGE };

  test('no HTML-string sinks anywhere (innerHTML, outerHTML, insertAdjacentHTML, document.write, eval)', () => {
    for (const [name, text] of Object.entries(files)) {
      for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
        assert.ok(!text.includes(sink), `${name} must not contain ${sink}`);
      }
    }
  });

  test('the redeem threshold and the hold period are not hardcoded: they come from the rule in the /history view', () => {
    for (const [name, text] of Object.entries({ widget: WIDGET, page: PAGE, client: CLIENT })) {
      assert.ok(!/redeem_threshold\s*=\s*\d/.test(text), `${name}: no "redeem_threshold = N"`);
      assert.ok(!/30 days|30-day|30 Days/.test(text), `${name}: no hardcoded "30 days"`);
    }
    assert.match(CLIENT, /view\.rule\.holdPeriodDays/, 'the hold period comes from the rule');
    assert.match(CLIENT, /rule\.pointsPerReward/, 'the threshold comes from the rule');
  });

  test('customer-controlled and server values are escaped in Liquid', () => {
    assert.match(PAGE, /customer\.first_name \| escape/);
    for (const text of [WIDGET, PAGE]) {
      const unescaped = [...text.matchAll(/\{\{\s*(customer\.[^}|]*|active_code|discount_code|pending_available_at)\s*\}\}/g)].map((m) => m[0]);
      assert.deepEqual(unescaped, [], `unescaped output: ${unescaped.join(', ')}`);
    }
    // codes are never interpolated into inline JavaScript
    assert.ok(!/onclick=/.test(WIDGET + PAGE), 'no inline handlers');
  });

  test('the browser sends no customer id; identity is the signed proxy request', () => {
    for (const text of [WIDGET, PAGE, CLIENT]) {
      assert.ok(!/customer\.id|customerId/.test(text), 'no customer id in the front end');
    }
  });

  test('the proxy path is a block setting with the live default, validated by the client; no hardcoded /apps/rewards fetch', () => {
    for (const [name, text] of Object.entries({ widget: WIDGET, page: PAGE })) {
      assert.match(text, /data-proxy="\{\{ proxy_path \| escape \}\}"/, `${name}: path passed as an escaped data attribute`);
      assert.ok(!/fetch\(\s*['"]\/apps\//.test(text), `${name}: no fetch to a literal /apps/ path`);
      const schema = JSON.parse(text.match(/\{% schema %\}([\s\S]*?)\{% endschema %\}/)[1]);
      const setting = schema.settings.find((s) => s.id === 'proxy_path');
      assert.deepEqual([setting.type, setting.default], ['text', '/apps/rewards'], `${name}: schema setting`);
    }
    // The client validates the path in every entry point that talks to the server.
    assert.match(CLIENT, /function initPage[\s\S]*?safeProxyPath\(o\.proxyPath\)/);
    assert.match(CLIENT, /function initWidget[\s\S]*?safeProxyPath\(o\.proxyPath\)/);
    assert.match(CLIENT, /function createRedeemer[\s\S]*?safeProxyPath\(/);
  });

  test('each block\'s schema is ONE valid JSON object', () => {
    for (const [name, text] of Object.entries({ widget: WIDGET, page: PAGE })) {
      const m = text.match(/\{% schema %\}([\s\S]*?)\{% endschema %\}/);
      assert.ok(m, `${name}: has a schema`);
      const schema = JSON.parse(m[1]);
      assert.equal(typeof schema.name, 'string');
      assert.ok(['body', 'section'].includes(schema.target));
    }
  });

  test('both blocks load the shared client script from the extension assets', () => {
    for (const text of [WIDGET, PAGE]) assert.match(text, /'rewards-client\.js' \| asset_url/);
  });
});
