// test/loyalty/adjustment.test.js
//
// Task 5: adjustPoints (a port of the client's engine.adjust(), docs/reference/engine.js).
// Ports the client tests "Manual adjustment needs amount, reason, note and admin; it lands in
// ledger and audit log" and "Deduction larger than the available balance is refused", and adds
// the rest of the contract: Special bonus, active lot at once, debt repaid first, idempotency,
// concurrency, unknown admin or customer, and the invariants after every step.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { prisma } from '../../web/lib/prisma.js';
import { adjustPoints, ADJUST_REASONS } from '../../web/loyalty/service/adjustment.js';
import * as ledgerService from '../../web/loyalty/service/ledger.js';
import { FakeShopifyGateway } from '../../web/loyalty/adapters/fake-gateway.js';
import { setFixedTime, restoreClock, now } from '../../web/loyalty/adapters/clock.js';
import { assertLedgerBalances } from '../helpers/invariants.js';

const C = '10156980011205';

describe('Manual adjustments', () => {
  let shop = '';
  let adminId = '';
  let accountId = '';
  const key = () => crypto.randomUUID();

  before(() => {
    if (!process.env.DATABASE_URL.includes('_test')) throw new Error('Tests must run on test DB');
  });

  beforeEach(async () => {
    shop = `adjust-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    setFixedTime(new Date('2026-09-01T10:00:00Z'));
    ledgerService.setGatewayFactory(() => new FakeShopifyGateway(shop));
    await prisma.loyaltyConfig.create({ data: { shop, pointsPerUnit: 1, ledgerStartAt: new Date('2026-01-01T00:00:00Z') } });
    adminId = (await prisma.adminUser.create({ data: { shop, email: `admin-${crypto.randomUUID()}@example.test`, passwordHash: 'x' } })).id;
    accountId = (await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: C } })).id;
  });

  after(async () => {
    restoreClock();
    await prisma.$disconnect();
  });

  const give = (over = {}) => adjustPoints({
    shop, shopifyCustomerId: C, points: 200, reason: 'Customer service goodwill', note: 'Delayed delivery apology', adminId, idempotencyKey: key(), ...over,
  });
  const acct = () => prisma.loyaltyAccount.findUnique({ where: { id: accountId } });
  const audits = () => prisma.auditLog.findMany({ where: { shop, action: 'points_adjusted' }, orderBy: { createdAt: 'asc' } });
  const entries = () => prisma.ledgerEntry.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } });
  const nothingWritten = async () => {
    assert.strictEqual((await entries()).length, 0, 'no ledger entry');
    assert.strictEqual((await audits()).length, 0, 'no audit row');
    assert.strictEqual((await acct()).available, 0);
  };

  // ---- the client's tests ----

  test('[Admin] needs amount, reason, note and admin; a good one lands in the ledger and the audit log', async () => {
    const bad = await give({ note: '' });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.reason, 'NOTE_TOO_SHORT');
    await nothingWritten();

    const good = await give();
    assert.strictEqual(good.ok, true, good.message);
    assert.strictEqual(good.type, 'adjustment');
    assert.strictEqual(good.available, 200);

    const [entry] = await entries();
    assert.deepStrictEqual([entry.type, entry.points, entry.status], ['adjustment', 200, 'active']);
    const [audit] = await audits();
    assert.strictEqual(audit.adminId, adminId);
    assert.strictEqual(audit.detail.points, 200);
    assert.strictEqual(audit.detail.reason, 'Customer service goodwill');
    assert.strictEqual(audit.detail.note, 'Delayed delivery apology');
    assert.strictEqual(audit.detail.ledgerEntryId, entry.id);
    assert.deepStrictEqual(audit.detail.before, { available: 0, pending: 0, debt: 0 });
    assert.deepStrictEqual(audit.detail.after, { available: 200, pending: 0, debt: 0 });
    await assertLedgerBalances(prisma, accountId);
  });

  test('[Admin] a deduction larger than the available balance is refused, and nothing changes', async () => {
    await give({ points: 100 });
    const r = await give({ points: -300, reason: 'Order issue correction', note: 'Wrong order credit' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'EXCEEDS_AVAILABLE');
    assert.match(r.message, /available balance of 100 points/);
    assert.strictEqual((await acct()).available, 100);
    assert.strictEqual((await entries()).length, 1);
    assert.strictEqual((await audits()).length, 1);
    await assertLedgerBalances(prisma, accountId);
  });

  // ---- validation, one rule at a time, each writing nothing ----

  test('every input rule refuses with its own reason and writes nothing', async () => {
    const cases = [
      [{ points: 0 }, 'INVALID_POINTS'], [{ points: 1.5 }, 'INVALID_POINTS'], [{ points: '5' }, 'INVALID_POINTS'],
      [{ points: NaN }, 'INVALID_POINTS'], [{ points: 1_000_001 }, 'INVALID_POINTS'],
      [{ reason: '' }, 'REASON_REQUIRED'], [{ reason: '   ' }, 'REASON_REQUIRED'], [{ reason: undefined }, 'REASON_REQUIRED'],
      [{ note: undefined }, 'NOTE_TOO_SHORT'], [{ note: '   ab   ' }, 'NOTE_TOO_SHORT'], [{ note: 'four' }, 'NOTE_TOO_SHORT'],
      [{ adminId: '' }, 'ADMIN_REQUIRED'], [{ adminId: undefined }, 'ADMIN_REQUIRED'],
      [{ adminId: crypto.randomUUID() }, 'ADMIN_UNKNOWN'],
      [{ idempotencyKey: '' }, 'INVALID_KEY'], [{ idempotencyKey: undefined }, 'INVALID_KEY'], [{ idempotencyKey: 'x'.repeat(129) }, 'INVALID_KEY'],
      [{ shopifyCustomerId: '999' }, 'NO_ACCOUNT'],
    ];
    for (const [over, reason] of cases) {
      const r = await give(over);
      assert.strictEqual(r.ok, false, JSON.stringify(over));
      assert.strictEqual(r.reason, reason, JSON.stringify(over));
    }
    await nothingWritten();
  });

  test('a note of exactly 5 characters (after trimming) is accepted and stored trimmed', async () => {
    const r = await give({ note: '  abcde  ' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual((await audits())[0].detail.note, 'abcde');
  });

  test('an admin of ANOTHER shop is refused', async () => {
    const otherShop = `other-${Date.now()}.myshopify.com`;
    const other = await prisma.adminUser.create({ data: { shop: otherShop, email: `o-${crypto.randomUUID()}@example.test`, passwordHash: 'x' } });
    const r = await give({ adminId: other.id });
    assert.strictEqual(r.reason, 'ADMIN_UNKNOWN');
    await nothingWritten();
  });

  // ---- what an adjustment does ----

  test('"Special bonus" writes a bonus entry; any other reason writes an adjustment entry', async () => {
    const bonus = await give({ points: 100, reason: 'Special bonus', note: 'Monsoon garden bonus' });
    assert.strictEqual(bonus.type, 'bonus');
    const plain = await give({ points: 50, reason: 'Missing points', note: 'Order #1002 not credited' });
    assert.strictEqual(plain.type, 'adjustment');
    assert.deepStrictEqual((await entries()).map((e) => `${e.type}:${e.points}`).sort(), ['adjustment:50', 'bonus:100']);
    assert.strictEqual((await audits()).length, 2);
    await assertLedgerBalances(prisma, accountId);
  });

  test('a positive adjustment is an ACTIVE lot at once: spendable, no holding period', async () => {
    await give({ points: 300 });
    const lots = await prisma.pointLot.findMany({ where: { accountId } });
    assert.strictEqual(lots.length, 1);
    assert.deepStrictEqual([lots[0].status, lots[0].originalPoints, lots[0].remaining], ['active', 300, 300]);
    assert.ok(lots[0].activatesAt.getTime() <= now().getTime());
    const a = await acct();
    assert.deepStrictEqual([a.available, a.pending], [300, 0]);
  });

  test('a positive adjustment repays an owed balance first (D4)', async () => {
    await prisma.loyaltyAccount.update({ where: { id: accountId }, data: { debt: 200 } });
    const r = await give({ points: 300 });
    assert.strictEqual(r.available, 100);
    assert.strictEqual(r.debt, 0);
    const [entry] = await entries();
    assert.strictEqual(entry.points, 300, 'the ledger records the whole 300');
    assert.match(entry.note, /200 used to repay the owed balance/);

    // Smaller than the debt: all of it repays, nothing is available.
    await prisma.loyaltyAccount.update({ where: { id: accountId }, data: { debt: 500 } });
    const r2 = await give({ points: 100 });
    assert.deepStrictEqual([r2.available, r2.debt], [100, 400]);
    const lots = await prisma.pointLot.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } });
    assert.deepStrictEqual(lots.map((l) => [l.status, l.remaining]), [['active', 100], ['exhausted', 0]]);
  });

  test('a deduction takes from active lots earliest first, may use the whole balance, and never touches pending points', async () => {
    await give({ points: 100 });
    setFixedTime(new Date('2026-09-02T10:00:00Z'));
    await give({ points: 300 });
    await prisma.loyaltyAccount.update({ where: { id: accountId }, data: { pending: 999 } }); // pending is not deductible
    await prisma.pointLot.create({ data: { accountId, originalPoints: 999, remaining: 999, status: 'pending', shopifyOrderId: 'p', activatesAt: new Date('2027-01-01') } });

    const r = await give({ points: -150, reason: 'Duplicate points', note: 'Credited twice' });
    assert.strictEqual(r.ok, true, r.message);
    assert.strictEqual(r.available, 250);
    const lots = await prisma.pointLot.findMany({ where: { accountId, status: { in: ['active', 'exhausted'] } }, orderBy: { activatesAt: 'asc' } });
    assert.deepStrictEqual(lots.map((l) => [l.remaining, l.status]), [[0, 'exhausted'], [250, 'active']], 'the older 100 first, then 50 of the newer');

    assert.strictEqual((await give({ points: -251, reason: 'Duplicate points', note: 'one too many' })).reason, 'EXCEEDS_AVAILABLE');
    const all = await give({ points: -250, reason: 'Policy abuse', note: 'Fraud review outcome' });
    assert.strictEqual(all.ok, true);
    assert.strictEqual((await acct()).available, 0);
    const [last] = (await entries()).slice(-1);
    assert.deepStrictEqual([last.type, last.points], ['adjustment', -250]);
    assert.strictEqual((await audits()).length, 4);
  });

  test('"Special bonus" on a deduction is just an adjustment (a negative bonus makes no sense)', async () => {
    await give({ points: 100 });
    const r = await give({ points: -50, reason: 'Special bonus', note: 'reversing a bonus' });
    assert.strictEqual(r.type, 'adjustment');
  });

  // ---- idempotency and concurrency ----

  test('the same idempotency key adjusts once and replays the first outcome', async () => {
    const k = key();
    const first = await give({ idempotencyKey: k });
    const again = await give({ idempotencyKey: k, points: 999, note: 'a different body is ignored' });
    assert.strictEqual(first.replayed, false);
    assert.strictEqual(again.replayed, true);
    assert.strictEqual(again.entryId, first.entryId);
    assert.strictEqual(again.points, 200, 'the stored outcome, not the new request');
    assert.strictEqual((await acct()).available, 200);
    assert.strictEqual((await entries()).length, 1);
    assert.strictEqual((await audits()).length, 1);

    await give(); // a new key adjusts again
    assert.strictEqual((await acct()).available, 400);
  });

  test('the same key from two requests at once adjusts once', async () => {
    const k = key();
    const results = await Promise.all([give({ idempotencyKey: k }), give({ idempotencyKey: k }), give({ idempotencyKey: k })]);
    assert.ok(results.every((r) => r.ok));
    assert.strictEqual(results.filter((r) => !r.replayed).length, 1);
    assert.strictEqual((await acct()).available, 200);
    assert.strictEqual((await entries()).length, 1);
    await assertLedgerBalances(prisma, accountId);
  });

  test('two deductions of 300 at once against 500 available: exactly one succeeds, the balance is never below 0', async () => {
    await give({ points: 500 });
    const res = await Promise.all([
      give({ points: -300, reason: 'Duplicate points', note: 'first of two' }),
      give({ points: -300, reason: 'Duplicate points', note: 'second of two' }),
    ]);
    assert.deepStrictEqual(res.map((r) => r.ok).sort(), [false, true]);
    assert.strictEqual(res.find((r) => !r.ok).reason, 'EXCEEDS_AVAILABLE');
    assert.strictEqual((await acct()).available, 200);
    await assertLedgerBalances(prisma, accountId);
  });

  test('the same key on two different customers does not collide', async () => {
    const other = await prisma.loyaltyAccount.create({ data: { shop, shopifyCustomerId: '777' } });
    const k = key();
    const a = await give({ idempotencyKey: k });
    const b = await give({ idempotencyKey: k, shopifyCustomerId: '777', points: 40 });
    assert.strictEqual(a.replayed, false);
    assert.strictEqual(b.replayed, false);
    assert.strictEqual((await prisma.loyaltyAccount.findUnique({ where: { id: other.id } })).available, 40);
  });

  test('the reasons the admin offers are the client\'s lists', () => {
    assert.deepStrictEqual(ADJUST_REASONS.add, ['Customer service goodwill', 'Special bonus', 'Order issue correction', 'Missing points']);
    assert.deepStrictEqual(ADJUST_REASONS.deduct, ['Order issue correction', 'Duplicate points', 'Points recovery', 'Policy abuse']);
  });
});
