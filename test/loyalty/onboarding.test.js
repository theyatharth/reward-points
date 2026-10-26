// test/loyalty/onboarding.test.js
//
// Onboarding a shop (scripts/onboard-shop.mjs, web/loyalty/service/onboarding.js): the config from the seed profile with the
// shop's currency and holding period and ledgerStartAt = now, idempotent, an optional admin user, validation, and the CLI refusing
// a protected database.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prisma } from '../../web/lib/prisma.js';
import { verifyPassword } from '../../web/lib/passwords.js';
import { onboardShop, OnboardingError } from '../../web/loyalty/service/onboarding.js';
import { SEED_PROFILE } from '../../web/loyalty/rules/config.js';
import { setFixedTime, restoreClock } from '../../web/loyalty/adapters/clock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = new Date('2026-10-15T09:30:00Z');

describe('onboarding a shop', () => {
  let shop;

  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });
  after(async () => {
    restoreClock();
    await prisma.$disconnect();
  });
  beforeEach(() => {
    shop = `onb-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    setFixedTime(NOW);
  });

  const config = () => prisma.loyaltyConfig.findUnique({ where: { shop } });

  test('creates the config from the seed profile with the shop currency, the holding period, and ledgerStartAt = now', async () => {
    const r = await onboardShop({ shop, currency: 'USD', holdDays: 1 });
    assert.equal(r.created, true);
    const c = await config();
    for (const [k, v] of Object.entries(SEED_PROFILE)) assert.equal(c[k], v, k);
    assert.deepEqual([c.currency, c.holdPeriodDays, c.pointsPerReward, c.rewardValue, c.rewardExpiryDays, c.pointsRounding], ['USD', 1, 100, 1000, 90, 'floor']);
    assert.deepEqual([c.campaignEnabled, c.expiryEnabled, c.shortfallPolicy], [false, false, 'owe_only']);
    assert.equal(c.ledgerStartAt.toISOString(), NOW.toISOString());
    assert.equal(r.config.ledgerStartAt, NOW.toISOString());
    assert.equal(r.config.earn, '100 points per 100 USD spent');
    assert.equal(r.admin, null);
  });

  test('currency is normalised; hold 0 and 55 are accepted', async () => {
    assert.equal((await onboardShop({ shop, currency: 'inr', holdDays: 0 })).config.currency, 'INR');
    const other = `onb-b-${Date.now()}.myshopify.com`;
    assert.equal((await onboardShop({ shop: other, currency: 'EUR', holdDays: 55 })).config.holdPeriodDays, 55);
  });

  test('IDEMPOTENT: a second run changes nothing and says so, even when asked for different values', async () => {
    await onboardShop({ shop, currency: 'INR', holdDays: 1 });
    await prisma.loyaltyConfig.update({ where: { shop }, data: { pointsPerReward: 777 } });
    const before = await config();
    setFixedTime(new Date('2026-12-01T00:00:00Z'));
    const again = await onboardShop({ shop, currency: 'USD', holdDays: 5 });
    assert.equal(again.created, false);
    assert.deepEqual(again.differences, ['currency is INR, not USD', 'holding period is 1 days, not 5']);
    const after = await config();
    assert.deepEqual(after, before, 'the row is untouched (ledgerStartAt too)');
    assert.equal(after.pointsPerReward, 777);
    assert.equal((await onboardShop({ shop, currency: 'INR', holdDays: 1 })).differences.length, 0);
  });

  test('two runs at once: exactly one creates', async () => {
    const [a, b] = await Promise.all([onboardShop({ shop, currency: 'INR', holdDays: 1 }), onboardShop({ shop, currency: 'INR', holdDays: 1 })]);
    assert.deepEqual([a.created, b.created].sort(), [false, true]);
    assert.equal(await prisma.loyaltyConfig.count({ where: { shop } }), 1);
  });

  test('bad input is refused and nothing is created', async () => {
    const bad = [
      { shop: 'not-a-shop.com', currency: 'INR', holdDays: 1 }, { shop: 'x.myshopify.com.evil.com', currency: 'INR', holdDays: 1 }, { shop: '', currency: 'INR', holdDays: 1 },
      { shop: undefined, currency: 'INR', holdDays: 1 }, { shop, currency: 'XX', holdDays: 1 }, { shop, currency: '', holdDays: 1 }, { shop, currency: undefined, holdDays: 1 },
      { shop, currency: 'INR', holdDays: -1 }, { shop, currency: 'INR', holdDays: 56 }, { shop, currency: 'INR', holdDays: 1.5 }, { shop, currency: 'INR', holdDays: '1' },
      { shop, currency: 'INR', holdDays: NaN }, { shop, currency: 'INR', holdDays: 1, adminEmail: 'nope' }, { shop, currency: 'INR', holdDays: 1, adminEmail: 'a b@c.de' },
    ];
    for (const input of bad) await assert.rejects(onboardShop(input), OnboardingError, JSON.stringify(input));
    assert.equal(await config(), null);
    assert.equal(await prisma.adminUser.count({ where: { shop } }), 0);
  });

  describe('the admin user', () => {
    test('is created with a one-time password that must be changed, e-mail lowercased', async () => {
      const r = await onboardShop({ shop, currency: 'INR', holdDays: 1, adminEmail: ' Staff@Example.TEST ' });
      assert.deepEqual([r.admin.created, r.admin.email], [true, 'staff@example.test']);
      assert.ok(r.admin.oneTimePassword.length >= 20);
      const u = await prisma.adminUser.findFirst({ where: { shop } });
      assert.equal(u.mustChangePassword, true);
      assert.notEqual(u.passwordHash, r.admin.oneTimePassword);
      assert.equal(await verifyPassword(u.passwordHash, r.admin.oneTimePassword), true);
    });

    test('a second run (any letter case) creates no second admin and shows no password', async () => {
      await onboardShop({ shop, currency: 'INR', holdDays: 1, adminEmail: 'staff@example.test' });
      const again = await onboardShop({ shop, currency: 'INR', holdDays: 1, adminEmail: 'STAFF@example.test' });
      assert.equal(again.admin.created, false);
      assert.equal(again.admin.oneTimePassword, undefined);
      assert.equal(await prisma.adminUser.count({ where: { shop } }), 1);
    });

    test('the same e-mail can be an admin of two shops, each with its own password', async () => {
      const other = `onb-other-${Date.now()}.myshopify.com`;
      const shared = `shared-${crypto.randomUUID()}@example.test`; // unique per run: the test database persists between runs
      const a = await onboardShop({ shop, currency: 'INR', holdDays: 1, adminEmail: shared });
      const b = await onboardShop({ shop: other, currency: 'USD', holdDays: 1, adminEmail: shared });
      assert.notEqual(a.admin.oneTimePassword, b.admin.oneTimePassword);
      assert.equal(a.emailAlsoAdminOfOtherShops, 0);
      assert.equal(b.emailAlsoAdminOfOtherShops, 1, 'the second onboarding is warned that the e-mail is already an admin elsewhere');
    });
  });

  test('reports whether the app is installed on the shop (an offline session exists)', async () => {
    assert.equal((await onboardShop({ shop, currency: 'INR', holdDays: 1 })).installed, false);
    await prisma.session.create({ data: { id: `offline_${shop}`, shop, state: 'x', isOnline: false, accessToken: 'test-not-a-real-token' } });
    assert.equal((await onboardShop({ shop, currency: 'INR', holdDays: 1 })).installed, true);
  });

  describe('the command line', () => {
    const run = (args, env) => spawnSync(process.execPath, ['scripts/onboard-shop.mjs', ...args], { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 60_000 });

    test('refuses the production database and the shared instance before touching anything', () => {
      for (const url of ['postgresql://u:p@db.example.com:5432/reward_points', 'postgresql://u:p@proluma-db-instance.example.com:5432/reward_points_dev', 'postgresql://u:p@db.example.com:5432/postgres']) {
        const r = run(['--shop', 'a.myshopify.com', '--currency', 'INR', '--hold-days', '1'], { DATABASE_URL: url });
        assert.notEqual(r.status, 0, url);
        assert.match(r.stderr, /db-guard/, url);
        assert.ok(!/CREATED/.test(r.stdout), url);
      }
    });

    test('prints usage without all three required options', () => {
      const r = run(['--shop', 'a.myshopify.com', '--currency', 'INR'], { DATABASE_URL: process.env.DATABASE_URL });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Usage/);
    });

    test('creates, then reports "already has" on the second run; never prints the database URL', () => {
      const args = ['--shop', shop, '--currency', 'INR', '--hold-days', '1'];
      const env = { DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: 'test' };
      const first = run(args, env);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /CREATED the loyalty config/);
      assert.match(first.stdout, /ledgerStartAt\s+20\d\d-/);
      const second = run(args, env);
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /already has a loyalty config: left unchanged/);
      for (const out of [first.stdout + first.stderr, second.stdout + second.stderr]) {
        assert.ok(!out.includes(process.env.DATABASE_URL), 'no connection string');
        assert.ok(!/postgres(ql)?:\/\//.test(out), 'no connection string');
      }
    });

    test('with --admin-email: the one-time password is printed once, and not on the second run', () => {
      const args = ['--shop', shop, '--currency', 'USD', '--hold-days', '0', '--admin-email', `qa-${crypto.randomUUID()}@example.test`];
      const env = { DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: 'test' };
      assert.match(run(args, env).stdout, /one-time password \(shown once\): \S{20,}/);
      const second = run(args, env);
      assert.match(second.stdout, /already exists: left unchanged/);
      assert.ok(!/one-time password/.test(second.stdout));
    });
  });
});
