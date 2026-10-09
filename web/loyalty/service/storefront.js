// web/loyalty/service/storefront.js
//
// What the storefront (the theme blocks, through the App Proxy) may see and do, decision D6:
// responses are built field by field from a WHITELIST. Nothing is ever passed through from a database
// row: no internal ids (account, lot, redemption, ledger entry), no admin names or internal notes, no
// e-mail, name or phone (the ledger holds none, D5). The customer is identified by Shopify customer id,
// taken from the signed request by the route.

import { prisma } from '../../lib/prisma.js';
import { DEFAULT_CONFIG } from '../rules/config.js';
import { redeem } from './redemption.js';

const decimal = (paise) => `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
const iso = (d) => (d ? d.toISOString() : null);

// Customer-facing wording per ledger entry type. The stored note is never shown, except the order
// reference of an earn entry, which has a fixed shape.
const KIND = {
  earn: { kind: 'earned', label: 'Points earned' },
  refund: { kind: 'reversed', label: 'Points reversed for a refund' },
  cancel: { kind: 'reversed', label: 'Points reversed for a cancelled order' },
  redemption: { kind: 'redeemed', label: 'Reward redeemed' },
  reward_return: { kind: 'returned', label: 'Reward points returned' },
  adjustment: { kind: 'adjusted', label: 'Adjustment by Ecofynd' },
  bonus: { kind: 'bonus', label: 'Special bonus from Ecofynd' },
};

async function configFor(shop) {
  return (await prisma.loyaltyConfig.findUnique({ where: { shop } })) || null;
}

/** True when the shop has a loyalty program (a LoyaltyConfig row). */
export async function shopIsConfigured(shop) {
  return (await configFor(shop)) !== null;
}

const REFUSAL_STATUS = {
  INVALID_KEY: 400, SHORT: 400, OWED: 409, RECOVERING: 409, DISCOUNT_FAILED: 502,
  REWARD_VOIDED: 410, REWARD_EXPIRED: 410, REWARD_USED: 410, REWARD_RETURNED: 410,
};

/**
 * Redeems for the calling customer. Returns { status, body }; the body is the whitelist.
 */
export async function redeemForCustomer({ shop, shopifyCustomerId, idempotencyKey }) {
  const config = (await configFor(shop)) || DEFAULT_CONFIG;
  const r = await redeem({ shop, shopifyCustomerId, idempotencyKey });
  if (!r.ok) {
    const body = { success: false, reason: r.reason, message: r.message };
    if (Number.isInteger(r.needed)) body.needed = r.needed;
    if (Number.isInteger(r.owed)) body.owed = r.owed;
    return { status: REFUSAL_STATUS[r.reason] ?? 400, body };
  }
  return {
    status: 200,
    body: {
      success: true,
      status: r.status, // 'active' | 'creating'
      code: r.code, // null while the code is still being created
      pointsUsed: r.pointsUsed,
      value: decimal(r.valuePaise),
      currency: config.currency,
      expiresAt: iso(r.expiresAt),
      balance: { available: r.available },
    },
  };
}

/**
 * The calling customer's balances, rule, pending points, live reward codes and recent history.
 */
export async function customerView({ shop, shopifyCustomerId, limit = 50 }) {
  const config = (await configFor(shop)) || DEFAULT_CONFIG;
  const account = await prisma.loyaltyAccount.findUnique({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: String(shopifyCustomerId) } },
  });

  const view = {
    success: true,
    balance: { available: 0, pending: 0, owed: 0 },
    rule: { pointsPerReward: config.pointsPerReward, rewardValue: decimal(config.rewardValue), currency: config.currency, holdPeriodDays: config.holdPeriodDays },
    pending: [],
    rewards: [],
    history: [],
  };
  if (!account) return view;

  view.balance = { available: account.available, pending: account.pending, owed: account.debt };

  const [lots, rewards, entries] = await Promise.all([
    prisma.pointLot.findMany({ where: { accountId: account.id, status: 'pending', remaining: { gt: 0 } }, orderBy: { activatesAt: 'asc' }, take: 20 }),
    prisma.reward.findMany({ where: { accountId: account.id, status: 'active' }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.ledgerEntry.findMany({ where: { accountId: account.id, points: { not: 0 } }, orderBy: { createdAt: 'desc' }, take: limit }),
  ]);

  view.pending = lots.map((l) => ({ points: l.remaining, availableOn: iso(l.activatesAt) }));
  view.rewards = rewards.map((r) => ({ code: r.discountCode, value: decimal(r.valueInPaise), expiresAt: iso(r.expiresAt) }));
  view.history = entries.map((e) => {
    const k = KIND[e.type] || { kind: 'other', label: 'Points updated' };
    const m = e.type === 'earn' && typeof e.note === 'string' ? /^Order #{1,2}([\w-]{1,30})$/.exec(e.note) : null;
    const order = m ? m[1] : null;
    return { date: iso(e.createdAt), kind: k.kind, points: e.points, label: order ? `${k.label} on order ${order}` : k.label };
  });
  return view;
}
