// web/loyalty/service/privacy.js
//
// Shopify's mandatory privacy webhooks.
//
//   customers/data_request  recordDataRequest: stored (idempotent on Shopify's request id); the merchant sees the customer's data
//                           on the console's "Data requests" screen (dataRequestDetail) and passes it on.
//   customers/redact        redactCustomer: the account's customer id is replaced by a random token, free-text notes are cleared,
//                           stored webhook payloads for that customer are blanked (SQL function redact_customer).
//   shop/redact             eraseShop: every row of the shop is deleted (SQL function redact_shop).
//
// The ledger and the audit log are insert-only (database triggers). The two SQL functions are the only way around that: each
// runs only when its own transaction first sets rewardpoints.redact_allowed = 'on' (done here, transaction-local), and the triggers
// give way only while a function is running. Audit rows written here carry OUR account key, never the Shopify customer id.

import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { decimal, iso } from '../../admin/data/util.js';

const DIGITS = /^\d{1,20}$/;
const SHOP = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
export const REDACTED_PREFIX = 'redacted-';
const newToken = () => `${REDACTED_PREFIX}${crypto.randomBytes(16).toString('hex')}`;

const idOf = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : typeof v === 'string' && DIGITS.test(v) ? v : null);
const idList = (v) => (Array.isArray(v) ? [...new Set(v.map(idOf).filter(Boolean))].slice(0, 5000) : []);

/** Lets the SQL functions run inside this transaction only. */
const allowRedaction = (tx) => tx.$executeRaw`SELECT set_config('rewardpoints.redact_allowed', 'on', true)`;

/**
 * customers/redact.
 * @param {{ shop: string, payload: { customer?: { id?: any }, orders_to_redact?: any[] } }} p
 * @returns {Promise<{ matched: boolean, counts?: object }>}
 */
export async function redactCustomer({ shop, payload }) {
  if (!SHOP.test(String(shop))) throw new Error('customers/redact: invalid shop');
  const customerId = idOf(payload?.customer?.id);
  if (!customerId) return { matched: false }; // nothing identifies a customer: nothing to redact
  const orders = idList(payload?.orders_to_redact);

  return prisma.$transaction(async (tx) => {
    await allowRedaction(tx);
    const rows = await tx.$queryRaw`SELECT redact_customer(${shop}, ${customerId}, ${orders}::text[], ${newToken()}) AS result`;
    const counts = rows[0].result;
    await tx.auditLog.create({
      data: { shop, adminId: null, action: 'customer_redacted', detail: { accountId: counts.accountId, matched: counts.matched, ledgerNotesCleared: counts.ledgerNotesCleared, auditRowsScrubbed: counts.auditRowsScrubbed, webhookPayloadsBlanked: counts.webhookPayloadsBlanked } },
    });
    return { matched: counts.matched, counts };
  }, { timeout: 30_000 });
}

/**
 * shop/redact: erases every row of the shop. Returns row counts per table (no ids); a JobRun without a shop keeps the fact that it
 * happened (the shop domain only as a short hash).
 */
export async function eraseShop({ shop }) {
  if (!SHOP.test(String(shop))) throw new Error('shop/redact: invalid shop');
  const deleted = await prisma.$transaction(async (tx) => {
    await allowRedaction(tx);
    const rows = await tx.$queryRaw`SELECT redact_shop(${shop}) AS result`;
    return rows[0].result;
  }, { timeout: 120_000 });
  await prisma.jobRun.create({
    data: { shop: null, jobType: 'shop_redact', status: 'completed', completedAt: new Date(), result: { shopHash: crypto.createHash('sha256').update(shop).digest('hex').slice(0, 12), deleted } },
  });
  return { deleted };
}

/**
 * customers/data_request: stored once per Shopify request id (Shopify may deliver twice). Only the customer id and the order ids
 * are kept; the e-mail and phone in the payload are not stored.
 */
