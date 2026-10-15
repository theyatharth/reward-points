// test/loyalty/admin-rules-edit.test.js
//
// Rule editing in the admin console: validation (pure and over HTTP), preview writes nothing, a save writes the rule
// and ONE audit row with the previous and new value of every changed field, a stale form is refused, two saves racing
// on the same form let exactly one win, locked fields cannot be reached, and an edited rule is what the next order uses.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { startConsole, adminBrowser } from '../helpers/admin-http.js';
import { planChange, FIELDS } from '../../web/admin/data/rules.js';
import { describe as describeAudit } from '../../web/admin/data/audit.js';
import { renderEdit, renderReview, readForm, changedFields, currentValues } from '../../web/admin/public/pages/rules.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { uniqueId } from '../helpers/ids.js';

const BASE = {
  spendAmountPaise: 10000, pointsPerUnit: 100, pointsRounding: 'floor', earnBasis: 'after_discount', taxHandling: 'inclusive', shippingEarning: false,
  excludeGiftCards: true, excludedCollectionIds: ['900001'], pointsPerReward: 100, rewardValue: 1000, currency: 'INR', rewardExpiryDays: 90,
  holdPeriodDays: 30, restoreRewardOnFullRefund: true, returnPointsOnCodeExpiry: false, shortfallPolicy: 'owe_only', ledgerStartAt: new Date('2026-01-01T00:00:00Z'),
};

