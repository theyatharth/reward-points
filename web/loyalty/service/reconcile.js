// web/loyalty/service/reconcile.js
//
// Reconciliation and cache rebuild.
//
// The authoritative records are the point LOTS (what each order's points are worth now)
// and the immutable LEDGER. The balances on LoyaltyAccount (available, pending, debt) are a
// CACHE of them. The ledger identity ties the three together:
//
//     sum of every ledger entry's points  =  available + pending - debt
//     available = sum of ACTIVE lots' remaining      pending = sum of PENDING lots' remaining
//
// reconcileAccount() reports where an account breaks those rules (read only).
// rebuildCache() puts the cache right: available and pending from the lots, debt from the
// identity. It refuses when the identity would need a NEGATIVE debt (the ledger says the
// customer has more than the lots can account for): that is not a cache problem, a person
// has to look. Every rebuild writes an AuditLog row with the before and after values.
//
// runReconciliation() walks a shop's accounts, optionally repairs, and records the result in
// JobRun.result. The worker runs it nightly (runNightlyReconciliation); the admin calls it on demand.

import { prisma } from '../../lib/prisma.js';
import { now } from '../adapters/clock.js';
import { lockAccount } from './ledger.js';
import { recordJob, ranWithin } from './jobrun.js';

const PAGE = 200;
const MAX_ACCOUNTS_PER_RUN = 5000;
const MAX_DISCREPANCIES_LISTED = 100;
const HOUR_MS = 60 * 60 * 1000;

/** UTC hour (0 to 23) from which the nightly run is due. 21:00 UTC is 02:30 in India. */
export const NIGHTLY_HOUR_UTC = Number(process.env.NIGHTLY_HOUR_UTC ?? 21);

const sum = (rows, key) => rows.reduce((t, r) => t + r[key], 0);

/**
 * Finds every way one account breaks the rules above. Read only.
 * @returns {Promise<Array<{ code: string, detail: string, expected?: number, found?: number }>>}
 */
export async function reconcileAccount(accountId) {
  const account = await prisma.loyaltyAccount.findUnique({ where: { id: accountId } });
  if (!account) return [{ code: 'account_missing', detail: `account ${accountId} not found` }];

  const [lots, entries, orders, refunds] = await Promise.all([
    prisma.pointLot.findMany({ where: { accountId }, select: { id: true, status: true, remaining: true, originalPoints: true } }),
    prisma.ledgerEntry.findMany({ where: { accountId }, select: { type: true, points: true, orderId: true } }),
    prisma.loyaltyOrder.findMany({ where: { accountId }, select: { id: true, shopifyOrderId: true, pointsEarned: true } }),
    prisma.loyaltyRefund.findMany({ where: { accountId }, select: { loyaltyOrderId: true, pointsReversed: true } }),
  ]);

  const found = [];
  const flag = (code, detail, expected, found_) => found.push({ code, detail, ...(expected === undefined ? {} : { expected, found: found_ }) });

  const active = sum(lots.filter((l) => l.status === 'active'), 'remaining');
  const pending = sum(lots.filter((l) => l.status === 'pending'), 'remaining');
  if (account.available !== active) flag('available_mismatch', 'available differs from the sum of active lots', active, account.available);
  if (account.pending !== pending) flag('pending_mismatch', 'pending differs from the sum of pending lots', pending, account.pending);
  if (account.debt < 0) flag('negative_debt', 'debt is below 0', 0, account.debt);
  if (account.available < 0) flag('negative_available', 'available is below 0', 0, account.available);
  for (const lot of lots) {
    if (lot.remaining < 0) flag('negative_lot', `lot ${lot.id} has a negative remaining`, 0, lot.remaining);
    if (lot.remaining > lot.originalPoints) flag('lot_over_original', `lot ${lot.id} remaining exceeds the points it started with`, lot.originalPoints, lot.remaining);
  }

  const ledgerSum = sum(entries, 'points');
  const balance = account.available + account.pending - account.debt;
  if (ledgerSum !== balance) flag('ledger_identity', 'the ledger does not add up to available + pending - debt', ledgerSum, balance);

  const reversedByOrder = new Map();
  for (const r of refunds) reversedByOrder.set(r.loyaltyOrderId, (reversedByOrder.get(r.loyaltyOrderId) || 0) + r.pointsReversed);
  const ledgerReversedByOrder = new Map(); // what the immutable ledger says was taken back for each order
  for (const e of entries) {
    if ((e.type === 'refund' || e.type === 'cancel') && e.orderId) ledgerReversedByOrder.set(e.orderId, (ledgerReversedByOrder.get(e.orderId) || 0) - e.points);
  }
  for (const o of orders) {
    const reversed = reversedByOrder.get(o.id) || 0;
    // The client engine's "Incorrect reversal" check: the ledger's refund and cancel entries must equal the reversals recorded on the order.
    const inLedger = ledgerReversedByOrder.get(o.id) || 0;
    if (inLedger !== reversed) flag('reversal_mismatch', `order ${o.shopifyOrderId}: the ledger reversed ${inLedger} points, the order records ${reversed}`, reversed, inLedger);
    if (reversed > o.pointsEarned) flag('order_over_reversed', `order ${o.shopifyOrderId} has more points reversed than it earned`, o.pointsEarned, reversed);
    const earnEntry = entries.find((e) => e.type === 'earn' && e.orderId === o.id);
    if (!earnEntry) flag('order_without_earn_entry', `order ${o.shopifyOrderId} has no earn ledger entry`);
    else if (earnEntry.points !== o.pointsEarned) flag('earn_entry_mismatch', `order ${o.shopifyOrderId}: earn entry differs from pointsEarned`, o.pointsEarned, earnEntry.points);
  }
  return found;
}

