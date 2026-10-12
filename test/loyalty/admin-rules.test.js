// test/loyalty/admin-rules.test.js
//
// Admin console, Rules (read only) and the navigation: the shop's rule field by field, the whitelist, and the
// "not available in this version" pages for what the design has and this build does not.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { prisma } from '../../web/lib/prisma.js';
import { startConsole, adminBrowser, allKeys } from '../helpers/admin-http.js';
import { renderRules } from '../../web/admin/public/pages/rules.js';
import { PAGES } from '../../web/admin/public/pages/index.js';

describe('Admin rules and navigation', () => {
  let site;
  let shop;
  let admin;
  let savedShop;

  before(async () => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
    savedShop = process.env.ADMIN_SHOP;
    site = await startConsole();
  });
  after(async () => {
    await site.close();
    if (savedShop === undefined) delete process.env.ADMIN_SHOP; else process.env.ADMIN_SHOP = savedShop;
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    shop = `rules-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    process.env.ADMIN_SHOP = shop;
    await prisma.loyaltyConfig.create({
      data: {
        shop, spendAmountPaise: 10000, pointsPerUnit: 100, pointsRounding: 'floor', earnBasis: 'after_discount', taxHandling: 'inclusive',
        shippingEarning: false, excludeGiftCards: true, excludedCollectionIds: ['900001', '900002'], pointsPerReward: 100, rewardValue: 1000,
        currency: 'INR', rewardExpiryDays: 90, holdPeriodDays: 30, restoreRewardOnFullRefund: true, returnPointsOnCodeExpiry: false,
        ledgerStartAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    admin = await adminBrowser(site.url, shop);
  });

  test('the rule field by field, money as decimal strings', async () => {
    const r = await admin.get('rules');
    assert.strictEqual(r.status, 200, r.text);
    const d = r.json;
    assert.deepStrictEqual(d.earn, { spend: '100.00', points: 100, rounding: 'floor', basis: 'after_discount', taxHandling: 'inclusive', includeShipping: false, excludeGiftCards: true, excludedCollectionIds: ['900001', '900002'] });
    assert.deepStrictEqual(d.redeem, { pointsPerReward: 100, rewardValue: '10.00', currency: 'INR', codeValidDays: 90, holdPeriodDays: 30 });
    assert.deepStrictEqual(d.returns, { shortfallPolicy: 'owe_only', restoreRewardOnFullRefund: true, returnPointsOnCodeExpiry: false });
    assert.deepStrictEqual([d.program.campaignEnabled, d.program.expiryEnabled, d.program.ledgerStartAt], [false, false, '2026-10-01T00:00:00.000Z']);
  });

  test('a whitelist: no shop, no ids, no sync counters; read only (there is no write endpoint)', async () => {
    const r = await admin.get('rules');
    const keys = allKeys(r.json);
    for (const bad of ['id', 'shop', 'ruleSeq', 'ruleSyncedSeq', 'createdAt', 'earnMode']) assert.ok(!keys.has(bad), `no "${bad}"`);
    assert.ok(!r.text.includes(shop));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const w = await admin.req(method, 'rules', { pointsPerReward: 1 });
      assert.strictEqual(w.status, 404, `${method} /rules`);
    }
    assert.strictEqual((await prisma.loyaltyConfig.findUnique({ where: { shop } })).pointsPerReward, 100);
  });

  test('a shop with no rule says so; it needs a session and an open console', async () => {
    const none = `rules-none-${Date.now()}.myshopify.com`;
    process.env.ADMIN_SHOP = none;
    const b = await adminBrowser(site.url, none);
    assert.deepStrictEqual((await b.get('rules')).json, { ok: true, configured: false });
    process.env.ADMIN_SHOP = shop;
    assert.strictEqual((await fetch(`${site.url}/api/rules`)).status, 401);
    const forced = await adminBrowser(site.url, shop, { mustChange: true });
    assert.strictEqual((await forced.get('rules')).status, 403);
  });

  test('the page shows the rules in words, says it is read only, and what is not available', async () => {
    const html = String((renderRules((await admin.get('rules')).json)));
    for (const text of ['100 points per ₹100', 'Proportional, round down', 'Product value after discounts', 'tax is taken out', '100 points = ₹10', '30 days', '90 days', '900001, 900002', 'not applied when points are earned', 'read only', 'reward catalogue']) assert.ok(html.includes(text), `has ${text}`);
    assert.ok(!/\sstyle=/.test(html));
    assert.match(String(renderRules({ configured: false })), /no loyalty rule/);
  });

  test('hostile values in the rule are escaped', () => {
    const base = { configured: true, earn: { spend: '1.00', points: 1, rounding: '<b>x</b>', basis: 'after_discount', taxHandling: 'exclusive', includeShipping: false, excludeGiftCards: true, excludedCollectionIds: ['<script>alert(1)</script>'] },
      redeem: { pointsPerReward: 1, rewardValue: '1.00', currency: 'INR', codeValidDays: 1, holdPeriodDays: 1 }, returns: { shortfallPolicy: '<i>y</i>', restoreRewardOnFullRefund: false, returnPointsOnCodeExpiry: false },
      program: { campaignEnabled: true, expiryEnabled: false, ledgerStartAt: null, updatedAt: null } };
    const html = String(renderRules(base));
    assert.ok(!html.includes('<script>alert(1)') && !html.includes('<b>x</b>') && !html.includes('<i>y</i>'));
    assert.match(html, /a flag is set in the database but nothing uses it/);
  });

  test('the navigation follows the design; the pages the design has and this build lacks say so', async () => {
    assert.deepStrictEqual(PAGES.map((p) => p.key), ['overview', 'customers', 'orders', 'rules', 'rewards', 'recon', 'notify', 'audit', 'analytics']);
    assert.deepStrictEqual(PAGES.map((p) => p.label), ['Overview', 'Customers', 'Orders & webhooks', 'Earning & redemption', 'Reward catalogue', 'Reconciliation', 'Notifications', 'Audit log', 'Analytics events']);
    for (const key of ['rewards', 'analytics']) {
      const html = String(await PAGES.find((p) => p.key === key).page.render({}));
      assert.match(html, /Not available in this version/, key);
      assert.match(html, /UI-MAP\.md/, key);
    }
    for (const key of ['overview', 'customers', 'orders', 'rules', 'recon', 'audit', 'notify']) {
      assert.strictEqual(typeof PAGES.find((p) => p.key === key).page.render, 'function');
      assert.ok(!/Not available in this version/.test(String(PAGES.find((p) => p.key === key).page.render.toString())), `${key} is a real page`);
    }
  });
});
