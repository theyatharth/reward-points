// web/admin/data/orders.js: the Orders & webhooks view.
//
//   GET  /admin/api/orders?cursor=&limit=              orders that earned points, with what was reversed
//   GET  /admin/api/events?status=&topic=&cursor=      the webhook queue, filtered; plus counts per status
//   POST /admin/api/events/:id/retry                   put a failed or dead event back in the queue
//
// An event's payload is never sent: only the order and refund references read out of it. The design's
// "failure simulator" and Return / Refund / Cancel buttons simulate Shopify; here events come from real webhooks.

import { prisma } from '../../lib/prisma.js';
import { audit } from '../auth.js';
import { decimal, iso, limitOf, cursorOf } from './util.js';

const STATUSES = ['pending', 'processing', 'processed', 'failed', 'dead', 'skipped'];
const TOPICS = ['orders/paid', 'refunds/create', 'orders/cancelled'];

const ref = (v) => (typeof v === 'number' || (typeof v === 'string' && /^[\w-]{1,40}$/.test(v)) ? String(v) : null);

export async function listOrders(shop, { cursor, limit } = {}) {
  const take = limitOf(limit, 25, 100);
  const rows = await prisma.loyaltyOrder.findMany({
    where: { shop },
    orderBy: [{ processedAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(cursorOf(cursor) ? { cursor: { id: cursorOf(cursor) } } : {}),
    include: {
      account: { select: { shopifyCustomerId: true } },
      lot: { select: { status: true, remaining: true, activatesAt: true } },
      refunds: { select: { pointsReversed: true, isFullCancellation: true } },
    },
  });
  const page = rows.slice(0, take);
  const usedOn = new Set((await prisma.reward.findMany({ where: { shop, usedOrderId: { in: page.map((o) => o.shopifyOrderId) } }, select: { usedOrderId: true } })).map((r) => r.usedOrderId));

  return {
    orders: page.map((o) => {
      const reversed = o.refunds.reduce((s, r) => s + r.pointsReversed, 0);
      const cancelled = o.refunds.some((r) => r.isFullCancellation);
      return {
        orderRef: o.shopifyOrderId,
        customerId: o.account.shopifyCustomerId,
        processedAt: iso(o.processedAt),
        eligible: decimal(o.eligibleAmountPaise),
        pointsEarned: o.pointsEarned,
        pointsReversed: reversed,
        state: cancelled ? 'cancelled' : reversed === 0 ? 'earned' : reversed >= o.pointsEarned ? 'fully reversed' : 'partly reversed',
        lot: o.lot ? { status: o.lot.status, remaining: o.lot.remaining, activatesAt: iso(o.lot.activatesAt) } : null,
        rewardUsed: usedOn.has(o.shopifyOrderId),
      };
    }),
    nextCursor: rows.length > take ? rows[take].id : null,
  };
}

export async function listEvents(shop, { status, topic, cursor, limit } = {}) {
  const take = limitOf(limit, 25, 100);
  const where = { shop, ...(STATUSES.includes(status) ? { status } : {}), ...(TOPICS.includes(topic) ? { topic } : {}) };
  const [rows, counts] = await Promise.all([
    prisma.webhookEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursorOf(cursor) ? { cursor: { id: cursorOf(cursor) } } : {}),
      select: { id: true, topic: true, status: true, attempts: true, lastError: true, nextRetryAt: true, createdAt: true, payload: true, payloadPurgedAt: true },
    }),
    prisma.webhookEvent.groupBy({ by: ['status'], where: { shop }, _count: { _all: true } }),
  ]);
  const page = rows.slice(0, take);
  return {
    events: page.map((e) => {
      const p = e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload) ? e.payload : {};
      const isOrderEvent = e.topic === 'orders/paid' || e.topic === 'orders/cancelled';
      const purged = e.payloadPurgedAt !== null;
      return {
        id: e.id,
        topic: e.topic,
        status: e.status,
        attempts: e.attempts,
        lastError: e.lastError,
        nextRetryAt: iso(e.nextRetryAt),
        receivedAt: iso(e.createdAt),
        orderRef: isOrderEvent ? ref(p.id) : ref(p.order_id),
        refundRef: e.topic === 'refunds/create' ? ref(p.id) : null,
        purged,
        canRetry: (e.status === 'failed' || e.status === 'dead') && !purged,
      };
    }),
    nextCursor: rows.length > take ? rows[take].id : null,
    counts: Object.fromEntries(STATUSES.map((s) => [s, counts.find((c) => c.status === s)?._count._all ?? 0])),
  };
}

/** @returns {Promise<{ status: number, body: Object }>} */
export async function retryEvent({ shop, adminId, eventId }) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(eventId)) return { status: 404, body: { ok: false, error: 'NOT_FOUND' } };
  const event = await prisma.webhookEvent.findFirst({ where: { id: eventId, shop }, select: { id: true, topic: true, status: true, payloadPurgedAt: true, payload: true } });
  if (!event) return { status: 404, body: { ok: false, error: 'NOT_FOUND' } };
  if (event.payloadPurgedAt) return { status: 409, body: { ok: false, error: 'PAYLOAD_PURGED', message: 'The payload of this event was purged after 90 days, so it cannot be processed again.' } };
  if (event.status !== 'failed' && event.status !== 'dead') {
    return { status: 409, body: { ok: false, error: 'NOT_RETRYABLE', message: `Only failed or dead events can be retried; this one is ${event.status}.` } };
  }
  // Only if it is still failed or dead (the worker may have moved it since it was read). A fresh start: attempts back to 0.
  const moved = await prisma.webhookEvent.updateMany({
    where: { id: event.id, shop, status: { in: ['failed', 'dead'] }, payloadPurgedAt: null },
    data: { status: 'pending', attempts: 0, nextRetryAt: null },
  });
  if (moved.count === 0) return { status: 409, body: { ok: false, error: 'NOT_RETRYABLE', message: 'The event changed while you were looking at it.' } };
  const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
  await audit(shop, adminId, 'event_retried', { eventId: event.id, topic: event.topic, previousStatus: event.status, orderRef: ref(event.topic === 'refunds/create' ? p.order_id : p.id) });
  return { status: 200, body: { ok: true, status: 'pending' } };
}