/**
 * Rebuilds one account's cached balances from its lots and the ledger (see the header).
 * Takes the account lock, so it is safe beside refunds and redemptions.
 *
 * @returns {Promise<{ changed: boolean, refused?: string, before: object, after?: object }>}
 */
export async function rebuildCache(accountId, { reason = 'rebuild_cache' } = {}) {
  return prisma.$transaction(async (tx) => {
    await lockAccount(tx, accountId, 'rebuild');
    const account = await tx.loyaltyAccount.findUnique({ where: { id: accountId } });
    const lots = await tx.pointLot.findMany({ where: { accountId }, select: { status: true, remaining: true } });
    const entries = await tx.ledgerEntry.findMany({ where: { accountId }, select: { points: true } });

    const before = { available: account.available, pending: account.pending, debt: account.debt };
    const available = sum(lots.filter((l) => l.status === 'active' && l.remaining > 0), 'remaining');
    const pending = sum(lots.filter((l) => l.status === 'pending' && l.remaining > 0), 'remaining');
    const debt = available + pending - sum(entries, 'points');

    if (debt < 0) {
      return { changed: false, refused: `the ledger says the customer holds ${-debt} more points than the lots account for; needs a person`, before };
    }
    const after = { available, pending, debt };
    if (before.available === available && before.pending === pending && before.debt === debt) return { changed: false, before, after };

    await tx.loyaltyAccount.update({ where: { id: accountId }, data: after });
    await tx.auditLog.create({
      data: { shop: account.shop, adminId: null, action: reason, detail: { accountId, before, after } },
    });
    return { changed: true, before, after };
  }, { maxWait: 10000, timeout: 20000 });
}

/**
 * Checks (and with repair = true, rebuilds) every account of a shop, and records the
 * result in a JobRun (jobType 'reconcile').
 *
 * @param {Object} p
 * @param {string} p.shop
 * @param {boolean} [p.repair]    rebuild the cache of accounts with a balance or identity mismatch
 * @param {string}  [p.trigger]   'manual' | 'nightly' (kept in the result)
 * @returns {Promise<Object>} the JobRun result
 */
