// test/loyalty/get-started.test.js
//
// The "Get started" page: the steps and their theme-editor deep links (built from the shop and the API key only), what is known
// automatically, "done" audited once, the console landing on it for a new shop only, and a page that opens nothing but an https
// address on the shop's own domain.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../web/lib/prisma.js';
import { deepLinks, BLOCK_HANDLES } from '../../web/admin/deep-links.js';
import { getStarted, markSetupDone, shouldShowGetStarted } from '../../web/admin/data/get-started.js';
import { renderStart, safeLink, startPage } from '../../web/admin/public/pages/start.js';
import { PAGES } from '../../web/admin/public/pages/index.js';
import { startEmbeddedConsole, sessionToken, installShop, TEST_API_KEY } from '../helpers/shopify-embedded.js';
import { uniqueId } from '../helpers/ids.js';
import { readFileSync, readdirSync } from 'node:fs';

const BASE = { spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, holdPeriodDays: 30, ledgerStartAt: new Date('2026-01-01T00:00:00Z') };
const newShop = () => `gs-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;

describe('Deep links', () => {
  test('the exact URLs: api key and block handle, the shop domain, encoded', () => {
    const l = deepLinks({ shop: 'acme.myshopify.com', apiKey: 'abc123' });
    assert.equal(l.activateEmbed, 'https://acme.myshopify.com/admin/themes/current/editor?context=apps&template=index&activateAppId=abc123/rewards-widget');
    assert.equal(l.addPageBlock, 'https://acme.myshopify.com/admin/themes/current/editor?template=page&addAppBlockId=abc123/rewards-page&target=newAppsSection');
    assert.equal(l.newPage, 'https://acme.myshopify.com/admin/pages/new');
    assert.equal(l.storefrontPage, 'https://acme.myshopify.com/pages/rewards');
    assert.match(deepLinks({ shop: 'acme.myshopify.com', apiKey: 'a/b&c=d' }).activateEmbed, /activateAppId=a%2Fb%26c%3Dd\/rewards-widget$/);
  });

  test('the handles are the file names of the blocks that exist, and a shop that is not a shop is refused', () => {
    const files = readdirSync(new URL('../../extensions/rewards-widget/blocks/', import.meta.url));
    for (const h of Object.values(BLOCK_HANDLES)) assert.ok(files.includes(`${h}.liquid`), h);
    for (const bad of ['', 'evil.com', 'a.myshopify.com.evil.com', 'a b.myshopify.com', 'a.myshopify.com/../x', undefined]) assert.throws(() => deepLinks({ shop: bad, apiKey: 'k' }), /myshopify/);
  });
});

describe('Get started: data and console', () => {
  let shop;
  let site;
  before(async () => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
    site = await startEmbeddedConsole();
  });
  after(async () => { await site.close(); await prisma.$disconnect(); });
  beforeEach(() => { shop = newShop(); });
  const configure = (over = {}) => prisma.loyaltyConfig.create({ data: { shop, ...BASE, currency: 'INR', ...over } });

  test('the five steps in order with their links; the program step is done for a normal shop', async () => {
    await configure({ programName: 'Acme Club' });
    const d = await getStarted({ shop, apiKey: 'k1' });
    assert.deepEqual(d.steps.map((s) => s.id), ['program', 'embed', 'page', 'block', 'check']);
    assert.deepEqual(d.steps.map((s) => s.state), ['done', 'manual', 'manual', 'manual', 'manual']);
    assert.match(d.steps[0].text, /"Acme Club" runs in INR.*30 days/);
    const links = Object.fromEntries(d.steps.flatMap((s) => s.links.map((l) => [`${s.id}.${l.id}`, l])));
    assert.equal(links['embed.activateEmbed'].url, `https://${shop}/admin/themes/current/editor?context=apps&template=index&activateAppId=k1/rewards-widget`);
    assert.equal(links['block.addPageBlock'].url.includes('addAppBlockId=k1/rewards-page'), true);
    assert.deepEqual([links['program.rules'].kind, links['program.rules'].target], ['console', 'rules']);
    assert.equal(d.done, false);
    assert.match(d.note, /theme editor/);
  });

  test('an unsupported currency blocks the first step; no config says it is being set up', async () => {
    await configure({ currency: 'JPY' });
    const d = await getStarted({ shop, apiKey: 'k' });
    assert.equal(d.steps[0].state, 'blocked');
    assert.match(d.steps[0].text, /JPY.*not supported/);
    shop = newShop();
    const none = await getStarted({ shop, apiKey: 'k' });
    assert.equal(none.steps[0].state, 'waiting');
  });

  test('a new shop lands on it; an order, or marking it done, ends that; done is audited once', async () => {
    await configure();
    assert.equal(await shouldShowGetStarted(shop), true);
    const account = await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: String(uniqueId()) } });
    await prisma.loyaltyOrder.create({ data: { accountId: account.id, shopifyOrderId: String(uniqueId()), shop, pointsEarned: 1, eligibleAmountPaise: 100, processedAt: new Date() } });
    assert.equal(await shouldShowGetStarted(shop), false, 'an order has arrived');
    shop = newShop();
    await configure();
    assert.equal((await markSetupDone({ shop, shopifyUserId: '31' })).already, false);
    assert.equal((await markSetupDone({ shop, shopifyUserId: '31' })).already, true);
    assert.equal(await shouldShowGetStarted(shop), false);
    const audit = await prisma.auditLog.findMany({ where: { shop, action: 'setup_done' } });
    assert.deepEqual(audit.map((a) => a.shopifyUserId), ['31']);
    assert.equal((await getStarted({ shop, apiKey: 'k' })).done, true);
  });

  test('over HTTP: /meta says whether to open on it, /get-started uses the token\'s shop only, and "done" needs a valid token', async () => {
    process.env.SHOPIFY_API_KEY = TEST_API_KEY; // what the console reads for the links (the server's own key)
    await configure();
    await installShop(shop);
    const token = sessionToken(shop, { sub: '77' });
    assert.equal((await site.call('GET', 'meta', { token })).json.program.showGetStarted, true);
    const other = newShop();
    await installShop(other);
    const page = (await site.call('GET', `get-started?shop=${other}`, { token })).json;
    assert.equal(page.shop, shop, 'the shop comes from the token, not the query');
    assert.ok(page.steps.every((s) => s.links.every((l) => !l.url || l.url.startsWith(`https://${shop}/`))));
    assert.ok(page.steps[1].links[0].url.includes(`activateAppId=${TEST_API_KEY}/rewards-widget`));
    assert.equal((await site.call('POST', 'get-started/done', { body: {} })).status, 401);
    assert.equal((await site.call('POST', 'get-started/done', { token: 'forged.token.value', body: {} })).status, 401);
    assert.equal((await site.call('POST', `get-started/done?shop=${other}`, { token, body: { shop: other } })).status, 200);
    assert.equal(await shouldShowGetStarted(shop), false);
    assert.equal(await shouldShowGetStarted(other), true, 'the other shop is untouched');
    assert.equal((await site.call('GET', 'meta', { token })).json.program.showGetStarted, false);
    delete process.env.SHOPIFY_API_KEY;
  });
});

