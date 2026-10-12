// test/loyalty/storefront-render.test.js
//
// The restyled widget and Rewards page (extensions/rewards-widget): the sections of the client's prototype
// (widgetView, rewardsScreen) drawn from a /history view by assets/rewards-client.js. Pure: the script runs in a vm
// sandbox against a small fake DOM that refuses HTML strings, with a fake fetch standing in for the signed App Proxy.
//
// One reward card for the single rule: N whole rewards become ONE code worth N x the reward value.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions', 'rewards-widget');
const CLIENT = readFileSync(join(EXT, 'assets/rewards-client.js'), 'utf8');
const CSS = readFileSync(join(EXT, 'assets/rewards-theme.css'), 'utf8');

class Node {
  constructor(tag, ns) { this.tagName = tag; this.ns = ns; this.className = ''; this.children = []; this.attrs = {}; this.style = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this._text = ''; this.type = ''; this.id = ''; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; }
  get firstChild() { return this.children[0] ?? null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({ target: this }); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text; }
  set innerHTML(_v) { throw new Error('innerHTML must never be set'); }
}
const walk = (n, fn) => { fn(n); n.children.forEach((c) => walk(c, fn)); };
const all = (n, pred) => { const out = []; walk(n, (x) => { if (pred(x)) out.push(x); }); return out; };
const text = (n) => [n._text, ...n.children.map(text)].join(' ');
const byClass = (n, cls) => all(n, (x) => String(x.className).split(' ').includes(cls));
const buttons = (n) => all(n, (x) => x.tagName === 'button');

