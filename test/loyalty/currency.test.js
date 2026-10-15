// test/loyalty/currency.test.js
//
// Every amount label follows the shop's configured currency, never a literal rupee sign.
//   A. the symbol and money formatting (pure), and the three copies of the logic agree: server, admin console, storefront;
//   B. the same scenario on an INR shop and a USD shop: discount title, ledger note, notifications, the storefront
//      view and page, the admin API and every admin page that shows money: INR shows ₹ and no $, USD shows $ and no ₹.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { prisma } from '../../web/lib/prisma.js';
import { currencySymbol, formatMoney, normalizeCurrency } from '../../web/loyalty/rules/currency.js';
import { formatPaise } from '../../web/loyalty/rules/money.js';
import { money as adminMoney, currencySymbol as adminSymbol } from '../../web/admin/public/format.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import { activateDueLots } from '../../web/loyalty/service/jobs.js';
import { redeem } from '../../web/loyalty/service/redemption.js';
import { customerView } from '../../web/loyalty/service/storefront.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { restoreClock } from '../../web/loyalty/adapters/clock.js';
import { startConsole, adminBrowser } from '../helpers/admin-http.js';
import { uniqueId } from '../helpers/ids.js';
import { renderOverview } from '../../web/admin/public/pages/overview.js';
import { renderCustomers } from '../../web/admin/public/pages/customers.js';
import { renderOrders } from '../../web/admin/public/pages/orders.js';
import { renderRules, renderEdit, renderReview } from '../../web/admin/public/pages/rules.js';

const CLIENT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions', 'rewards-widget', 'assets', 'rewards-client.js'), 'utf8');

/** The storefront script in a sandbox, as the theme loads it (see storefront-render.test.js). */
function storefront() {
  class Node {
    constructor(tag) { this.tagName = tag; this.className = ''; this.children = []; this.attrs = {}; this.style = {}; this.listeners = {}; this._text = ''; }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; }
    get firstChild() { return this.children[0] ?? null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener() {}
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text; }
    set innerHTML(_v) { throw new Error('innerHTML must never be set'); }
  }
  const sandbox = {
    document: { createElement: (t) => new Node(t), createElementNS: (ns, t) => new Node(t), createTextNode: (t) => { const n = new Node('#text'); n._text = t; return n; } },
    navigator: {}, fetch: () => Promise.reject(new Error('no network')), crypto: { randomUUID: () => 'k' }, setTimeout: () => 0, Math, Date, JSON, String, Number, isNaN, isFinite, Promise,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(CLIENT, sandbox);
  const text = (n) => [n._text, ...n.children.map(text)].join(' ');
  return { api: sandbox.window.EcoRewards, text, Node };
}

describe('currency: the symbol and the formatting (pure)', () => {
  test('the symbol comes from the configured ISO code', () => {
    const expected = { INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'AED ', CAD: 'CA$', AUD: 'A$', CHF: 'CHF ' };
    for (const [code, sym] of Object.entries(expected)) assert.equal(currencySymbol(code), sym, code);
    assert.equal(currencySymbol('inr'), '₹');
    assert.equal(currencySymbol(' usd '), '$');
  });

  test('a missing or malformed code gives NO symbol: never an assumed rupee', () => {
    for (const bad of [undefined, null, '', ' ', 'XX', 'RUPEE', 'US$', 5, {}, 'İNR']) assert.equal(currencySymbol(bad), '', String(bad));
    assert.equal(formatMoney(10, undefined), '10');
    assert.equal(formatPaise(1000, undefined), '10.00');
    assert.equal(normalizeCurrency('inr'), 'INR');
    assert.equal(normalizeCurrency('x'), null);
  });

  test('formatMoney: whole amounts drop decimals, grouping follows the currency, negatives lead with the sign', () => {
    assert.equal(formatMoney(10, 'INR'), '₹10');
    assert.equal(formatMoney('10.50', 'INR'), '₹10.50');
    assert.equal(formatMoney(100000, 'INR'), '₹1,00,000');
    assert.equal(formatMoney(100000, 'USD'), '$100,000');
    assert.equal(formatMoney(1349.91, 'USD'), '$1,349.91');
    assert.equal(formatMoney(-5, 'USD'), '-$5');
    assert.equal(formatMoney(-5.5, 'AED'), '-AED 5.50');
    assert.equal(formatMoney('abc', 'USD'), '');
  });

  test('formatPaise: always two decimals, the shop symbol (the discount title and the ledger note use it)', () => {
    assert.equal(formatPaise(5000, 'INR'), '₹50.00');
    assert.equal(formatPaise(5000, 'USD'), '$50.00');
    assert.equal(formatPaise(5000, 'EUR'), '€50.00');
    assert.equal(formatPaise(5000, 'AED'), 'AED 50.00');
    assert.equal(formatPaise(-1000, 'USD'), '-$10.00');
  });

  test('the three copies agree: server, admin console, storefront', () => {
    const { api } = storefront();
    const codes = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'CAD', 'AUD', 'CHF', 'inr', undefined, '', 'XX'];
    const values = ['0', '10', '10.5', '10.50', '1349.91', '100000', '-5', '-5.25', '999999.99'];
    for (const code of codes) {
      assert.equal(adminSymbol(code), currencySymbol(code), `admin symbol ${code}`);
      assert.equal(api.currencySymbol(code), currencySymbol(code), `storefront symbol ${code}`);
      for (const value of values) {
        assert.equal(adminMoney(value, code), formatMoney(value, code), `admin ${value} ${code}`);
        assert.equal(api.money(value, code), formatMoney(value, code), `storefront ${value} ${code}`);
      }
    }
    assert.equal(adminMoney('abc', 'USD'), '—');
    assert.equal(api.money('abc', 'USD'), '');
  });
});

