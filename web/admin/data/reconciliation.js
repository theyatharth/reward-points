// web/admin/data/reconciliation.js: the Reconciliation view.
//
//   GET  /admin/api/reconciliation       the last stored run (JobRun 'reconcile'), whitelisted
//   POST /admin/api/reconciliation/run   run it now (report only; repairs are a script, audited)
//
// The result is read from JobRun.result field by field; the same shape comes back from a run.

import { prisma } from '../../lib/prisma.js';
import { runReconciliation } from '../../loyalty/service/reconcile.js';
import { iso } from './util.js';

// What each finding code means, in words an operator can act on.
export const CODE_HELP = {
  available_mismatch: 'The cached available balance differs from the sum of the active lots.',
  pending_mismatch: 'The cached pending balance differs from the sum of the pending lots.',
  ledger_identity: 'The ledger does not add up to available + pending - owed.',
  negative_debt: 'The owed balance is below 0.',
  negative_available: 'The available balance is below 0.',
  negative_lot: 'A point lot has a negative remaining.',
  lot_over_original: 'A lot holds more points than it started with.',
  order_over_reversed: 'An order has more points reversed than it earned.',
  order_without_earn_entry: 'An order has no earn entry in the ledger.',
  earn_entry_mismatch: 'An order\'s earn entry differs from the points recorded on the order.',
  reversal_mismatch: 'The ledger\'s refund and cancel entries for an order differ from the reversals recorded on it.',
  account_missing: 'An account could not be found.',
};

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const text = (v, max = 300) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, max) : '');

/** One stored result, reduced to a whitelist. */
export function shapeResult(result, row) {
  const r = result && typeof result === 'object' ? result : {};
  return {
    at: iso(row.completedAt ?? row.startedAt),
    status: row.status,
    trigger: text(r.trigger, 20) || null,
    accountsChecked: n(r.accountsChecked),
    accountsWithDiscrepancies: n(r.accountsWithDiscrepancies),
    discrepancyCount: n(r.discrepancyCount),
    byCode: Object.fromEntries(Object.entries(r.byCode && typeof r.byCode === 'object' ? r.byCode : {}).map(([k, v]) => [text(k, 60), n(v)])),
    discrepancies: (Array.isArray(r.discrepancies) ? r.discrepancies : []).slice(0, 100).map((d) => ({
      shopifyCustomerId: text(d?.shopifyCustomerId, 30),
      code: text(d?.code, 60),
      detail: text(d?.detail),
      expected: d && d.expected !== undefined ? n(d.expected) : null,
      found: d && d.found !== undefined ? n(d.found) : null,
      help: CODE_HELP[d?.code] ?? null,
    })),
    truncated: r.truncated === true,
    unrepairable: (Array.isArray(r.unrepairable) ? r.unrepairable : []).slice(0, 50).map((u) => ({ shopifyCustomerId: text(u?.shopifyCustomerId, 30), reason: text(u?.reason) })),
    eventHealth: Object.fromEntries(Object.entries(r.eventHealth && typeof r.eventHealth === 'object' ? r.eventHealth : {}).map(([k, v]) => [text(k, 30), n(v)])),
  };
}

export async function lastReconciliation(shop) {
  const row = await prisma.jobRun.findFirst({ where: { shop, jobType: 'reconcile' }, orderBy: { startedAt: 'desc' } });
  return row ? { last: shapeResult(row.result, row) } : { last: null };
}

const running = new Set();

/** @returns {Promise<{ status: number, body: Object }>} */
export async function runNow(shop) {
  if (running.has(shop)) return { status: 409, body: { ok: false, error: 'ALREADY_RUNNING', message: 'A reconciliation is already running.' } };
  running.add(shop);
  try {
    const result = await runReconciliation({ shop, repair: false, trigger: 'manual' });
    const row = await prisma.jobRun.findFirst({ where: { shop, jobType: 'reconcile' }, orderBy: { startedAt: 'desc' } });
    return { status: 200, body: { ok: true, last: shapeResult(result, row ?? { status: 'completed', startedAt: new Date() }) } };
  } finally {
    running.delete(shop);
  }
}
