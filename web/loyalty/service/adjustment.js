// web/loyalty/service/adjustment.js
//
// Manual point adjustments by an admin (a port of the client's engine.adjust()).
//
//   * `points` is a whole number other than 0; positive adds, negative deducts.
//   * a reason is required; a note of at least 5 characters (after trimming); an admin id that
//     names an existing admin of the shop; an idempotency key (a retry never adjusts twice).
//   * a deduction above the AVAILABLE balance is refused (pending points cannot be deducted).
//   * the reason "Special bonus" writes a 'bonus' entry; any other reason an 'adjustment' entry.
//   * a positive adjustment becomes an ACTIVE lot at once and repays an owed balance first (D4),
//     exactly like activated points; a deduction consumes active lots, earliest first.
//   * every adjustment writes an AuditLog row (action 'points_adjusted') in the same transaction.
//
// The account is locked first (lockAccount, tag 'adjust'), so an adjustment cannot interleave with
// a refund, a redemption or an activation on the same account. The customer is identified by Shopify
// customer id only (D5): no name, e-mail or phone is read or stored.

import { prisma } from '../../lib/prisma.js';
import { lockAccount, returnPoints, consumeLots } from './ledger.js';

const TX_OPTIONS = { maxWait: 10000, timeout: 20000 };
export const MAX_ADJUSTMENT = 1_000_000;
export const MIN_NOTE_LENGTH = 5;
const MAX_KEY_LENGTH = 128;

/** The reasons the admin UI offers (the engine accepts any non-empty reason). */
export const ADJUST_REASONS = Object.freeze({
  add: ['Customer service goodwill', 'Special bonus', 'Order issue correction', 'Missing points'],
  deduct: ['Order issue correction', 'Duplicate points', 'Points recovery', 'Policy abuse'],
});
export const BONUS_REASON = 'Special bonus';

const refusal = (reason, message) => ({ ok: false, reason, message });

/**
 * @param {Object} p
 * @param {string} p.shop
 * @param {string|number} p.shopifyCustomerId
 * @param {number} p.points            signed whole number, not 0
 * @param {string} p.reason
 * @param {string} p.note              internal note, at least 5 characters
 * @param {string} [p.adminId]         AdminUser.id of the admin making the change (password console)
 * @param {string} [p.shopifyUserId]   Shopify staff id from the verified session token (embedded console); one of the two is required
 * @param {string} p.idempotencyKey    scoped to the account
 * @returns {Promise<
 *   { ok: true, replayed: boolean, entryId: string, type: 'adjustment'|'bonus', points: number, available: number, debt: number }
 *   | { ok: false, reason: string, message: string }>}
 */
export async function adjustPoints({ shop, shopifyCustomerId, points, reason, note, adminId, shopifyUserId, idempotencyKey }) {
  if (!Number.isInteger(points) || points === 0 || Math.abs(points) > MAX_ADJUSTMENT) {
    return refusal('INVALID_POINTS', 'Enter a whole number of points other than 0.');
  }
  if (typeof reason !== 'string' || reason.trim() === '') return refusal('REASON_REQUIRED', 'Choose a reason.');
  if (typeof note !== 'string' || note.trim().length < MIN_NOTE_LENGTH) {
    return refusal('NOTE_TOO_SHORT', `Add an internal note (at least ${MIN_NOTE_LENGTH} characters) so support can explain this change.`);
  }
  const hasAdmin = typeof adminId === 'string' && adminId !== '';
  const hasShopifyUser = typeof shopifyUserId === 'string' && shopifyUserId !== '';
  if (!hasAdmin && !hasShopifyUser) return refusal('ADMIN_REQUIRED', 'Admin is required.');
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > MAX_KEY_LENGTH) {
    return refusal('INVALID_KEY', 'Missing or invalid request key.');
  }
  reason = reason.trim();
  note = note.trim();

  // The embedded console has no AdminUser: its actor was verified from the session token (shop and sub), so only the id is recorded.
  const admin = hasAdmin ? await prisma.adminUser.findFirst({ where: { id: adminId, shop }, select: { id: true } }) : null;
  if (hasAdmin && !admin) return refusal('ADMIN_UNKNOWN', 'Admin not found.');

  const account = await prisma.loyaltyAccount.findUnique({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: String(shopifyCustomerId) } },
  });
  if (!account) return refusal('NO_ACCOUNT', 'Customer has no rewards account.');

  const isBonus = reason === BONUS_REASON && points > 0;
  const type = isBonus ? 'bonus' : 'adjustment';
  // LedgerEntry.dedupeKey is unique across ALL accounts, so the caller's key is scoped by account.
  const dedupeKey = `adjust:${account.id}:${idempotencyKey}`;

  try {
    return await prisma.$transaction(async (tx) => {
      await lockAccount(tx, account.id, 'adjust');

      // A retry (or a concurrent duplicate that waited on the lock) finds the first one's entry.
      const earlier = await tx.ledgerEntry.findFirst({ where: { dedupeKey } });
      if (earlier) {
        const current = await tx.loyaltyAccount.findUnique({ where: { id: account.id } });
        return { ok: true, replayed: true, entryId: earlier.id, type: earlier.type, points: earlier.points, available: current.available, debt: current.debt };
      }

      const before = await tx.loyaltyAccount.findUnique({ where: { id: account.id } });
      if (points < 0 && -points > before.available) {
        return refusal('EXCEEDS_AVAILABLE', `Deduction exceeds the available balance of ${before.available} points.`);
      }

      let entryId;
      const label = `${points > 0 ? 'Added' : 'Deducted'} by Ecofynd: ${reason}`;
      if (points > 0) {
        const given = await returnPoints(tx, {
          accountId: account.id, points, type, lotTag: `adjust:${idempotencyKey}:${account.id}`, dedupeKey,
          note: isBonus ? 'Special bonus from Ecofynd' : label,
        });
        entryId = given.entryId;
      } else {
        await consumeLots(tx, account.id, -points);
        const entry = await tx.ledgerEntry.create({
          data: { accountId: account.id, type, points, status: 'active', dedupeKey, note: label },
        });
        entryId = entry.id;
        await tx.loyaltyAccount.update({ where: { id: account.id }, data: { available: { decrement: -points } } });
      }

      const after = await tx.loyaltyAccount.findUnique({ where: { id: account.id } });
      await tx.auditLog.create({
        data: {
          shop,
          adminId: admin ? admin.id : null,
          shopifyUserId: admin ? null : shopifyUserId,
          action: 'points_adjusted',
          detail: {
            accountId: account.id, ledgerEntryId: entryId, type, points, reason, note,
            before: { available: before.available, pending: before.pending, debt: before.debt },
            after: { available: after.available, pending: after.pending, debt: after.debt },
          },
        },
      });
      return { ok: true, replayed: false, entryId, type, points, available: after.available, debt: after.debt };
    }, TX_OPTIONS);
  } catch (err) {
    if (err.code === 'P2002') {
      // Lost a race that the lock should have prevented: report the stored outcome.
      const entry = await prisma.ledgerEntry.findFirst({ where: { dedupeKey } });
      if (entry) {
        const current = await prisma.loyaltyAccount.findUnique({ where: { id: account.id } });
        return { ok: true, replayed: true, entryId: entry.id, type: entry.type, points: entry.points, available: current.available, debt: current.debt };
      }
    }
    throw err;
  }
}