export async function recordDataRequest({ shop, payload }) {
  if (!SHOP.test(String(shop))) throw new Error('customers/data_request: invalid shop');
  const customerId = idOf(payload?.customer?.id);
  const requestId = idOf(payload?.data_request?.id);
  if (!customerId || !requestId) return { stored: false };
  const account = await prisma.loyaltyAccount.findUnique({ where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: customerId } }, select: { id: true } });
  const existing = await prisma.dataRequest.findUnique({ where: { shop_shopifyRequestId: { shop, shopifyRequestId: requestId } } });
  if (existing) return { stored: true, duplicate: true, id: existing.id };
  try {
    const row = await prisma.dataRequest.create({
      data: { shop, shopifyRequestId: requestId, shopifyCustomerId: customerId, accountId: account?.id ?? null, ordersRequested: idList(payload?.orders_requested) },
    });
    await prisma.auditLog.create({ data: { shop, adminId: null, action: 'data_request_received', detail: { requestId, accountId: account?.id ?? null, hasAccount: account !== null } } });
    return { stored: true, duplicate: false, id: row.id };
  } catch (err) {
    if (err.code === 'P2002') return { stored: true, duplicate: true }; // two deliveries at once
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The console's Data requests screen
// ---------------------------------------------------------------------------

export async function listDataRequests(shop) {
  const rows = await prisma.dataRequest.findMany({ where: { shop }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 });
  return rows.map((r) => ({
    id: r.id, requestId: r.shopifyRequestId, customerId: r.shopifyCustomerId, redacted: r.shopifyCustomerId.startsWith(REDACTED_PREFIX),
    hasAccount: r.accountId !== null, status: r.status, receivedAt: iso(r.createdAt), completedAt: iso(r.completedAt),
  }));
}

/** What we hold about the customer: account, ledger, orders (with refunds), reward codes. Field by field, no ids of ours. */
export async function dataRequestDetail(shop, id) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(String(id))) return null;
  const request = await prisma.dataRequest.findFirst({ where: { id, shop } });
  if (!request) return null;
  const head = {
    id: request.id, requestId: request.shopifyRequestId, customerId: request.shopifyCustomerId, status: request.status,
    receivedAt: iso(request.createdAt), completedAt: iso(request.completedAt), ordersRequested: Array.isArray(request.ordersRequested) ? request.ordersRequested : [],
  };
  const account = request.accountId ? await prisma.loyaltyAccount.findFirst({ where: { id: request.accountId, shop } }) : null;
  if (!account || account.redactedAt) {
    return { ...head, redacted: Boolean(account?.redactedAt) || request.shopifyCustomerId.startsWith(REDACTED_PREFIX), account: null, ledger: [], orders: [], rewards: [], currency: null };
  }
  const config = await prisma.loyaltyConfig.findUnique({ where: { shop }, select: { currency: true } });
  const [entries, orders, rewards] = await Promise.all([
    prisma.ledgerEntry.findMany({ where: { accountId: account.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 5000 }),
    prisma.loyaltyOrder.findMany({ where: { accountId: account.id, shop }, orderBy: { processedAt: 'asc' }, take: 5000, include: { refunds: true } }),
    prisma.reward.findMany({ where: { accountId: account.id, shop }, orderBy: { createdAt: 'asc' }, take: 1000 }),
  ]);
  return {
    ...head,
    redacted: false,
    currency: config?.currency ?? null,
    account: { available: account.available, pending: account.pending, owed: account.debt, memberSince: iso(account.createdAt) },
    ledger: entries.map((e) => ({ date: iso(e.createdAt), type: e.type, points: e.points, status: e.status, note: e.note })),
    orders: orders.map((o) => ({
      orderRef: o.shopifyOrderId, processedAt: iso(o.processedAt), eligible: decimal(o.eligibleAmountPaise), pointsEarned: o.pointsEarned,
      refunds: o.refunds.map((r) => ({ date: iso(r.createdAt), pointsReversed: r.pointsReversed, refundAmount: decimal(r.refundAmountPaise), cancellation: r.isFullCancellation })),
    })),
    rewards: rewards.map((r) => ({ code: r.discountCode, status: r.status, pointsUsed: r.pointsUsed, value: decimal(r.valueInPaise), createdAt: iso(r.createdAt), expiresAt: iso(r.expiresAt) })),
  };
}

export async function markDataRequestSent({ shop, id, adminId = null, shopifyUserId = null }) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(String(id))) return null;
  const row = await prisma.dataRequest.findFirst({ where: { id, shop } });
  if (!row) return null;
  if (row.status === 'sent') return { alreadySent: true };
  await prisma.$transaction([
    prisma.dataRequest.update({ where: { id }, data: { status: 'sent', completedAt: new Date() } }),
    prisma.auditLog.create({ data: { shop, adminId, shopifyUserId, action: 'data_request_sent', detail: { requestId: row.shopifyRequestId, accountId: row.accountId } } }),
  ]);
  return { alreadySent: false };
}
