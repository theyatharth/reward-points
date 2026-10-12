// test/loyalty/admin-audit.test.js
//
// Admin console, Audit log: who, when, action, previous, new, reason, derived per action type from the audit rows the
// system really writes (adjustments, retries, rebuilds, sign-ins, reward anomalies). The raw detail is never sent.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { describe as describeAudit } from '../../web/admin/data/audit.js';
import { rebuildCache } from '../../web/loyalty/service/reconcile.js';
import { startConsole, adminBrowser, allKeys } from '../helpers/admin-http.js';
import { renderAudit } from '../../web/admin/public/pages/audit.js';

describe('Admin audit log', () => {
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
    shop = `aud-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    process.env.ADMIN_SHOP = shop;
    await prisma.loyaltyConfig.create({ data: { shop, ledgerStartAt: new Date('2026-01-01T00:00:00Z') } });
    admin = await adminBrowser(site.url, shop);
  });

  const entries = async (query = '') => (await admin.get(`audit${query}`)).json;

  test('a real adjustment, retry and rebuild produce readable rows (previous, new, reason, customer, who)', async () => {
    const account = await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: '4242' } });
    assert.strictEqual((await admin.post('customers/4242/adjust', { points: 200, reason: 'Customer service goodwill', note: 'Delayed delivery apology', idempotencyKey: crypto.randomUUID() })).status, 200);
    assert.strictEqual((await admin.post('customers/4242/adjust', { points: -50, reason: 'Duplicate points', note: 'credited twice', idempotencyKey: crypto.randomUUID() })).status, 200);
    const ev = await prisma.webhookEvent.create({ data: { shop, topic: 'refunds/create', payload: { id: 1, order_id: 7001 }, status: 'dead' } });
    assert.strictEqual((await admin.post(`events/${ev.id}/retry`, {})).status, 200);
    await prisma.loyaltyAccount.update({ where: { id: account.id }, data: { available: 999 } });
    assert.strictEqual((await rebuildCache(account.id, { reason: 'rebuild_cache:manual' })).changed, true);

    const { entries: rows } = await entries();
    const by = (action) => rows.filter((r) => r.action === action);
    const add = by('points_adjusted').find((r) => r.reason.startsWith('Customer service goodwill'));
    assert.deepStrictEqual([add.admin, add.subject, add.previous, add.next, add.reason], [admin.email, '4242', '0 available', '200 available', 'Customer service goodwill (+200) — Delayed delivery apology']);
    const ded = by('points_adjusted').find((r) => r.reason.startsWith('Duplicate points'));
    assert.deepStrictEqual([ded.previous, ded.next, ded.reason], ['200 available', '150 available', 'Duplicate points (-50) — credited twice']);
    const retry = by('event_retried')[0];
    assert.deepStrictEqual([retry.admin, retry.previous, retry.next, retry.reason], [admin.email, 'dead', 'pending', 'refunds/create · order 7001']);
    const rebuilt = by('rebuild_cache:manual')[0];
    assert.deepStrictEqual([rebuilt.admin, rebuilt.previous, rebuilt.next], ['system', 'available 999 · pending 0 · owed 0', 'available 150 · pending 0 · owed 0']);
    assert.ok(by('admin_login').length === 1 && by('admin_login')[0].admin === admin.email);
  });

  test('newest first, paged, filterable by action; the filter list shows every action with its count', async () => {
    for (let i = 0; i < 5; i++) await prisma.auditLog.create({ data: { shop, adminId: admin.admin.id, action: 'event_retried', detail: { topic: 'orders/paid', orderRef: String(8000 + i), previousStatus: 'failed' }, createdAt: new Date(Date.now() - (5 - i) * 1000) } });
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const r = await entries(`?action=event_retried&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...r.entries.map((e) => e.reason));
      cursor = r.nextCursor;
      pages++;
    } while (cursor && pages < 6);
    assert.deepStrictEqual([pages, seen], [3, ['orders/paid · order 8004', 'orders/paid · order 8003', 'orders/paid · order 8002', 'orders/paid · order 8001', 'orders/paid · order 8000']]);
    const all = await entries();
    assert.deepStrictEqual(all.actions.map((a) => [a.action, a.count]), [['admin_login', 1], ['event_retried', 5]]);
    assert.strictEqual((await entries('?action=admin_login')).entries.length, 1);
    assert.strictEqual((await entries('?action=bad%20action!')).entries.length, 6, 'a malformed filter is ignored');
  });

  test('another shop\'s audit rows never appear', async () => {
    await prisma.auditLog.create({ data: { shop: `aud-other-${Date.now()}.myshopify.com`, action: 'points_adjusted', detail: { points: 1, reason: 'x', note: 'other shop secret' } } });
    const r = await entries();
    assert.ok(r.entries.every((e) => e.action === 'admin_login'));
    assert.ok(!JSON.stringify(r).includes('other shop secret'));
  });

  test('the response is a whitelist: no raw detail, no ids of other tables, no ip', async () => {
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: '5151' } });
    await admin.post('customers/5151/adjust', { points: 5, reason: 'Missing points', note: 'whitelist check note', idempotencyKey: crypto.randomUUID() });
    const r = await admin.get('audit');
    const keys = allKeys(r.json);
    for (const bad of ['detail', 'adminId', 'ip', 'ledgerEntryId', 'accountId', 'before', 'after', 'passwordHash']) assert.ok(!keys.has(bad), `no "${bad}"`);
    assert.deepStrictEqual(Object.keys(r.json.entries[0]).sort(), ['action', 'admin', 'createdAt', 'id', 'next', 'previous', 'reason', 'subject']);
    assert.ok(!/127\.0\.0\.1|10\.\d+\.\d+\.\d+/.test(r.text), 'no address');
  });

  test('unknown actions and odd detail shapes never break the view or leak the detail', () => {
    for (const detail of [null, undefined, 'text', 42, [1, 2], { points: {}, before: 'x', note: { a: 1 } }]) {
      const d = describeAudit('points_adjusted', detail);
      assert.deepStrictEqual(Object.keys(d).sort(), ['next', 'previous', 'reason', 'subject']);
    }
    assert.deepStrictEqual(describeAudit('something_new', { secret: 'x' }), { previous: '—', next: '—', reason: '', subject: null });
    assert.match(describeAudit('reward_used_after_expired', { order: '77' }).reason, /used after it was expired · order 77/);
    assert.match(describeAudit('reward_used_twice', { secondOrder: '78', firstOrder: '77' }).reason, /second order · order 78/);
    assert.match(describeAudit('reward_used_by_other_customer', { order: '79' }).reason, /different customer · order 79/);
    assert.strictEqual(describeAudit('points_adjusted', { note: 'x'.repeat(5000) }).reason.length < 400, true, 'long values are cut');
  });

  test('it needs a session and an open console', async () => {
    assert.strictEqual((await fetch(`${site.url}/api/audit`)).status, 401);
    const forced = await adminBrowser(site.url, shop, { mustChange: true });
    assert.strictEqual((await forced.get('audit')).status, 403);
  });

  test('the page lists the rows, offers the action filter, and escapes everything', () => {
    const html = String(renderAudit({
      entries: [{ id: 'a1', createdAt: '2026-10-12T09:00:00.000Z', admin: '<b>x</b>@example.test', action: 'points_adjusted', subject: '4242', previous: '0 available', next: '200 available', reason: '<script>alert(1)</script>' }],
      next: 'a2', actions: [{ action: 'points_adjusted', count: 1 }, { action: 'x"><i>', count: 2 }], action: 'points_adjusted',
    }));
    for (const text of ['Audit log', 'points_adjusted (1)', 'Load more', '200 available', 'append-only']) assert.ok(html.includes(text), `has ${text}`);
    assert.ok(html.includes('value="points_adjusted" selected'));
    assert.ok(!html.includes('<script>alert(1)') && !html.includes('<b>x</b>') && !html.includes('x"><i>'));
    assert.ok(!/\sstyle=/.test(html));
    assert.match(String(renderAudit({ entries: [], next: null, actions: [], action: '' })), /No admin actions yet/);
  });
});