export async function runReconciliation({ shop, repair = false, trigger = 'manual' }) {
  const startedAt = now();
  try {
    const result = {
      trigger, repair, accountsChecked: 0, accountsWithDiscrepancies: 0, discrepancyCount: 0,
      byCode: {}, discrepancies: [], repaired: 0, unrepairable: [], truncated: false,
    };

    let cursor;
    while (result.accountsChecked < MAX_ACCOUNTS_PER_RUN) {
      const accounts = await prisma.loyaltyAccount.findMany({
        where: { shop }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), select: { id: true, shopifyCustomerId: true },
      });
      if (accounts.length === 0) break;
      for (const account of accounts) {
        result.accountsChecked++;
        const found = await reconcileAccount(account.id);
        if (found.length === 0) continue;
        result.accountsWithDiscrepancies++;
        result.discrepancyCount += found.length;
        for (const d of found) {
          result.byCode[d.code] = (result.byCode[d.code] || 0) + 1;
          if (result.discrepancies.length < MAX_DISCREPANCIES_LISTED) result.discrepancies.push({ shopifyCustomerId: account.shopifyCustomerId, ...d });
          else result.truncated = true;
        }
        const repairable = found.some((d) => ['available_mismatch', 'pending_mismatch', 'ledger_identity', 'negative_debt', 'negative_available'].includes(d.code));
        if (repair && repairable) {
          const rebuilt = await rebuildCache(account.id, { reason: `rebuild_cache:${trigger}` });
          if (rebuilt.changed) result.repaired++;
          if (rebuilt.refused) result.unrepairable.push({ shopifyCustomerId: account.shopifyCustomerId, reason: rebuilt.refused });
        }
      }
      cursor = accounts[accounts.length - 1].id;
      if (accounts.length < PAGE) break;
    }
    result.eventHealth = await eventHealth(shop);

    await recordJob({ jobType: 'reconcile', shop, startedAt, status: 'completed', result });
    return result;
  } catch (err) {
    await recordJob({ jobType: 'reconcile', shop, startedAt, status: 'failed', error: err.message });
    throw err;
  }
}

/** Counts of the shop's webhook events by status, plus how many 'processing' ones look stuck. */
async function eventHealth(shop) {
  const groups = await prisma.webhookEvent.groupBy({ by: ['status'], where: { shop }, _count: { _all: true } });
  const counts = Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
  const stuck = await prisma.webhookEvent.count({ where: { shop, status: 'processing', updatedAt: { lt: new Date(now().getTime() - 10 * 60 * 1000) } } });
  return { ...counts, stuckProcessing: stuck };
}

/**
 * The nightly run: once the UTC hour has reached NIGHTLY_HOUR_UTC, and no nightly run has
 * started in the last 23 hours, reconcile every shop that has accounts (report only, no repair).
 * Writes one umbrella JobRun ('reconcile_nightly') whose existence is the "ran today" marker,
 * plus one 'reconcile' row per shop.
 *
 * @param {Object} [options]
 * @param {string[]} [options.shops] restrict to these shops (tests); default every shop
 * @returns {Promise<{ ran: boolean, shops?: number }>}
 */
export async function runNightlyReconciliation({ shops } = {}) {
  if (now().getUTCHours() < NIGHTLY_HOUR_UTC) return { ran: false };
  const marker = shops ? shops.join(',') : null; // null: the real worker's run over every shop
  if (await ranWithin('reconcile_nightly', 23 * HOUR_MS, marker)) return { ran: false };

  const startedAt = now();
  const names = shops ?? (await prisma.loyaltyAccount.groupBy({ by: ['shop'] })).map((g) => g.shop);
  const summaries = [];
  let failed = 0;
  for (const shop of names) {
    try {
      const r = await runReconciliation({ shop, repair: false, trigger: 'nightly' });
      summaries.push({ shop, accountsChecked: r.accountsChecked, discrepancyCount: r.discrepancyCount });
    } catch (err) {
      failed++;
      summaries.push({ shop, error: err.message });
    }
  }
  await recordJob({ jobType: 'reconcile_nightly', shop: marker, startedAt, status: failed > 0 ? 'failed' : 'completed', result: { shops: summaries }, error: failed > 0 ? `${failed} shop(s) failed` : undefined });
  return { ran: true, shops: names.length };
}