function load({ fetchImpl, timers = [], clipboard } = {}) {
  const sandbox = {
    document: { createElement: (t) => new Node(t), createElementNS: (ns, t) => new Node(t, ns), createTextNode: (t) => { const n = new Node('#text'); n._text = t; return n; } },
    navigator: { clipboard: clipboard ?? { writeText: () => Promise.resolve() } },
    fetch: fetchImpl,
    crypto: { randomUUID: (() => { let i = 0; return () => `key-${++i}`; })() },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    Math, Date, JSON, String, Number, isNaN, isFinite, Promise,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(CLIENT, sandbox);
  return sandbox.window.EcoRewards;
}

const RULE = { pointsPerReward: 100, rewardValue: '10.00', currency: 'INR', holdPeriodDays: 30, earnPoints: 100, earnSpend: '100.00' };
const view = (over = {}) => ({
  success: true, balance: { available: 0, pending: 0, owed: 0 }, rule: RULE, pending: [], rewards: [], history: [], ...over,
});
const answer = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the Rewards page sections', () => {
  const draw = (v, handlers = {}) => {
    const E = load();
    const body = new Node('div');
    E.renderRewardsPage(body, v, { onRedeem() {}, onCopy() {}, shopUrl: '/collections/all', ...handlers });
    return body;
  };

  test('a new member sees the start-earning card with the earn rate and the reward, and ways to earn', () => {
    const body = draw(view());
    const t = text(body);
    assert.match(t, /Start earning Ecofynd Rewards/);
    assert.match(t, /Every ₹100 you spend earns 100 points, and 100 points are worth ₹10/);
    assert.match(t, /₹10 off/);
    assert.match(t, /Ways to earn/);
    assert.equal(all(body, (x) => x.tagName === 'a')[0].getAttribute('href'), '/collections/all');
    assert.equal(byClass(body, 'bal').length, 0, 'no balance card yet');
  });

  test('the balance card: points, value at the rule, owed and pending cards, in the prototype\'s order', () => {
    const body = draw(view({
      balance: { available: 250, pending: 300, owed: 0 },
      pending: [{ points: 200, availableOn: '2026-11-07T10:00:00.000Z' }, { points: 100, availableOn: '2026-11-20T10:00:00.000Z' }],
      history: [{ date: '2026-10-08T12:00:00.000Z', kind: 'earned', points: 550, label: 'Points earned' }],
    }));
    const order = body.children.map((c) => c.className.split(' ')[0]);
    assert.deepEqual(order, ['bal', 'pend', 'grid', 'grid', 'grid'], 'balance, pending, reward card, ways to earn, activity');
    const bal = text(byClass(body, 'bal')[0]);
    assert.match(bal, /Available to use/);
    assert.match(bal, /250/);
    assert.match(bal, /₹25 reward value/);
    const pend = text(byClass(body, 'pend')[0]);
    assert.match(pend, /300 points are on the way/);
    assert.match(pend, /₹30 future reward value/);
    assert.match(pend, /Next: 07 Nov 2026/);
    assert.match(pend, /200 pts.*Available on 07 Nov 2026/s);
    assert.match(pend, /100 pts.*Available on 20 Nov 2026/s);
    assert.match(pend, /holding period \(30 days\)/);
  });

  test('ONE reward card for the single rule: one reward is "₹10 off", several become one code worth the total', () => {
    const one = draw(view({ balance: { available: 150, pending: 0, owed: 0 }, history: [{ date: '2026-10-08T12:00:00.000Z', kind: 'earned', points: 150, label: 'x' }] }));
    const cardOne = text(one);
    assert.match(cardOne, /Rewards you can use/);
    assert.match(cardOne, /₹10 off/);
    assert.match(cardOne, /100 points/);
    assert.equal(byClass(one, 'goal').length, 0, 'ready: no "next reward" card');

    const three = draw(view({ balance: { available: 350, pending: 0, owed: 0 }, history: [{ date: '2026-10-08T12:00:00.000Z', kind: 'earned', points: 350, label: 'x' }] }));
    const t = text(three);
    assert.match(t, /₹30 off/);
    assert.match(t, /300 points for 3 rewards in one code/);
    assert.equal(all(three, (x) => x.id === 'ecrRedeem').length, 1);
  });

  test('not enough yet: the goal card with the progress bar, the gap, and pending points that will cover it', () => {
    const body = draw(view({ balance: { available: 40, pending: 300, owed: 0 }, history: [{ date: '2026-10-08T12:00:00.000Z', kind: 'earned', points: 340, label: 'x' }] }));
    const goal = byClass(body, 'goal')[0];
    const t = text(goal);
    assert.match(t, /Your next reward/);
    assert.match(t, /₹10 off/);
    assert.match(t, /You have 40 points/);
    assert.match(t, /60 points to go/);
    assert.match(t, /Your 300 points on the way will get you there/);
    const bar = byClass(goal, 'bar')[0];
    assert.equal(bar.getAttribute('role'), 'progressbar');
    assert.deepEqual([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')], ['40', '100']);
    assert.equal(bar.firstChild.style.width, '40%');
    assert.equal(all(body, (x) => x.id === 'ecrRedeem').length, 0, 'nothing to redeem yet');
  });

  test('owed points: the recovery card, and no reward card or goal while it lasts', () => {
    const body = draw(view({ balance: { available: 500, pending: 0, owed: 120 }, history: [{ date: '2026-10-08T12:00:00.000Z', kind: 'reversed', points: -120, label: 'x' }] }));
    assert.match(text(byClass(body, 'owed')[0]), /120 points are being recovered/);
    assert.equal(byClass(body, 'owed')[0].getAttribute('role'), 'status');
    assert.equal(all(body, (x) => x.id === 'ecrRedeem').length, 0);
    assert.equal(byClass(body, 'goal').length, 0);
  });

  test('codes ready to use: the code, its value and expiry, and a Copy button that reports the code', () => {
    const copied = [];
    const body = draw(view({ balance: { available: 0, pending: 0, owed: 0 }, rewards: [{ code: 'PLAT-ABCD2345', value: '10.00', expiresAt: '2027-01-05T00:00:00.000Z' }],
      history: [{ date: '2026-10-08T12:00:00.000Z', kind: 'redeemed', points: -100, label: 'x' }] }), { onCopy: (code) => copied.push(code) });
    const t = text(byClass(body, 'ready')[0]);
    assert.match(t, /₹10 off/);
    assert.match(t, /PLAT-ABCD2345/);
    assert.match(t, /until 05 Jan 2027/);
    buttons(byClass(body, 'ready')[0])[0].click();
    assert.deepEqual(copied, ['PLAT-ABCD2345']);
  });

  test('the activity timeline groups by day, signs the points, picks the icon by kind, and shows labels as TEXT', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const body = draw(view({
      balance: { available: 10, pending: 0, owed: 0 },
      history: [
        { date: '2026-10-09T12:00:00.000Z', kind: 'reversed', points: -675, label: 'Points reversed for a refund' },
        { date: '2026-10-09T10:00:00.000Z', kind: 'earned', points: 1349, label: evil },
        { date: '2026-10-08T12:00:00.000Z', kind: 'adjusted', points: -40, label: 'Adjustment by Ecofynd' },
      ],
    }));
    const days = byClass(body, 'tl-day');
    assert.equal(days.length, 2, 'two days');
    const items = byClass(body, 'tl-item');
    assert.equal(items.length, 3);
    const pts = byClass(body, 'tl-p').map((n) => text(n).trim());
    assert.deepEqual(pts, ['−675 pts', '+1,349 pts', '−40 pts']);
    assert.ok(text(body).includes(evil), 'the hostile label is shown verbatim as text');
    assert.equal(all(body, (x) => x.tagName === 'img').length, 0, 'and never became an element');
    const icons = items.map((i) => all(i, (x) => x.tagName === 'svg')[0]);
    assert.ok(icons.every((i) => i.ns === 'http://www.w3.org/2000/svg' && i.getAttribute('aria-hidden') === 'true'));
  });

  test('ways to earn uses the real earn rate; without it the text is generic, not invented', () => {
    assert.match(text(draw(view({ balance: { available: 1, pending: 0, owed: 0 }, history: [{ date: '2026-10-08T12:00:00.000Z', kind: 'earned', points: 1, label: 'x' }] }))), /Earn 100 points for every ₹100 spent/);
    const noRate = view({ rule: { pointsPerReward: 100, rewardValue: '10.00', currency: 'INR', holdPeriodDays: 30 }, balance: { available: 1, pending: 0, owed: 0 }, history: [{ date: '2026-10-08T12:00:00.000Z', kind: 'earned', points: 1, label: 'x' }] });
    assert.match(text(draw(noRate)), /Earn points automatically on every eligible paid order/);
  });

  test('a hostile code from the server stays text', () => {
    const body = draw(view({ balance: { available: 0, pending: 0, owed: 0 }, rewards: [{ code: '"><script>alert(1)</script>', value: '10.00', expiresAt: null }], history: [{ date: '2026-10-08T12:00:00.000Z', kind: 'redeemed', points: -100, label: 'x' }] }));
    assert.equal(all(body, (x) => x.tagName === 'script').length, 0);
    assert.ok(text(body).includes('<script>alert(1)</script>'));
  });
});

