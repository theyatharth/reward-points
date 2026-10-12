// test/loyalty/admin-reconciliation.test.js
//
// Admin console, Reconciliation: run on demand, the last stored result (whitelisted from JobRun.result), a drifted
// balance showing up without being repaired, and the page.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { storeWebhook, processPendingWebhooks } from '../../web/loyalty/service/webhook.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { startConsole, adminBrowser, allKeys } from '../helpers/admin-http.js';
import { uniqueId } from '../helpers/ids.js';
import { renderReconciliation } from '../../web/admin/public/pages/reconciliation.js';

describe('Admin reconciliation', () => {
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
    shop = `rec-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    process.env.ADMIN_SHOP = shop;
    ledgerService.setGatewayFactory(() => new FakeShopifyGateway(shop));
    await prisma.loyaltyConfig.create({ data: { shop, spendAmountPaise: 100, pointsPerUnit: 1, ledgerStartAt: new Date('2026-01-01T00:00:00Z') } });
    admin = await adminBrowser(site.url, shop);
  });

  const earn = async (customer, points) => {
    await storeWebhook({ shop, topic: 'orders/paid', shopifyWebhookId: crypto.randomUUID(),
      payload: { id: uniqueId(), customer: { id: customer }, processed_at: new Date().toISOString(), line_items: [{ id: 1, quantity: 1, price: String(points), title: 'x' }] } });
    await processPendingWebhooks({ shop });
  };

  test('before any run there is nothing to show; a run records and returns the result; GET shows the same', async () => {
    assert.deepStrictEqual((await admin.get('reconciliation')).json, { ok: true, last: null });
    await earn('1001', 300);
    await earn('1002', 200);

    const run = await admin.post('reconciliation/run', {});
    assert.strictEqual(run.status, 200, run.text);
    const last = run.json.last;
    assert.deepStrictEqual([last.status, last.trigger, last.accountsChecked, last.accountsWithDiscrepancies, last.discrepancyCount], ['completed', 'manual', 2, 0, 0]);
    assert.deepStrictEqual(last.byCode, {});
    assert.strictEqual(last.eventHealth.processed, 2);
    assert.ok(last.at);

    const again = (await admin.get('reconciliation')).json.last;
    assert.deepStrictEqual(again, last);
    const rows = await prisma.jobRun.findMany({ where: { shop, jobType: 'reconcile' } });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].result.repair, false, 'a run from the console only reports');
  });

  test('a drifted cached balance is reported with its customer, expected and found values, and is NOT repaired', async () => {
    await earn('1001', 300);
    await prisma.loyaltyAccount.updateMany({ where: { shop, shopifyCustomerId: '1001' }, data: { pending: 999 } });
    const { last } = (await admin.post('reconciliation/run', {})).json;
    assert.strictEqual(last.discrepancyCount, 2);
    assert.deepStrictEqual(last.byCode, { ledger_identity: 1, pending_mismatch: 1 });
    const pm = last.discrepancies.find((d) => d.code === 'pending_mismatch');
    assert.deepStrictEqual([pm.shopifyCustomerId, pm.expected, pm.found], ['1001', 300, 999]);
    assert.match(pm.help, /pending balance differs/);
    assert.strictEqual((await prisma.loyaltyAccount.findFirst({ where: { shop, shopifyCustomerId: '1001' } })).pending, 999, 'left alone');
    assert.strictEqual(await prisma.auditLog.count({ where: { shop, action: { startsWith: 'rebuild_cache' } } }), 0);
  });

  test('the last result is the newest run of this shop, whatever started it; stored values are whitelisted and bounded', async () => {
    await prisma.jobRun.create({ data: { shop, jobType: 'reconcile', status: 'completed', startedAt: new Date(Date.now() - 86400000), completedAt: new Date(Date.now() - 86400000), result: { trigger: 'nightly', accountsChecked: 1 } } });
    await prisma.jobRun.create({ data: { shop, jobType: 'reconcile', status: 'completed', startedAt: new Date(), completedAt: new Date(),
      result: { trigger: 'nightly', accountsChecked: 9, accountsWithDiscrepancies: 1, discrepancyCount: 1, byCode: { order_over_reversed: 1 }, secretField: 'LEAK', extra: { a: 1 },
        discrepancies: [{ shopifyCustomerId: '77', code: 'order_over_reversed', detail: 'x'.repeat(2000), expected: 5, found: 9, internalId: 'LEAK' }, 'junk', null],
        unrepairable: [{ shopifyCustomerId: '78', reason: 'needs a person', accountId: 'LEAK' }], eventHealth: { failed: 2, stuckProcessing: 1, weird: 'abc' }, truncated: true } } });
    await prisma.jobRun.create({ data: { shop: `rec-other-${Date.now()}.myshopify.com`, jobType: 'reconcile', status: 'completed', startedAt: new Date(Date.now() + 5000), result: { accountsChecked: 1000 } } });

    const r = await admin.get('reconciliation');
    assert.ok(!r.text.includes('LEAK'), 'unknown fields are dropped');
    const l = r.json.last;
    assert.deepStrictEqual([l.trigger, l.accountsChecked, l.discrepancyCount, l.truncated], ['nightly', 9, 1, true]);
    assert.strictEqual(l.discrepancies.length, 3);
    assert.ok(l.discrepancies[0].detail.length <= 300, 'long text is cut');
    assert.deepStrictEqual(l.unrepairable, [{ shopifyCustomerId: '78', reason: 'needs a person' }]);
    assert.deepStrictEqual(l.eventHealth, { failed: 2, stuckProcessing: 1, weird: 0 });
    assert.deepStrictEqual(Object.keys(l).sort(), ['accountsChecked', 'accountsWithDiscrepancies', 'at', 'byCode', 'discrepancies', 'discrepancyCount', 'eventHealth', 'status', 'trigger', 'truncated', 'unrepairable']);
    const keys = allKeys(r.json);
    for (const bad of ['secretField', 'internalId', 'accountId', 'repair', 'id', 'shop']) assert.ok(!keys.has(bad), `no "${bad}"`);
  });

  test('it needs a session, a CSRF token for the run, and an open console', async () => {
    assert.strictEqual((await fetch(`${site.url}/api/reconciliation`)).status, 401);
    assert.strictEqual((await admin.req('POST', 'reconciliation/run', {}, { 'X-CSRF-Token': '' })).status, 403);
    const forced = await adminBrowser(site.url, shop, { mustChange: true });
    assert.strictEqual((await forced.get('reconciliation')).status, 403);
    assert.strictEqual((await forced.post('reconciliation/run', {})).status, 403);
    assert.strictEqual(await prisma.jobRun.count({ where: { shop, jobType: 'reconcile' } }), 0);
  });

  const sample = (over = {}) => ({
    at: '2026-10-12T09:00:00.000Z', status: 'completed', trigger: 'manual', accountsChecked: 12, accountsWithDiscrepancies: 1, discrepancyCount: 1, byCode: { pending_mismatch: 1 },
    discrepancies: [{ shopifyCustomerId: '1001', code: 'pending_mismatch', detail: '<script>alert(1)</script>', expected: 300, found: 999, help: 'The cached pending balance differs from the sum of the pending lots.' }],
    truncated: false, unrepairable: [{ shopifyCustomerId: '1002', reason: 'needs a person' }], eventHealth: { processed: 5, failed: 1 }, ...over,
  });

  test('the page shows the findings with help text, escapes everything, and says what it cannot show', () => {
    const html = String(renderReconciliation({ last: sample(), running: false }));
    for (const text of ['Reconciliation', 'Run reconciliation', '1 issue in 1 account', 'pending_mismatch', 'expected 300, found 999', 'differs from the sum', 'need a person', 'Per-member comparison table', 'Not available in this version']) assert.ok(html.includes(text), `has ${text}`);
    assert.ok(!html.includes('<script>alert(1)') && html.includes('&lt;script&gt;'));
    assert.ok(!/\sstyle=/.test(html));
  });

  test('the page for a clean run, no run, and a running run', () => {
    assert.match(String(renderReconciliation({ last: sample({ discrepancyCount: 0, accountsWithDiscrepancies: 0, byCode: {}, discrepancies: [], unrepairable: [] }), running: false })), /Every balance matches/);
    assert.match(String(renderReconciliation({ last: null, running: false })), /No run has been recorded yet/);
    assert.match(String(renderReconciliation({ last: null, running: true })), /disabled>Running/);
  });
});
