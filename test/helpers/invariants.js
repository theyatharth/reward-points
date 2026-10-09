// test/helpers/invariants.js
//
// The ledger invariants (decision D4). Call after every step of a test that moves points.
//
//   available = sum of ACTIVE lots' remaining
//   pending   = sum of PENDING lots' remaining
//   debt     >= 0, available >= 0, and no lot has a negative remaining
//
// assertLedgerBalances adds the identity that ties the immutable ledger to the balances:
//   sum of every ledger entry's points = available + pending - debt
// (activation entries carry 0 points; a reversal entry carries the whole reversal, whether it was
// taken from lots, from voided rewards or added to debt.) It only holds for accounts whose lots
// are all backed by ledger entries, so tests that insert lots directly use assertLedgerInvariants alone.

import assert from 'node:assert/strict';

export async function assertLedgerInvariants(prisma, accountId, label = '') {
  const at = label ? ` [${label}]` : '';
  const account = await prisma.loyaltyAccount.findUnique({ where: { id: accountId } });
  assert.ok(account, `account ${accountId} exists${at}`);
  const lots = await prisma.pointLot.findMany({ where: { accountId } });

  const sum = (status) => lots.filter((l) => l.status === status).reduce((t, l) => t + l.remaining, 0);
  assert.ok(lots.every((l) => l.remaining >= 0), `no lot has a negative remaining${at}`);
  assert.ok(account.debt >= 0, `debt >= 0 (is ${account.debt})${at}`);
  assert.ok(account.available >= 0, `available >= 0 (is ${account.available})${at}`);
  assert.strictEqual(account.available, sum('active'), `available = sum of active lots (${at.trim() || 'account'} ${accountId})`);
  assert.strictEqual(account.pending, sum('pending'), `pending = sum of pending lots (${at.trim() || 'account'} ${accountId})`);
  return account;
}

export async function assertLedgerBalances(prisma, accountId, label = '') {
  const account = await assertLedgerInvariants(prisma, accountId, label);
  const entries = await prisma.ledgerEntry.findMany({ where: { accountId }, select: { points: true } });
  const total = entries.reduce((t, e) => t + e.points, 0);
  assert.strictEqual(total, account.available + account.pending - account.debt,
    `ledger sum ${total} = available ${account.available} + pending ${account.pending} - debt ${account.debt}${label ? ` [${label}]` : ''}`);
  return account;
}

/** assertLedgerInvariants for every account of a shop (and, with balances = true, the ledger identity too). */
export async function assertShopInvariants(prisma, shop, { balances = true } = {}) {
  const accounts = await prisma.loyaltyAccount.findMany({ where: { shop }, select: { id: true } });
  for (const { id } of accounts) await (balances ? assertLedgerBalances : assertLedgerInvariants)(prisma, id, shop);
}
