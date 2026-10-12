// web/admin/data/notifications.js: the Notifications view (GET /admin/api/notifications?cursor=&limit=).
// A read-only log of the on-site notifications this build writes (points earned, points activated, reward redeemed).
// The design's per-channel switches, e-mail, WhatsApp and the outbox are not part of this version.

import { prisma } from '../../lib/prisma.js';
import { notificationText, NOTIFICATION_TYPES } from '../../loyalty/service/notifications.js';
import { iso, limitOf, cursorOf } from './util.js';

export async function listNotifications(shop, { cursor, limit } = {}) {
  const take = limitOf(limit, 25, 100);
  const config = await prisma.loyaltyConfig.findUnique({ where: { shop }, select: { currency: true } });
  const [rows, counts] = await Promise.all([
    prisma.notification.findMany({
      where: { shop }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: take + 1,
      ...(cursorOf(cursor) ? { cursor: { id: cursorOf(cursor) } } : {}),
      include: { account: { select: { shopifyCustomerId: true } } },
    }),
    prisma.notification.groupBy({ by: ['type'], where: { shop }, _count: { _all: true } }),
  ]);
  const page = rows.slice(0, take);
  return {
    notifications: page.map((n) => ({ type: n.type, customerId: n.account.shopifyCustomerId, text: notificationText(n, config), createdAt: iso(n.createdAt), read: n.readAt !== null })),
    nextCursor: rows.length > take ? rows[take].id : null,
    counts: Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, counts.find((c) => c.type === t)?._count._all ?? 0])),
  };
}