describe('currency: the same scenario on an INR shop and a USD shop', () => {
  let site;
  let savedShop;
  const runs = {};

  before(async () => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
    savedShop = process.env.ADMIN_SHOP;
    site = await startConsole();
    for (const code of ['INR', 'USD']) runs[code] = await scenario(code);
  });
  after(async () => {
    await site.close();
    restoreClock();
    if (savedShop === undefined) delete process.env.ADMIN_SHOP; else process.env.ADMIN_SHOP = savedShop;
    await prisma.$disconnect();
  });

  /** Earn 500 points (hold 0), activate them, redeem them for one 50.00 code. Returns everything the checks need. */
  async function scenario(code) {
    const shop = `cur-${code.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    await prisma.loyaltyConfig.create({
      data: { shop, spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, rewardExpiryDays: 90, currency: code, holdPeriodDays: 0, ledgerStartAt: new Date('2026-01-01T00:00:00Z') },
    });
    const gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
    const orderId = uniqueId();
    const processedAt = new Date().toISOString();
    await storeWebhook({
      shop, topic: 'orders/paid', shopifyWebhookId: crypto.randomUUID(),
      payload: { id: orderId, name: '#1042', customer: { id: '555000111' }, processed_at: processedAt, taxes_included: false, line_items: [{ id: 1, quantity: 1, price: '500.00', title: 'Item', gift_card: false, discount_allocations: [], tax_lines: [] }], discount_codes: [] },
    });
    await processPendingWebhooks({ shop });
    gw.addOrder({ id: orderId, processed_at: processedAt, refunds: [] });
    await activateDueLots({ shop });
    const redeemed = await redeem({ shop, shopifyCustomerId: '555000111', idempotencyKey: crypto.randomUUID() });
    assert.equal(redeemed.ok, true, `redeem worked: ${JSON.stringify(redeemed).slice(0, 160)}`);

    process.env.ADMIN_SHOP = shop;
    const admin = await adminBrowser(site.url, shop);
    return { shop, gw, admin, view: await customerView({ shop, shopifyCustomerId: '555000111' }) };
  }

  const SIGNS = { INR: ['₹', '$'], USD: ['$', '₹'] };
  const mustHave = (code, html, what) => {
    const [yes, no] = SIGNS[code];
    assert.ok(String(html).includes(yes), `${what}: has ${yes} for ${code}`);
    assert.ok(!String(html).includes(no), `${what}: no ${no} for ${code}`);
  };

  for (const code of ['INR', 'USD']) {
    describe(`${code} shop`, () => {
      test('the Shopify discount title and the ledger note carry the shop symbol', async () => {
        const { shop, gw } = runs[code];
        const discount = [...gw.discounts.values()][0];
        const sym = code === 'INR' ? '₹' : '$';
        assert.equal(discount.title, `Reward Points — ${sym}50.00 off`);
        mustHave(code, discount.title, 'discount title');
        const entry = await prisma.ledgerEntry.findFirst({ where: { account: { shop }, type: 'redemption' } });
        assert.equal(entry.note, `Redeemed ${sym}50.00 reward`);
      });

      test('notifications read in the shop currency', () => {
        const { view } = runs[code];
        const sym = code === 'INR' ? '₹' : '$';
        const texts = view.notifications.items.map((n) => n.text);
        assert.ok(texts.includes(`Your ${sym}50 reward is ready to use (500 points)`), texts.join(' | '));
        mustHave(code, texts.join(' '), 'notifications');
      });

      test('the storefront view names the currency and the Rewards page and widget draw it', () => {
        const { view } = runs[code];
        assert.equal(view.rule.currency, code);
        const { api, text, Node } = storefront();
        const page = new Node('div');
        api.renderRewardsPage(page, view, { onRedeem() {}, onCopy() {}, shopUrl: '/collections/all' });
        mustHave(code, text(page), 'Rewards page');
        const panel = new Node('div');
        api.renderWidgetPanel(panel, view, { shopUrl: '/collections/all', pageUrl: '/pages/rewards', loginUrl: '/account/login' });
        mustHave(code, text(panel), 'widget panel');
      });

      test('the admin API and every admin page that shows money', async () => {
        const { admin } = runs[code];
        const overview = (await admin.get('overview')).json;
        assert.equal(overview.rule.currency, code);
        mustHave(code, renderOverview(overview), 'Overview');

        const customers = (await admin.get('customers?query=555000111')).json;
        const detail = (await admin.get('customers/555000111')).json;
        const meta = (await admin.get('meta')).json.adjust;
        assert.equal(detail.rule.currency, code);
        mustHave(code, renderCustomers({ list: customers, detail, meta, selected: '555000111' }), 'Customers');

        const orders = (await admin.get('orders')).json;
        assert.equal(orders.currency, code, 'the orders API names the shop currency');
        assert.ok(orders.orders.length > 0);
        mustHave(code, renderOrders({ orders: orders.orders, events: [], attention: [], counts: {}, status: 'all', ordersNext: null, eventsNext: null, currency: orders.currency }), 'Orders');

        const rules = (await admin.get('rules')).json;
        mustHave(code, renderRules(rules), 'Rules');
        mustHave(code, renderEdit(rules, null, null), 'Rules edit form');
        const preview = (await admin.post('rules/preview', { changes: { rewardValue: '12.50' } })).json;
        mustHave(code, renderReview(rules, { ...preview, payload: {} }, null), 'Rules review');
      });

      test('a rule change is audited with the shop symbol on money values', async () => {
        const { admin } = runs[code];
        const form = (await admin.get('rules')).json.program.updatedAt;
        const saved = await admin.post('rules', { expected: form, changes: { spend: '2.00' } });
        assert.equal(saved.status, 200, saved.text);
        const sym = code === 'INR' ? '₹' : '$';
        const entry = (await admin.get('audit?action=rules_changed')).json.entries[0];
        assert.equal(entry.previous, `Spend: ${sym}1.00`);
        assert.equal(entry.next, `Spend: ${sym}2.00`);
      });
    });
  }

  test('no source file the customer or the admin sees contains a literal rupee sign outside comments and the legacy settings page', () => {
    for (const rel of ['web/admin/public/format.js', 'web/admin/public/pages/rules.js', 'web/admin/public/pages/overview.js', 'web/admin/public/pages/customers.js', 'web/admin/public/pages/orders.js', 'web/admin/public/pages/notifications.js', 'web/admin/public/pages/index.js', 'web/loyalty/service/notifications.js', 'web/loyalty/service/redemption.js', 'web/loyalty/service/storefront.js', 'extensions/rewards-widget/assets/rewards-client.js', 'extensions/rewards-widget/blocks/rewards-widget.liquid', 'extensions/rewards-widget/blocks/rewards-page.liquid']) {
      const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', rel), 'utf8');
      const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      assert.ok(!code.includes('₹'), `${rel} has a literal rupee sign`);
    }
  });
});