describe('the widget', () => {
  const panelFor = (v, handlers = {}) => {
    const E = load();
    const panel = new Node('div');
    E.renderWidgetPanel(panel, v, { shopUrl: '/collections/all', pageUrl: '/pages/rewards', loginUrl: '/account/login', ...handlers });
    return panel;
  };

  test('collapsed label: "N pts", or "Rewards" while points are being recovered', () => {
    const E = load();
    assert.equal(E.widgetLabel(view({ balance: { available: 1349, pending: 0, owed: 0 } })), '1,349 pts');
    assert.equal(E.widgetLabel(view({ balance: { available: 0, pending: 5, owed: 0 } })), '0 pts');
    assert.equal(E.widgetLabel(view({ balance: { available: 500, pending: 0, owed: 3 } })), 'Rewards');
    assert.equal(E.widgetLabel(null), 'Rewards');
  });

  test('expanded, new member: the start-earning card; logged out: join and log in', () => {
    const fresh = panelFor(view());
    assert.match(text(fresh), /Start earning Ecofynd Rewards/);
    assert.match(text(fresh), /Earn 100 points for every ₹100/);
    const out = panelFor(null);
    assert.match(text(out), /Join Ecofynd Rewards/);
    assert.equal(all(out, (x) => x.tagName === 'a')[0].getAttribute('href'), '/account/login');
  });

  test('expanded, with points: balance, value pill, progress to the next reward, pending, View Rewards', () => {
    const p = panelFor(view({ balance: { available: 40, pending: 300, owed: 0 }, history: [{ date: '2026-10-08T12:00:00.000Z', kind: 'earned', points: 340, label: 'x' }] }));
    const t = text(p);
    assert.match(t, /Your Ecofynd Rewards/);
    assert.match(t, /40\s+points/);
    assert.match(t, /₹4 available/);
    assert.match(t, /60 points to your next reward/);
    assert.match(t, /300 more on the way/);
    assert.equal(byClass(p, 'bar')[0].firstChild.style.width, '40%');
    assert.equal(all(p, (x) => x.tagName === 'a').at(-1).getAttribute('href'), '/pages/rewards');
    assert.match(text(p), /View Rewards/);
  });

  test('expanded, enough points: says what can be redeemed now; with owed points: the recovery line', () => {
    assert.match(text(panelFor(view({ balance: { available: 250, pending: 0, owed: 0 }, history: [{ date: '2026-10-08T12:00:00.000Z', kind: 'earned', points: 250, label: 'x' }] }))), /You can redeem ₹20 now/);
    const owed = panelFor(view({ balance: { available: 0, pending: 0, owed: 80 }, history: [{ date: '2026-10-08T12:00:00.000Z', kind: 'reversed', points: -80, label: 'x' }] }));
    assert.match(text(owed), /80 points being recovered from a return/);
  });

  test('initWidget: loads the view, sets the label, opens and closes the panel, and a logged-out visitor makes no request', async () => {
    const calls = [];
    const E = load({ fetchImpl: (url) => { calls.push(url); return answer(200, view({ balance: { available: 1349, pending: 0, owed: 0 }, history: [{ date: '2026-10-08T12:00:00.000Z', kind: 'earned', points: 1349, label: 'x' }] })); } });
    const [toggle, label, panel] = [new Node('button'), new Node('span'), new Node('div')];
    const w = E.initWidget({ toggle, label, panel, proxyPath: '/apps/rewards-dev', loggedIn: true, pageUrl: 'javascript:alert(1)' });
    assert.equal(panel.hidden, true);
    await w.ready;
    assert.equal(calls[0], '/apps/rewards-dev/history');
    assert.equal(label.textContent, '1,349 pts');
    toggle.click();
    assert.equal(panel.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.match(text(panel), /Your Ecofynd Rewards/);
    assert.equal(all(panel, (x) => x.tagName === 'a').at(-1).getAttribute('href'), '/pages/rewards', 'a bad page URL fell back');
    toggle.click();
    assert.equal(panel.hidden, true);
    w.setOpen(true);
    w.setOpen(false);

    const calls2 = [];
    const E2 = load({ fetchImpl: (url) => { calls2.push(url); return answer(200, {}); } });
    const [t2, l2, p2] = [new Node('button'), new Node('span'), new Node('div')];
    const w2 = E2.initWidget({ toggle: t2, label: l2, panel: p2, proxyPath: '/apps/rewards', loggedIn: false });
    await w2.ready;
    t2.click();
    assert.equal(calls2.length, 0, 'logged out: no request');
    assert.match(text(p2), /Join Ecofynd Rewards/);
  });

  test('initWidget survives a failing server: the first-paint label stays, the panel still opens', async () => {
    const E = load({ fetchImpl: () => Promise.reject(new Error('offline')) });
    const [toggle, label, panel] = [new Node('button'), new Node('span'), new Node('div')];
    label.textContent = '120 pts';
    const w = E.initWidget({ toggle, label, panel, proxyPath: '/apps/rewards', loggedIn: true });
    await w.ready;
    toggle.click();
    assert.equal(label.textContent, '120 pts');
    assert.equal(panel.hidden, false);
  });
});

describe('initPage', () => {
  const fullView = (available) => view({ balance: { available, pending: 0, owed: 0 }, history: [{ date: '2026-10-08T12:00:00.000Z', kind: 'earned', points: available, label: 'Points earned' }] });

  test('loads, draws; Redeem posts with an Idempotency-Key and no customer id; the code is shown, the page redrawn', async () => {
    const calls = [];
    let balance = 250;
    const fetchImpl = (url, opts = {}) => {
      calls.push({ url, opts });
      if (url.endsWith('/redeem')) { balance = 50; return answer(200, { success: true, status: 'active', code: 'PLAT-AAAA1111', pointsUsed: 200, value: '20.00', currency: 'INR', expiresAt: null, balance: { available: 50 } }); }
      return answer(200, { ...fullView(balance), rewards: balance === 50 ? [{ code: 'PLAT-AAAA1111', value: '20.00', expiresAt: null }] : [] });
    };
    const E = load({ fetchImpl });
    const body = new Node('div');
    const message = new Node('div');
    const page = await E.initPage({ body, message, proxyPath: '/apps/rewards-dev', shopUrl: '/collections/all', fetchImpl });
    assert.match(text(body), /₹20 off/, 'two rewards, one code');
    const redeem = all(body, (x) => x.id === 'ecrRedeem')[0];
    redeem.click();
    redeem.click(); // a double click while busy is ignored
    await settle(); await settle();
    const posts = calls.filter((c) => c.url.endsWith('/redeem'));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, '/apps/rewards-dev/redeem');
    assert.equal(posts[0].opts.headers['Idempotency-Key'], 'key-1');
    assert.ok(!/customer/i.test(posts[0].opts.body));
    assert.match(text(message), /Your reward code is ready: PLAT-AAAA1111/);
    assert.equal(message.firstChild.className, 'ok');
    assert.match(text(body), /Ready to use/);
    assert.equal(all(body, (x) => x.id === 'ecrRedeem').length, 0, 'the redeem button is gone: nothing left to redeem');
    void page;
  });

  test('a refusal shows the server\'s message and redraws; a network error keeps the key for the retry', async () => {
    let n = 0;
    const keys = [];
    const fetchImpl = (url, opts = {}) => {
      if (!url.endsWith('/redeem')) return answer(200, fullView(150));
      keys.push(opts.headers['Idempotency-Key']);
      n++;
      if (n === 1) return Promise.reject(new Error('offline'));
      if (n === 2) return answer(409, { success: false, reason: 'OWED', message: 'Your points balance is paused while points from a returned order are recovered.' });
      return answer(200, { success: true, status: 'active', code: 'C1', pointsUsed: 100, value: '10.00', currency: 'INR', expiresAt: null, balance: { available: 50 } });
    };
    const E = load({ fetchImpl });
    const [body, message] = [new Node('div'), new Node('div')];
    await E.initPage({ body, message, proxyPath: '/apps/rewards', fetchImpl });
    const click = async () => { all(body, (x) => x.id === 'ecrRedeem')[0].click(); await settle(); await settle(); };
    await click();
    assert.match(text(message), /Network error/);
    assert.equal(message.firstChild.className, 'err');
    await click();
    assert.match(text(message), /paused while points/);
    await click();
    assert.match(text(message), /Your reward code is ready: C1/);
    assert.deepEqual(keys, ['key-1', 'key-1', 'key-2'], 'the retry after the network error replays the same redemption');
  });

  test('a code still being created says so and schedules two refreshes', async () => {
    const timers = [];
    const fetchImpl = (url) => (url.endsWith('/redeem') ? answer(200, { success: true, status: 'creating', code: null }) : answer(200, fullView(100)));
    const E = load({ fetchImpl, timers });
    const [body, message] = [new Node('div'), new Node('div')];
    await E.initPage({ body, message, proxyPath: '/apps/rewards', fetchImpl });
    all(body, (x) => x.id === 'ecrRedeem')[0].click();
    await settle(); await settle();
    assert.match(text(message), /being prepared/);
    assert.deepEqual(timers.map((t) => t.ms), [3000, 9000]);
  });

  test('if the server cannot be reached the page says so instead of staying blank', async () => {
    const fetchImpl = () => Promise.reject(new Error('offline'));
    const E = load({ fetchImpl });
    const [body, message] = [new Node('div'), new Node('div')];
    await E.initPage({ body, message, proxyPath: '/apps/rewards', fetchImpl });
    assert.match(text(body), /could not be loaded right now/);
  });

  test('copy: success changes the button, failure shows the code in a message', async () => {
    const fetchImpl = () => answer(200, view({ balance: { available: 0, pending: 0, owed: 0 }, rewards: [{ code: 'PLAT-COPY0001', value: '10.00', expiresAt: null }], history: [{ date: '2026-10-08T12:00:00.000Z', kind: 'redeemed', points: -100, label: 'x' }] }));
    const timers = [];
    const E = load({ fetchImpl, timers });
    const [body, message] = [new Node('div'), new Node('div')];
    await E.initPage({ body, message, proxyPath: '/apps/rewards', fetchImpl });
    const copy = buttons(byClass(body, 'ready')[0])[0];
    copy.click();
    await settle();
    assert.equal(copy.textContent, '✓ Copied!');
    assert.equal(timers.at(-1).ms, 2500);


    const E2 = load({ fetchImpl, clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
    const [body2, message2] = [new Node('div'), new Node('div')];
    await E2.initPage({ body: body2, message: message2, proxyPath: '/apps/rewards', fetchImpl });
    buttons(byClass(body2, 'ready')[0])[0].click();
    await settle();
    assert.match(text(message2), /Could not copy automatically\. Your code: PLAT-COPY0001/);
    assert.equal(message2.firstChild.className, 'err');
  });
});

describe('notifications in the storefront', () => {
  const note = (type, text, read = false) => ({ type, text, date: '2026-10-12T09:00:00.000Z', read });
  const withNotes = (items, unread) => view({
    balance: { available: 10, pending: 0, owed: 0 },
    history: [{ date: '2026-10-08T12:00:00.000Z', kind: 'earned', points: 10, label: 'x' }],
    notifications: { unread, items },
  });

  test('the Rewards page lists them after pending, unread ones marked "New", read ones plain; text stays text', () => {
    const E = load();
    const body = new Node('div');
    const evil = '<img src=x onerror=alert(1)>';
    E.renderRewardsPage(body, withNotes([note('points_earned', evil), note('points_activated', '674 points are now available to use', true)], 1), { onRedeem() {}, onCopy() {} });
    const lines = byClass(body, 'earnline');
    assert.equal(lines.length, 2);
    assert.match(text(lines[0]), /New ·/);
    assert.match(text(lines[0]), /<img src=x onerror=alert\(1\)>/);
    assert.ok(!String(lines[0].className).includes('plain'));
    assert.ok(String(lines[1].className).includes('plain'));
    assert.doesNotMatch(text(lines[1]), /New/);
    assert.equal(all(body, (x) => x.tagName === 'img').length, 0);
    const order = body.children.map((c) => text(c).match(/Notifications|Activity|Ways to earn/)?.[0]).filter(Boolean);
    assert.deepEqual(order, ['Notifications', 'Ways to earn', 'Activity'], 'notifications sit above ways to earn and the timeline');
  });

  test('no notifications: no section', () => {
    const E = load();
    const body = new Node('div');
    E.renderRewardsPage(body, withNotes([], 0), { onRedeem() {}, onCopy() {} });
    assert.doesNotMatch(text(body), /Notifications/);
  });

  test('the widget panel shows at most the two newest unread', () => {
    const E = load();
    const panel = new Node('div');
    E.renderWidgetPanel(panel, withNotes([note('points_earned', 'one'), note('points_activated', 'two'), note('reward_redeemed', 'three'), note('points_earned', 'old', true)], 3), {});
    const t = byClass(panel, 'earnline').map((n) => text(n));
    assert.equal(t.length, 2);
    assert.match(t[0], /one/);
    assert.match(t[1], /two/);
  });

  test('initPage marks them read ONCE, after the first draw, and only if there were unread ones', async () => {
    const posts = [];
    const mk = (unread) => (url, opts = {}) => {
      if (url.endsWith('/notifications/read')) { posts.push({ url, method: opts.method, body: opts.body }); return answer(200, { success: true }); }
      return answer(200, withNotes([note('points_earned', 'a')], unread));
    };
    const fetchImpl = mk(1);
    const E = load({ fetchImpl });
    const [body, message] = [new Node('div'), new Node('div')];
    const page = await E.initPage({ body, message, proxyPath: '/apps/rewards-dev', fetchImpl });
    await settle();
    await page.refresh();
    await settle();
    assert.deepEqual(posts, [{ url: '/apps/rewards-dev/notifications/read', method: 'POST', body: '{}' }]);
    assert.match(text(body), /New ·/, 'the first draw still shows them as new');

    posts.length = 0;
    const f2 = mk(0);
    const E2 = load({ fetchImpl: f2 });
    await E2.initPage({ body: new Node('div'), message: new Node('div'), proxyPath: '/apps/rewards', fetchImpl: f2 });
    await settle();
    assert.equal(posts.length, 0);
  });

  test('the widget dot shows while there are unread notifications and the panel is closed', async () => {
    const fetchImpl = () => answer(200, withNotes([note('points_earned', 'a')], 2));
    const E = load({ fetchImpl });
    const [toggle, label, panel, dot] = [new Node('button'), new Node('span'), new Node('div'), new Node('span')];
    dot.hidden = true;
    const w = E.initWidget({ toggle, label, panel, dot, proxyPath: '/apps/rewards', loggedIn: true });
    await w.ready;
    assert.equal(dot.hidden, false);
    toggle.click();
    assert.equal(dot.hidden, true, 'opening the panel clears it');
    assert.match(text(panel), /a/);
  });
});

describe('the generated stylesheet', () => {
  test('every rule is scoped under .ecr, so it cannot leak into the theme; the prototype\'s tokens and fonts are there', () => {
    const selectors = [...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/^([^{}@\n][^{}]*)\{/gm)].map((m) => m[1].trim());
    assert.ok(selectors.length > 90, `${selectors.length} rules`);
    for (const sel of selectors) for (const part of sel.split(',')) assert.ok(part.trim().startsWith('.ecr'), `unscoped selector: ${part.trim()}`);
    for (const token of ['--umber:#7b5339', '--gold:#fad025', "--f-display:'Fraunces'", "--f-head:'Nunito'", '--r-lg:22px']) assert.ok(CSS.includes(token), token);
    for (const rule of ['.ecr .bal{', '.ecr .goal{', '.ecr .ritem.ready{', '.ecr .wbtn{', '.ecr .wpanel{', '.ecr .tl-item{', '.ecr .pend{', '.ecr .owed{']) assert.ok(CSS.includes(rule), rule);
    assert.ok(!/html\s*\{|body\s*\{/.test(CSS), 'no global element rules');
  });
});