describe('Get started: the page', () => {
  const data = (over = {}) => ({
    shop: 'acme.myshopify.com', done: false, doneAt: null, ordersSeen: 0, note: 'Links open the theme editor.',
    steps: [
      { id: 'program', title: 'Ready <b>', text: 'Runs in INR', state: 'done', links: [{ id: 'rules', label: 'Review the rules', kind: 'console', target: 'rules' }] },
      { id: 'embed', title: 'Turn on', text: 'Switch it on', state: 'manual', links: [{ id: 'activateEmbed', label: 'Open the theme editor', kind: 'external', url: 'https://acme.myshopify.com/admin/themes/current/editor?context=apps' }] },
    ],
    ...over,
  });

  test('renders the steps in an ordered list with escaped text, buttons and no link addresses in the markup', () => {
    const html = String(renderStart(data()));
    assert.match(html, /<ol class="gs-steps">/);
    assert.equal((html.match(/<li class="card gs-step/g) || []).length, 2);
    assert.ok(!html.includes('<b>') && html.includes('Ready &lt;b&gt;'));
    assert.ok(!/href=|https:\/\//.test(html), 'no address in the markup');
    assert.match(html, /data-act="gs-open" data-v="embed\.activateEmbed"/);
    assert.match(html, /data-act="gs-go" data-v="rules"/);
    assert.match(html, /data-act="gs-done"/);
    assert.match(html, /Done<\/span>/);
    assert.match(String(renderStart(data({ done: true }))), /Marked done/);
    assert.ok(!/data-act="gs-done"/.test(String(renderStart(data({ done: true })))));
  });

  test('safeLink: https on the shop\'s own host only', () => {
    const host = 'acme.myshopify.com';
    assert.equal(safeLink('https://acme.myshopify.com/admin/pages/new', host), true);
    for (const bad of ['http://acme.myshopify.com/x', 'https://evil.com/x', 'https://acme.myshopify.com.evil.com/x', 'https://user:pw@acme.myshopify.com/x', 'javascript:alert(1)', '//acme.myshopify.com/x', 'acme.myshopify.com', '', null, undefined]) assert.equal(safeLink(bad, host), false, String(bad));
    assert.equal(safeLink('https://acme.myshopify.com/x', null), false);
  });

  test('a click opens a new tab for a safe link and does nothing for any other; the done and go actions call the right things', async () => {
    const opened = [];
    globalThis.window = { open: (...a) => opened.push(a) };
    try {
      renderStart(data());
      startPage.act['gs-open']({ dataset: { v: 'embed.activateEmbed' } });
      startPage.act['gs-open']({ dataset: { v: 'nope.nothing' } });
      assert.equal(opened.length, 1);
      assert.deepEqual(opened[0], ['https://acme.myshopify.com/admin/themes/current/editor?context=apps', '_blank', 'noopener,noreferrer']);
      renderStart(data({ shop: 'other.myshopify.com' })); // links for another shop are not opened
      startPage.act['gs-open']({ dataset: { v: 'embed.activateEmbed' } });
      assert.equal(opened.length, 1);
      const went = [];
      startPage.act['gs-go']({ dataset: { v: 'rules' } }, { go: (p) => went.push(p) });
      assert.deepEqual(went, ['rules']);
      const calls = [];
      await startPage.act['gs-done']({}, { api: { post: async (p) => { calls.push(p); return { ok: true, data: {} }; } }, toast() {}, refreshProgram: async () => calls.push('refresh'), rerender: async () => calls.push('rerender') });
      assert.deepEqual(calls, ['get-started/done', 'refresh', 'rerender']);
    } finally { delete globalThis.window; }
  });

  test('"Get started" is the first page of the console, and its text names no one', () => {
    assert.equal(PAGES[0].key, 'start');
    assert.ok(!/ecofynd/i.test(readFileSync(new URL('../../web/admin/public/pages/start.js', import.meta.url), 'utf8')));
  });
});

describe('Which page the console opens on', () => {
  test('a new shop opens on Get started; a page named in the address always wins; anything else is the Overview', async () => {
    const { pickRoute } = await import('../../web/admin/public/route.js');
    const keys = PAGES.map((p) => p.key);
    assert.deepEqual(pickRoute('', { showGetStarted: true }, keys), { key: 'start', param: null });
    assert.deepEqual(pickRoute('', { showGetStarted: false }, keys), { key: 'overview', param: null });
    assert.deepEqual(pickRoute('', null, keys), { key: 'overview', param: null });
    assert.deepEqual(pickRoute('#/customers/123', { showGetStarted: true }, keys), { key: 'customers', param: '123' });
    assert.deepEqual(pickRoute('#/rules', { showGetStarted: true }, keys), { key: 'rules', param: null });
    assert.deepEqual(pickRoute('#/nonsense', { showGetStarted: true }, keys), { key: 'overview', param: null });
    assert.deepEqual(pickRoute('#/data/a%20b', null, keys), { key: 'data', param: 'a b' });
    assert.deepEqual(pickRoute('', { showGetStarted: true }, ['overview']), { key: 'overview', param: null });
  });
});
