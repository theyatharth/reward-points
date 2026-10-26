// test/loyalty/program-name.test.js
//
// The program's name: "Reward Points" until the merchant changes it on the Rules page (validated, audited, pushed to the theme),
// used by the storefront text, the discount titles and the console heading; and no "Ecofynd" anywhere a person can see it.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { prisma } from '../../web/lib/prisma.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { redeem } from '../../web/loyalty/service/redemption.js';
import { adjustPoints } from '../../web/loyalty/service/adjustment.js';
import { customerView } from '../../web/loyalty/service/storefront.js';
import { syncRuleMetafields } from '../../web/loyalty/service/metafield-sync.js';
import { validateConfig, normalizeProgramName, DEFAULT_CONFIG, DEFAULT_PROGRAM_NAME } from '../../web/loyalty/rules/config.js';
import { planChange } from '../../web/admin/data/rules.js';
import { programInfo } from '../../web/admin/data/program.js';
import { startEmbeddedConsole, sessionToken, installShop } from '../helpers/shopify-embedded.js';
import { uniqueId } from '../helpers/ids.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const BASE = { spendAmountPaise: 100, pointsPerUnit: 1, pointsPerReward: 500, rewardValue: 5000, currency: 'INR', holdPeriodDays: 0, ledgerStartAt: new Date('2026-01-01T00:00:00Z') };
const newShop = () => `name-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;

describe('Program name: validation', () => {
  test('1 to 40 characters, whitespace tidied, no angle brackets or control characters', () => {
    assert.equal(DEFAULT_PROGRAM_NAME, 'Reward Points');
    assert.equal(DEFAULT_CONFIG.programName, 'Reward Points');
    assert.equal(normalizeProgramName('  Acme   Club '), 'Acme Club');
    assert.equal(normalizeProgramName('a'.repeat(40)), 'a'.repeat(40));
    assert.equal(normalizeProgramName('Café Rewards ★'), 'Café Rewards ★');
    for (const bad of ['', '   ', 'a'.repeat(41), '<b>x</b>', 'a>b', 'tab\there'.replace('\t', '\u0007'), 'zero​width', null, undefined, 5, {}]) assert.equal(normalizeProgramName(bad), null, JSON.stringify(bad));
    assert.equal(validateConfig({ programName: ' Acme   Club ' }).programName, 'Acme Club');
    assert.throws(() => validateConfig({ programName: '<script>' }), /programName/);
    assert.throws(() => validateConfig({ programName: '' }), /programName/);
  });

  test('planChange: the new name is normalised, shown as a change with a note, and a bad one is refused with the field', () => {
    const current = { ...DEFAULT_CONFIG, spendAmountPaise: 10000, pointsPerUnit: 100, programName: 'Reward Points' };
    const ok = planChange(current, { programName: '  Acme   Club ' });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.changes, [{ field: 'programName', label: 'Program name', previous: 'Reward Points', next: 'Acme Club' }]);
    assert.ok(ok.notes.some((n) => /storefront/.test(n)));
    assert.equal(planChange(current, { programName: 'Reward Points' }).changes.length, 0);
    for (const value of ['', 'x'.repeat(41), '<i>', 7, null]) {
      const r = planChange(current, { programName: value });
      assert.equal(r.ok, false);
      assert.equal(r.body.field, 'programName');
    }
  });
});

describe('Program name: in use', () => {
  let shop;
  let gw;
  let site;
  before(async () => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
    site = await startEmbeddedConsole();
  });
  after(async () => { await site.close(); await prisma.$disconnect(); });
  beforeEach(() => {
    shop = newShop();
    gw = new FakeShopifyGateway(shop);
    ledgerService.setGatewayFactory(() => gw);
  });
  const configure = (over = {}) => prisma.loyaltyConfig.create({ data: { shop, ...BASE, ...over } });

  test('a new shop is called "Reward Points" (the database default), in the console info and the storefront view', async () => {
    await configure();
    assert.equal((await prisma.loyaltyConfig.findUnique({ where: { shop } })).programName, 'Reward Points');
    assert.equal((await programInfo(shop)).name, 'Reward Points');
    assert.deepEqual((await customerView({ shop, shopifyCustomerId: '1' })).program, { name: 'Reward Points' });
  });

  test('the database refuses an empty or over-long name', async () => {
    await assert.rejects(prisma.loyaltyConfig.create({ data: { shop, ...BASE, programName: '' } }), /programName_length|check constraint/i);
    await assert.rejects(prisma.loyaltyConfig.create({ data: { shop, ...BASE, programName: 'x'.repeat(41) } }), /programName_length|check constraint/i);
  });

  test('renaming through the console is audited, shows in /rules and /meta, and marks the theme metafield for a push', async () => {
    await configure();
    await installShop(shop);
    const token = sessionToken(shop, { sub: '606' });
    const before = await site.call('GET', 'rules', { token });
    assert.equal(before.json.program.name, 'Reward Points');
    assert.equal(before.json.program.nameMaxLength, 40);
    // Nothing pending yet to push, then a rename.
    await syncRuleMetafields({ shop });
    const seq0 = await prisma.loyaltyConfig.findUnique({ where: { shop } });
    assert.equal(seq0.ruleSeq, seq0.ruleSyncedSeq);
    const fresh = (await site.call('GET', 'rules', { token })).json.program.updatedAt; // the sync above touched the row
    const bad = await site.call('POST', 'rules', { token, body: { expected: fresh, changes: { programName: '<b>x</b>' } } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.field, 'programName');
    const saved = await site.call('POST', 'rules', { token, body: { expected: fresh, changes: { programName: ' Acme   Club ' } } });
    assert.equal(saved.status, 200, saved.text);
    assert.equal((await prisma.loyaltyConfig.findUnique({ where: { shop } })).programName, 'Acme Club');
    const audit = await prisma.auditLog.findFirst({ where: { shop, action: 'rules_changed' } });
    assert.equal(audit.shopifyUserId, '606');
    assert.deepEqual(audit.detail.changes, [{ field: 'programName', label: 'Program name', previous: 'Reward Points', next: 'Acme Club' }]);
    assert.equal((await site.call('GET', 'rules', { token })).json.program.name, 'Acme Club');
    assert.equal((await site.call('GET', 'meta', { token })).json.program.name, 'Acme Club');
    const dirty = await prisma.loyaltyConfig.findUnique({ where: { shop } });
    assert.ok(dirty.ruleSeq > dirty.ruleSyncedSeq, 'the rule metafield is dirty');
    await syncRuleMetafields({ shop });
    assert.equal(gw.ruleMetafields.at(-1).programName, 'Acme Club');
    assert.match(String((await site.call('GET', 'audit', { token })).json.entries.find((e) => e.action === 'rules_changed').next), /Program name: Acme Club/);
  });

  test('the storefront uses the name: view, labels of adjustments and bonuses', async () => {
    await configure({ programName: 'Acme Club' });
    const customer = String(uniqueId());
    const account = await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: customer, available: 10 } });
    const admin = await prisma.adminUser.create({ data: { shop, email: `a-${crypto.randomUUID()}@example.test`, passwordHash: 'x', mustChangePassword: false } });
    await adjustPoints({ shop, shopifyCustomerId: customer, points: 100, reason: 'Special bonus', note: 'for the test run', adminId: admin.id, idempotencyKey: crypto.randomUUID() });
    await adjustPoints({ shop, shopifyCustomerId: customer, points: -5, reason: 'Duplicate points', note: 'for the test run', adminId: admin.id, idempotencyKey: crypto.randomUUID() });
    const view = await customerView({ shop, shopifyCustomerId: customer });
    assert.deepEqual(view.program, { name: 'Acme Club' });
    assert.deepEqual(view.history.map((h) => h.label).sort(), ['Adjustment by Acme Club', 'Special bonus from Acme Club']);
    // The ledger notes written now name nobody: "the shop".
    const notes = (await prisma.ledgerEntry.findMany({ where: { accountId: account.id, note: { not: null } } })).map((e) => e.note).sort();
    assert.deepEqual(notes, ['Deducted by the shop: Duplicate points', 'Special bonus from the shop']);
  });

  test('a discount code is titled with the program name', async () => {
    await configure({ programName: 'Acme Club' });
    const customer = String(uniqueId());
    await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: customer, available: 500 } });
    const lotAccount = await prisma.loyaltyAccount.findFirst({ where: { shop } });
    const lot = await prisma.pointLot.create({ data: { accountId: lotAccount.id, originalPoints: 500, remaining: 500, status: 'active', shopifyOrderId: `seed-${crypto.randomUUID()}`, activatesAt: new Date(Date.now() - 86400000) } });
    await prisma.ledgerEntry.create({ data: { accountId: lotAccount.id, type: 'earn', points: 500, dedupeKey: `seed:${crypto.randomUUID()}`, lotId: lot.id } });
    const r = await redeem({ shop, shopifyCustomerId: customer, idempotencyKey: crypto.randomUUID() });
    assert.equal(r.ok, true, JSON.stringify(r));
    const titles = [...gw.discounts.values()].map((d) => d.title);
    assert.equal(titles.length, 1);
    assert.match(titles[0], /^Acme Club — /);
    assert.ok(!/ecofynd/i.test(titles[0]));
  });
});

describe('Neutral text', () => {
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name === 'node_modules' || name === 'dist' || name === 'generated') continue;
      if (statSync(full).isDirectory()) walk(full, out); else out.push(full);
    }
    return out;
  };

  test('no "Ecofynd" in anything shipped to a browser: the console, the theme blocks, their scripts and styles, and the strings the server sends', () => {
    const files = [
      ...walk(join(ROOT, 'web/admin/public')),
      ...walk(join(ROOT, 'extensions')),
      ...walk(join(ROOT, 'web/loyalty')),
      ...walk(join(ROOT, 'web/routes')),
      ...walk(join(ROOT, 'web/lib')),
      join(ROOT, 'web/admin/router.js'), join(ROOT, 'web/admin/routes.js'),
      ...walk(join(ROOT, 'web/admin/data')),
    ].filter((f) => /\.(js|html|css|liquid|json|toml)$/.test(f));
    assert.ok(files.length > 40);
    const hits = [];
    for (const f of files) readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (/ecofynd/i.test(line)) hits.push(`${relative(ROOT, f)}:${i + 1}`); });
    assert.deepEqual(hits, []);
  });

  test('the storefront script names the program from the view, the page and the attribute, and falls back to "Reward Points"', () => {
    const CLIENT = readFileSync(join(ROOT, 'extensions/rewards-widget/assets/rewards-client.js'), 'utf8');
    const sandbox = { Math, Date, JSON, String, Number, isNaN, isFinite, Promise, document: {}, window: null };
    sandbox.window = sandbox;
    vm.runInNewContext(CLIENT, sandbox);
    const E = sandbox.window.EcoRewards;
    assert.equal(E.programName({ program: { name: 'Acme Club' } }), 'Acme Club');
    for (const none of [null, undefined, {}, { program: {} }, { program: { name: '' } }, { program: { name: 5 } }]) assert.equal(E.programName(none), 'Reward Points');
    assert.equal(E.cleanName('  Acme   Club '), 'Acme Club');
    assert.equal(E.cleanName('x'.repeat(80)).length, 40);
    assert.equal(E.cleanName(null), '');
  });

  test('the theme blocks read the name from the rule metafield, default to Reward Points, and escape it', () => {
    for (const f of ['rewards-page.liquid', 'rewards-widget.liquid']) {
      const t = readFileSync(join(ROOT, 'extensions/rewards-widget/blocks', f), 'utf8');
      assert.match(t, /assign program_name = app\.metafields\.rewards\.redeem_rule\.value\.programName \| default: 'Reward Points'/, f);
      assert.match(t, /\{\{ program_name \| escape \}\}/, f);
    }
  });
});
