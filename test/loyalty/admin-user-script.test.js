// test/loyalty/admin-user-script.test.js
//
// scripts/admin-user.mjs: reset-password (new one-time password, must change it, sessions ended, audit row without a secret, unlocks
// the account) and delete (refused with a clear message for an admin who has audit rows). Module level and through the real command line.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prisma } from '../../web/lib/prisma.js';
import { hashPassword, verifyPassword } from '../../web/lib/passwords.js';
import { resetAdminPassword, deleteAdmin, AdminUserError } from '../../web/admin/user-admin.js';
import { describe as describeAudit } from '../../web/admin/data/audit.js';
import { startConsole, adminBrowser } from '../helpers/admin-http.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OLD = 'Old-password-correct-horse-1';

describe('admin-user: reset-password and delete', () => {
  let site;
  let shop;
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
  beforeEach(() => {
    shop = `adm-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    process.env.ADMIN_SHOP = shop; // pinned: each test has its own shop
  });

  const mkAdmin = async (over = {}) => prisma.adminUser.create({ data: { shop, email: `a-${crypto.randomUUID()}@example.test`, passwordHash: await hashPassword(OLD), mustChangePassword: false, ...over } });
  const login = (email, password) => fetch(`${site.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.55.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify({ email, password }) });

  describe('resetAdminPassword', () => {
    test('a new random one-time password replaces the old one, and the admin must change it', async () => {
      const admin = await mkAdmin();
      const r = await resetAdminPassword({ shop, email: admin.email });
      assert.equal(r.found, true);
      assert.equal(r.email, admin.email);
      assert.ok(r.oneTimePassword.length >= 20 && r.oneTimePassword !== OLD);
      const row = await prisma.adminUser.findUnique({ where: { id: admin.id } });
      assert.equal(row.mustChangePassword, true);
      assert.notEqual(row.passwordHash, r.oneTimePassword);
      assert.equal(await verifyPassword(row.passwordHash, r.oneTimePassword), true);
      assert.equal(await verifyPassword(row.passwordHash, OLD), false, 'the old password no longer works');
      const again = await resetAdminPassword({ shop, email: admin.email });
      assert.notEqual(again.oneTimePassword, r.oneTimePassword, 'each reset is a fresh password');
    });

    test('they can sign in with it (and only into the forced password change); the old password is refused', async () => {
      const admin = await mkAdmin();
      const r = await resetAdminPassword({ shop, email: admin.email });
      assert.equal((await login(admin.email, OLD)).status, 401);
      const ok = await login(admin.email, r.oneTimePassword);
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).mustChangePassword, true);
    });

    test('every session of that admin is ended, other admins\' sessions are not', async () => {
      const victim = await adminBrowser(site.url, shop);
      const bystander = await adminBrowser(site.url, shop);
      assert.equal((await victim.get('session')).status, 200);
      const r = await resetAdminPassword({ shop, email: victim.email });
      assert.equal(r.sessionsEnded, 1);
      assert.equal((await victim.get('session')).status, 401, 'the old session cookie is dead');
      assert.equal(await prisma.adminSession.count({ where: { userId: victim.admin.id } }), 0);
      assert.equal((await bystander.get('session')).status, 200, 'another admin is untouched');
    });

    test('writes ONE admin_password_reset audit row naming the shop and the admin, with no secret in it', async () => {
      const admin = await mkAdmin();
      const r = await resetAdminPassword({ shop, email: admin.email });
      const rows = await prisma.auditLog.findMany({ where: { shop, action: 'admin_password_reset' } });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].adminId, admin.id);
      const text = JSON.stringify(rows[0]);
      assert.ok(!text.includes(r.oneTimePassword), 'no password in the audit row');
      const hash = (await prisma.adminUser.findUnique({ where: { id: admin.id } })).passwordHash;
      assert.ok(!text.includes(hash.slice(0, 20)), 'no hash in the audit row');
      assert.ok(!/password.*[:=]/i.test(JSON.stringify(rows[0].detail)));
      assert.match(describeAudit('admin_password_reset', rows[0].detail).reason, /reset by an operator/);
    });

    test('an unknown admin (or one of another shop) changes nothing and writes nothing', async () => {
      const other = `adm-other-${Date.now()}.myshopify.com`;
      const theirs = await prisma.adminUser.create({ data: { shop: other, email: 'someone@example.test', passwordHash: await hashPassword(OLD), mustChangePassword: false } });
      assert.deepEqual(await resetAdminPassword({ shop, email: 'nobody@example.test' }), { found: false });
      assert.deepEqual(await resetAdminPassword({ shop, email: theirs.email }), { found: false }, 'the e-mail belongs to another shop');
      const after = await prisma.adminUser.findUnique({ where: { id: theirs.id } });
      assert.equal(after.passwordHash, theirs.passwordHash);
      assert.equal(after.mustChangePassword, false);
      assert.equal(await prisma.auditLog.count({ where: { action: 'admin_password_reset', shop: { in: [shop, other] } } }), 0);
    });

    test('the e-mail matches in any letter case, and only that shop\'s admin is reset', async () => {
      const admin = await mkAdmin({ email: `Mixed-${crypto.randomUUID()}@Example.TEST` });
      const twin = await prisma.adminUser.create({ data: { shop: `adm-twin-${Date.now()}.myshopify.com`, email: admin.email, passwordHash: await hashPassword(OLD), mustChangePassword: false } });
      const r = await resetAdminPassword({ shop, email: admin.email.toUpperCase() });
      assert.equal(r.found, true);
      assert.equal((await prisma.adminUser.findUnique({ where: { id: twin.id } })).passwordHash, twin.passwordHash, 'the same e-mail in another shop is untouched');
    });

    test('a locked-out admin is unlocked (the failed-attempt counters for the account are cleared)', async () => {
      const admin = await mkAdmin();
      for (let i = 0; i < 5; i += 1) assert.equal((await login(admin.email, 'wrong-password-123')).status, 401);
      assert.equal((await login(admin.email, OLD)).status, 429, 'locked after five failures');
      const r = await resetAdminPassword({ shop, email: admin.email });
      assert.equal((await login(admin.email, r.oneTimePassword)).status, 200);
    });

    test('requires a shop and an e-mail', async () => {
      await assert.rejects(resetAdminPassword({ shop, email: '' }), AdminUserError);
      await assert.rejects(resetAdminPassword({ shop: '', email: 'a@b.cd' }), AdminUserError);
    });
  });

  describe('deleteAdmin', () => {
    test('an admin with audit rows is refused with a clear message pointing to reset-password; nothing changes', async () => {
      const admin = await adminBrowser(site.url, shop); // signing in wrote an admin_login audit row
      assert.ok((await prisma.auditLog.count({ where: { adminId: admin.admin.id } })) > 0);
      await assert.rejects(deleteAdmin({ shop, email: admin.email }), (err) => {
        assert.ok(err instanceof AdminUserError);
        assert.match(err.message, /audit log row/);
        assert.match(err.message, /append-only/);
        assert.match(err.message, /reset-password/);
        return true;
      });
      assert.ok(await prisma.adminUser.findUnique({ where: { id: admin.admin.id } }), 'still there');
      assert.equal((await admin.get('session')).status, 200, 'and still signed in');
    });

    test('an admin who never did anything can be deleted, with their sessions', async () => {
      const admin = await mkAdmin();
      await prisma.adminSession.create({ data: { userId: admin.id, token: crypto.randomBytes(16).toString('hex'), expiresAt: new Date(Date.now() + 60_000) } });
      assert.deepEqual(await deleteAdmin({ shop, email: admin.email }), { deleted: 1 });
      assert.equal(await prisma.adminUser.findUnique({ where: { id: admin.id } }), null);
      assert.equal(await prisma.adminSession.count({ where: { userId: admin.id } }), 0);
    });

    test('an unknown admin deletes nothing', async () => {
      assert.deepEqual(await deleteAdmin({ shop, email: 'nobody@example.test' }), { deleted: 0 });
    });
  });

  describe('the command line', () => {
    const run = (args, env = {}) => spawnSync(process.execPath, ['scripts/admin-user.mjs', ...args], { cwd: ROOT, env: { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: 'test', ...env }, encoding: 'utf8', timeout: 60_000 });

    test('refuses protected databases before touching anything', () => {
      for (const url of ['postgresql://u:p@db.example.com:5432/reward_points', 'postgresql://u:p@proluma-db-instance.example.com:5432/reward_points_dev']) {
        for (const cmd of ['reset-password', 'delete']) {
          const r = run([cmd, '--shop', 'a.myshopify.com', '--email', 'a@b.cd'], { DATABASE_URL: url });
          assert.notEqual(r.status, 0, `${cmd} ${url}`);
          assert.match(r.stderr, /db-guard/);
          assert.ok(!/one-time password/.test(r.stdout));
        }
      }
    });

    test('reset-password prints the one-time password once, nothing else secret, and it works', async () => {
      const admin = await mkAdmin();
      const r = run(['reset-password', '--shop', shop, '--email', admin.email]);
      assert.equal(r.status, 0, r.stderr);
      const m = r.stdout.match(/one-time password \(shown once\): (\S+)/);
      assert.ok(m, r.stdout);
      assert.equal(r.stdout.match(/one-time password/g).length, 1, 'printed once');
      assert.match(r.stdout, /must change the password at the next sign-in/);
      for (const out of [r.stdout, r.stderr]) {
        assert.ok(!out.includes(process.env.DATABASE_URL) && !/postgres(ql)?:\/\//.test(out), 'no connection string');
      }
      assert.equal(await verifyPassword((await prisma.adminUser.findUnique({ where: { id: admin.id } })).passwordHash, m[1]), true);
      const rows = await prisma.auditLog.findMany({ where: { shop, action: 'admin_password_reset' } });
      assert.equal(rows.length, 1);
      assert.ok(!JSON.stringify(rows).includes(m[1]));
    });

    test('reset-password for an unknown admin says so, exits 0, prints no password, writes nothing', async () => {
      const r = run(['reset-password', '--shop', shop, '--email', 'nobody@example.test']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /No admin found/);
      assert.ok(!/one-time password/.test(r.stdout));
      assert.equal(await prisma.auditLog.count({ where: { shop, action: 'admin_password_reset' } }), 0);
    });

    test('reset-password without --shop or --email prints usage and exits 1', () => {
      const r = run(['reset-password', '--shop', shop]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Usage: node scripts\/admin-user.mjs reset-password/);
    });

    test('delete of an admin with audit rows fails with the clear message and a non-zero exit', async () => {
      const admin = await mkAdmin();
      await resetAdminPassword({ shop, email: admin.email }); // writes an audit row for this admin
      const r = run(['delete', '--shop', shop, '--email', admin.email]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /audit log row/);
      assert.match(r.stderr, /reset-password/);
      assert.ok(await prisma.adminUser.findUnique({ where: { id: admin.id } }));
    });

    test('delete of an admin with no history still works', async () => {
      const admin = await mkAdmin();
      const r = run(['delete', '--shop', shop, '--email', admin.email]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Deleted 1 user/);
    });
  });
});
