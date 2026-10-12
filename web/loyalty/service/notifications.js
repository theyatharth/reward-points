// web/loyalty/service/notifications.js
//
// On-site notifications (decision D8: on-site only; e-mail and WhatsApp are out of scope).
//
//   points_earned     an order's points are on the way          data: { points, orderRef }
//   points_activated  points became available                   data: { points }
//   reward_redeemed   a reward code was issued                  data: { pointsUsed, valuePaise }
//
// notify() is called INSIDE the ledger transaction that writes the entry it describes, with a dedupe key built from the
// same event, so a redelivered webhook or a retried job writes nothing twice. Only numbers and an order name are stored;
// notificationText() builds the sentence when it is read, from the shop's rule (currency, reward value).

import { prisma } from '../../lib/prisma.js';

export const NOTIFICATION_TYPES = ['points_earned', 'points_activated', 'reward_redeemed'];

/** Writes one notification inside the caller's transaction. A repeated dedupeKey is silently ignored. */
export async function notify(tx, { accountId, shop, type, data, dedupeKey }) {
  await tx.notification.createMany({ data: [{ accountId, shop, type, data, dedupeKey }], skipDuplicates: true });
}

const P = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');
const SYMBOL = { INR: '₹', USD: '$' };
const money = (paise, currency) => {
  const v = Number(paise) / 100;
  return (SYMBOL[currency] ?? `${currency} `) + v.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
};

/** The sentence for a notification. Unknown types and odd data give a neutral line, never an error. */
export function notificationText({ type, data }, config) {
  const d = data && typeof data === 'object' ? data : {};
  const currency = config?.currency ?? 'INR';
  if (type === 'points_earned') return `You're earning ${P(d.points)} points${d.orderRef ? ` on order ${String(d.orderRef).slice(0, 30)}` : ''}`;
  if (type === 'points_activated') return `${P(d.points)} points are now available to use`;
  if (type === 'reward_redeemed') return `Your ${money(d.valuePaise, currency)} reward is ready to use (${P(d.pointsUsed)} points)`;
  return 'Your rewards were updated';
}

/** The customer's latest notifications as the storefront may see them: a whitelist, no ids. */
export async function listForAccount(accountId, config, limit = 10) {
  const [rows, unread] = await Promise.all([
    prisma.notification.findMany({ where: { accountId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit }),
    prisma.notification.count({ where: { accountId, readAt: null } }),
  ]);
  return {
    unread,
    items: rows.map((n) => ({ type: n.type, text: notificationText(n, config), date: n.createdAt.toISOString(), read: n.readAt !== null })),
  };
}

/** Marks all of one account's notifications read. */
export async function markAllRead(accountId) {
  const done = await prisma.notification.updateMany({ where: { accountId, readAt: null }, data: { readAt: new Date() } });
  return done.count;
}