describe('Admin rule editing', () => {
  let site;
  let shop;
  let admin;
  let savedShop;
  let current;

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
    shop = `rules-edit-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    process.env.ADMIN_SHOP = shop;
    current = await prisma.loyaltyConfig.create({ data: { shop, ...BASE } });
    admin = await adminBrowser(site.url, shop);
  });

  const row = () => prisma.loyaltyConfig.findUnique({ where: { shop } });
  const audits = () => prisma.auditLog.findMany({ where: { shop, action: 'rules_changed' }, orderBy: { createdAt: 'asc' } });
  const expected = async () => (await admin.get('rules')).json.program.updatedAt;
  const save = async (changes, over = {}) => admin.post('rules', { expected: await expected(), changes, ...over });

  describe('planChange (pure)', () => {
    const bad = (changes, field) => {
      const r = planChange(current, changes);
      assert.strictEqual(r.ok, false, JSON.stringify(changes));
      assert.strictEqual(r.status, 400);
      if (field) assert.strictEqual(r.body.field, field);
      return r;
    };

    test('the earn rate: money as a decimal string, points as an integer', () => {
      const r = planChange(current, { spend: '50.50', points: 25 });
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.incoming, { spendAmountPaise: 5050, pointsPerUnit: 25 });
      assert.deepStrictEqual(r.changes.map((c) => [c.field, c.previous, c.next]), [['spend', '100.00', '50.50'], ['points', 100, 25]]);
    });

    test('values equal to the current ones are not changes', () => {
      assert.deepStrictEqual(planChange(current, { spend: '100', points: 100, rounding: 'floor' }).changes, []);
    });

    test('holding days 0 to 365 only; whole numbers only', () => {
      assert.strictEqual(planChange(current, { holdPeriodDays: 0 }).ok, true);
      assert.strictEqual(planChange(current, { holdPeriodDays: 365 }).ok, true);
      bad({ holdPeriodDays: -1 }, 'holdPeriodDays');
      bad({ holdPeriodDays: 366 }, 'holdPeriodDays');
      bad({ holdPeriodDays: 1.5 }, 'holdPeriodDays');
      bad({ holdPeriodDays: '7' }, 'holdPeriodDays');
      bad({ holdPeriodDays: null }, 'holdPeriodDays');
    });

    test('money: no zero, no negative, no more than two decimals, no exponent, no junk', () => {
      for (const v of ['0', '0.00', '-5', '5.123', '1e3', 'abc', '', ' ', '1,000', 100, null, '1000000.01']) bad({ spend: v }, 'spend');
      for (const v of ['0', '-1', 'x', 10]) bad({ rewardValue: v }, 'rewardValue');
      assert.strictEqual(planChange(current, { spend: ' 12.5 ' }).incoming.spendAmountPaise, 1250);
    });

    test('points, points per reward and code validity: positive whole numbers within limits', () => {
      for (const k of ['points', 'pointsPerReward', 'codeValidDays']) {
        bad({ [k]: 0 }, k);
        bad({ [k]: -3 }, k);
        bad({ [k]: 2.5 }, k);
        bad({ [k]: 10 ** 9 }, k);
      }
      bad({ codeValidDays: 366 }, 'codeValidDays');
    });

    test('options and switches: only the listed values, only real booleans', () => {
      bad({ rounding: 'ceil' }, 'rounding');
      bad({ basis: 'x' }, 'basis');
      bad({ taxHandling: 1 }, 'taxHandling');
      for (const k of ['includeShipping', 'excludeGiftCards', 'returnPointsOnCodeExpiry', 'restoreRewardOnFullRefund']) { bad({ [k]: 'true' }, k); bad({ [k]: 1 }, k); }
      assert.strictEqual(planChange(current, { rounding: 'block', basis: 'before_discount', taxHandling: 'exclusive', includeShipping: true, excludeGiftCards: false }).ok, true);
    });

    test('anything that is not an editable field is refused by name (locked fields cannot be reached)', () => {
      for (const k of ['currency', 'shortfallPolicy', 'campaignEnabled', 'expiryEnabled', 'ledgerStartAt', 'excludedCollectionIds', 'earnMode', 'id', 'shop', 'ruleSeq', 'spendAmountPaise', 'pointsPerUnit', '__proto__', 'constructor']) {
        const r = planChange(current, JSON.parse(`{"${k}": 1}`));
        assert.strictEqual(r.ok, false, k);
        assert.strictEqual(r.body.error, 'UNKNOWN_FIELD', k);
      }
      for (const v of [null, [], 'x', 5]) assert.strictEqual(planChange(current, v).ok, false);
    });

    test('a very generous rule needs an acknowledgement; a zero hold period is an information note', () => {
      assert.strictEqual(planChange(current, { rewardValue: '10' }).warnings.length, 0, '10% back is the current rule');
      const rich = planChange(current, { rewardValue: '500' });
      assert.strictEqual(rich.warnings.length, 1);
      assert.match(rich.warnings[0], /\d+% of what they spend/);
      const hold0 = planChange(current, { holdPeriodDays: 0 });
      assert.strictEqual(hold0.warnings.length, 0);
      assert.ok(hold0.notes.some((n) => /no holding period/i.test(n)));
    });

    test('every editable field is covered by the form reader', () => {
      const d = { earn: { spend: '1.00', points: 1, rounding: 'floor', basis: 'after_discount', taxHandling: 'exclusive', includeShipping: false, excludeGiftCards: true }, redeem: { pointsPerReward: 1, rewardValue: '1.00', holdPeriodDays: 1, codeValidDays: 1 }, returns: { restoreRewardOnFullRefund: true, returnPointsOnCodeExpiry: false } };
      assert.deepStrictEqual(Object.keys(currentValues(d)).sort(), Object.keys(FIELDS).sort());
    });
  });

  describe('over HTTP', () => {
    test('GET /rules carries the limits and options the form uses, still without ids or the shop', async () => {
      const r = await admin.get('rules');
      assert.deepStrictEqual(r.json.limits.holdPeriodDays, { min: 0, max: 365 });
      assert.deepStrictEqual(r.json.options.rounding, ['floor', 'round', 'block']);
      assert.ok(!r.text.includes(shop));
    });

    test('preview shows the diff and writes nothing (no row change, no audit row)', async () => {
      const before = await row();
      const r = await admin.post('rules/preview', { changes: { holdPeriodDays: 7, rounding: 'block' } });
      assert.strictEqual(r.status, 200, r.text);
      assert.deepStrictEqual(r.json.changes.map((c) => [c.field, c.previous, c.next]), [['rounding', 'floor', 'block'], ['holdPeriodDays', 30, 7]]);
      assert.deepStrictEqual((await row()).updatedAt, before.updatedAt);
      assert.strictEqual((await row()).holdPeriodDays, 30);
      assert.strictEqual((await audits()).length, 0);
    });

    test('a save changes the rule and writes ONE audit row with previous and new values', async () => {
      const r = await save({ holdPeriodDays: 0, spend: '200', points: 50, includeShipping: true, rewardValue: '12.50' });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.changed, 5);
      const c = await row();
      assert.deepStrictEqual([c.holdPeriodDays, c.spendAmountPaise, c.pointsPerUnit, c.shippingEarning, c.rewardValue], [0, 20000, 50, true, 1250]);
      // untouched fields stay
      assert.deepStrictEqual([c.currency, c.shortfallPolicy, c.campaignEnabled, c.expiryEnabled, c.excludedCollectionIds, c.ledgerStartAt.toISOString()], ['INR', 'owe_only', false, false, ['900001'], '2026-01-01T00:00:00.000Z']);

      const a = await audits();
      assert.strictEqual(a.length, 1);
      assert.strictEqual(a[0].adminId, admin.admin.id);
      const byField = Object.fromEntries(a[0].detail.changes.map((x) => [x.field, [x.previous, x.next]]));
      assert.deepStrictEqual(byField, { holdPeriodDays: [30, 0], spend: ['100.00', '200.00'], points: [100, 50], includeShipping: [false, true], rewardValue: ['10.00', '12.50'] });
    });

    test('the audit page shows the change: who, previous, new', async () => {
      await save({ holdPeriodDays: 5 });
      const r = await admin.get('audit?action=rules_changed');
      assert.strictEqual(r.status, 200, r.text);
      const e = r.json.entries[0];
      assert.strictEqual(e.admin, admin.email);
      assert.strictEqual(e.previous, 'Holding period (days): 30');
      assert.strictEqual(e.next, 'Holding period (days): 5');
      assert.match(e.reason, /Rules changed \(1 field\)/);
      assert.deepStrictEqual(describeAudit('rules_changed', { changes: [{ label: 'X', previous: true, next: false }] }).previous, 'X: yes');
      assert.deepStrictEqual(describeAudit('rules_changed', 'garbage').previous, '—');
    });

    test('an invalid change is refused with the field named; nothing is written', async () => {
      for (const changes of [{ holdPeriodDays: 400 }, { spend: '0' }, { rounding: 'nope' }, { currency: 'USD' }, { spend: '10', points: 0 }]) {
        const r = await save(changes);
        assert.strictEqual(r.status, 400, JSON.stringify(changes));
        assert.ok(r.json.field && r.json.message, 'names the field');
      }
      assert.deepStrictEqual((({ holdPeriodDays, spendAmountPaise, pointsPerUnit, currency }) => ({ holdPeriodDays, spendAmountPaise, pointsPerUnit, currency }))(await row()), { holdPeriodDays: 30, spendAmountPaise: 10000, pointsPerUnit: 100, currency: 'INR' });
      assert.strictEqual((await audits()).length, 0);
    });

    test('a ₹0 spend (the client\'s invalid-rule test) is refused and the live rule is unchanged', async () => {
      const r = await save({ spend: '0' });
      assert.strictEqual(r.status, 400);
      assert.strictEqual((await row()).spendAmountPaise, 10000);
    });

    test('a stale form is refused (someone else saved first); nothing is overwritten', async () => {
      const form = await expected();
      assert.strictEqual((await admin.post('rules', { expected: form, changes: { holdPeriodDays: 3 } })).status, 200);
      const r = await admin.post('rules', { expected: form, changes: { codeValidDays: 10 } });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.error, 'STALE_RULES');
      assert.strictEqual((await row()).rewardExpiryDays, 90);
      assert.strictEqual((await audits()).length, 1);
    });

    test('saving the same thing twice is harmless: the second is a no-op without an audit row', async () => {
      const form = await expected();
      assert.strictEqual((await admin.post('rules', { expected: form, changes: { holdPeriodDays: 3 } })).json.changed, 1);
      const again = await admin.post('rules', { expected: form, changes: { holdPeriodDays: 3 } });
      assert.strictEqual(again.status, 200);
      assert.strictEqual(again.json.changed, 0);
      assert.strictEqual((await audits()).length, 1);
    });

    test('two saves racing on the same form: exactly one wins, the other is told it is stale', async () => {
      const form = await expected();
      const [a, b] = await Promise.all([
        admin.post('rules', { expected: form, changes: { holdPeriodDays: 4 } }),
        admin.post('rules', { expected: form, changes: { codeValidDays: 11 } }),
      ]);
      assert.deepStrictEqual([a.status, b.status].sort(), [200, 409]);
      const c = await row();
      assert.strictEqual((c.holdPeriodDays === 4) !== (c.rewardExpiryDays === 11), true, 'only one of the two changes was applied');
      assert.strictEqual((await audits()).length, 1);
    });

    test('a generous rule is refused until the warning is acknowledged', async () => {
      const first = await save({ rewardValue: '500' });
      assert.strictEqual(first.status, 409);
      assert.strictEqual(first.json.error, 'WARNINGS_NOT_ACKNOWLEDGED');
      assert.strictEqual((await row()).rewardValue, 1000);
      const second = await save({ rewardValue: '500' }, { acknowledgeWarnings: true });
      assert.strictEqual(second.status, 200);
      assert.strictEqual((await row()).rewardValue, 50000);
      assert.strictEqual((await audits())[0].detail.warningsAcknowledged, true);
    });

    test('a malformed request is refused, not a crash', async () => {
      for (const body of [{}, { expected: 'not a date', changes: {} }, { expected: 5, changes: {} }, { changes: { holdPeriodDays: 1 } }]) {
        const r = await admin.post('rules', body);
        assert.strictEqual(r.status, 400, JSON.stringify(body));
      }
      assert.strictEqual((await admin.post('rules', { expected: await expected(), changes: [] })).status, 400);
    });

    test('a write needs the CSRF token and a JSON body, and a finished password change', async () => {
      const noCsrf = await admin.req('POST', 'rules', { expected: await expected(), changes: { holdPeriodDays: 1 } }, { 'X-CSRF-Token': 'wrong' });
      assert.strictEqual(noCsrf.status, 403);
      const forced = await adminBrowser(site.url, shop, { mustChange: true });
      assert.strictEqual((await forced.post('rules', { expected: 'x', changes: {} })).status, 403);
      assert.strictEqual((await row()).holdPeriodDays, 30);
    });

    test('changing the redemption rule marks the shop rule for the storefront metafield sync', async () => {
      const before = (await row()).ruleSeq;
      await save({ holdPeriodDays: 2 });
      assert.ok((await row()).ruleSeq > before);
    });

    test('the next order uses the edited rule (earn rate and holding period)', async () => {
      await save({ points: 50, holdPeriodDays: 0 });
      const gw = new FakeShopifyGateway(shop);
      ledgerService.setGatewayFactory(() => gw);
      const orderId = uniqueId();
      const processedAt = new Date().toISOString();
      await storeWebhook({
        shop, topic: 'orders/paid', shopifyWebhookId: crypto.randomUUID(),
        payload: { id: orderId, name: '#1', customer: { id: 'u-edit' }, processed_at: processedAt, taxes_included: false, line_items: [{ id: 1, quantity: 1, price: '200.00', title: 'Item', gift_card: false, discount_allocations: [], tax_lines: [] }], discount_codes: [] },
      });
      await processPendingWebhooks({ shop });
      const lot = await prisma.pointLot.findFirst({ where: { account: { shop } } });
      assert.strictEqual(lot.originalPoints, 100, '200.00 at the edited rate of 50 points per 100.00');
      assert.strictEqual(lot.activatesAt.getTime(), new Date(processedAt).getTime(), 'hold 0: usable at the order time');
    });
  });

  describe('the page', () => {
    const d = () => ({
      configured: true,
      earn: { spend: '100.00', points: 100, rounding: 'floor', basis: 'after_discount', taxHandling: 'inclusive', includeShipping: false, excludeGiftCards: true, excludedCollectionIds: [] },
      redeem: { pointsPerReward: 100, rewardValue: '10.00', currency: 'INR', codeValidDays: 90, holdPeriodDays: 30 },
      returns: { shortfallPolicy: 'owe_only', restoreRewardOnFullRefund: true, returnPointsOnCodeExpiry: false },
      program: { campaignEnabled: false, expiryEnabled: false, ledgerStartAt: null, updatedAt: '2026-10-01T00:00:00.000Z' },
      limits: { points: { min: 1, max: 1000000 }, pointsPerReward: { min: 1, max: 1000000 }, holdPeriodDays: { min: 0, max: 365 }, codeValidDays: { min: 1, max: 365 } },
    });
    /** A form as the browser holds it: elements by name. */
    const form = (over = {}) => ({
      elements: Object.fromEntries(Object.entries({
        spend: { value: '100.00' }, rewardValue: { value: '10.00' }, points: { value: '100' }, pointsPerReward: { value: '100' }, holdPeriodDays: { value: '30' }, codeValidDays: { value: '90' },
        rounding: { value: 'floor' }, basis: { value: 'after_discount' }, taxHandling: { value: 'inclusive' },
        includeShipping: { checked: false }, giftCardsEarn: { checked: false }, returnPointsOnCodeExpiry: { checked: false }, restoreRewardOnFullRefund: { checked: true },
        ...over,
      })),
    });

    test('an untouched form changes nothing; an edit changes only that field', () => {
      const cur = currentValues(d());
      assert.deepStrictEqual(changedFields(readForm(form()), cur), {});
      assert.deepStrictEqual(changedFields(readForm(form({ holdPeriodDays: { value: '0' }, giftCardsEarn: { checked: true } })), cur), { holdPeriodDays: 0, excludeGiftCards: false });
      assert.deepStrictEqual(changedFields(readForm(form({ points: { value: '' } })), cur), { points: null });
    });

    test('the edit form has an input for every editable field, with the limits, and escapes hostile values', () => {
      const html = String(renderEdit(d(), null, null));
      for (const name of ['spend', 'points', 'rounding', 'basis', 'taxHandling', 'includeShipping', 'giftCardsEarn', 'pointsPerReward', 'rewardValue', 'holdPeriodDays', 'codeValidDays', 'restoreRewardOnFullRefund', 'returnPointsOnCodeExpiry']) assert.ok(html.includes(`name="${name}"`), name);
      assert.match(html, /name="holdPeriodDays"[^>]*min="0" max="365"|min="0" max="365"[^>]*name="holdPeriodDays"/);
      assert.match(html, /Spend \(₹\)/);
      const hostile = { ...currentValues(d()), spend: '"><script>alert(1)</script>' };
      const bad = String(renderEdit(d(), hostile, '<img src=x onerror=alert(1)>'));
      assert.ok(!bad.includes('<script>alert(1)') && !bad.includes('<img src=x'));
    });

    test('the review shows previous and new, the shop currency, and a tick box when there is a warning', () => {
      const review = { changes: [{ field: 'rewardValue', label: 'Reward value', previous: '10.00', next: '500.00' }, { field: 'includeShipping', label: 'Shipping earns points', previous: false, next: true }], warnings: ['These rules give customers back about 500%.'], notes: ['n'], expected: 'x', payload: {} };
      const html = String(renderReview(d(), review, null));
      for (const t of ['₹10', '₹500', 'Yes', 'No', 'name="ack"', 'Save rules']) assert.ok(html.includes(t), t);
      const none = String(renderReview(d(), { ...review, warnings: [] }, null));
      assert.ok(!none.includes('name="ack"'));
    });
  });
});
