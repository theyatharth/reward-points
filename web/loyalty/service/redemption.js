// web/loyalty/service/redemption.js
//
// T3.1: Redemption service (spec section 8).
//
// Sequence, in order:
//   1. J3-check any due pending lots against Shopify (network, no lock held)
//   2. Transaction: lock the account row, activate the cleared lots, refuse if
//      owed or short, insert the Redemption as 'creating', consume lots,
//      write the 'redemption' ledger entry, commit
//   3. After commit: create the Shopify discount (customer-bound, single use,
//      expires after rewardExpiryDays). On failure write a compensating
//      'reward_return' entry.
//
// The Shopify call never happens inside the transaction, so a slow Shopify
// never holds the account lock. The price of that is the 'creating' state: a
// crash between commit and the Shopify call leaves a redemption that
// resolveRedemption() settles (the T3.5 worker job calls it).

import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { DEFAULT_CONFIG } from '../rules/config.js';
import { formatPaise } from '../rules/money.js';
import { now } from '../adapters/clock.js';
import { gatewayFactory, lockAccount, checkLotJ3, activateLotInTx } from './ledger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TX_OPTIONS = { maxWait: 10000, timeout: 20000 };
const MAX_KEY_LENGTH = 128;

// No 0/O/1/I, to avoid support ambiguity.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(shop) {
  const prefix = shop.split('.')[0].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  const suffix = Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${prefix}-${suffix}`;
}

// Shopify wants a decimal string in major units, e.g. 5000 paise -> "50.00".
function paiseToDecimal(paise) {
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

async function loadConfig(shop) {
  const row = await prisma.loyaltyConfig.findUnique({ where: { shop } });
  return row || DEFAULT_CONFIG;
}

function refusal(reason, message, extra = {}) {
  return { ok: false, reason, message, ...extra };
}

/**
 * Redeems every whole reward the account can afford into one Shopify code.
 *
 * @param {Object} params
 * @param {string} params.shop
 * @param {string|number} params.shopifyCustomerId  from the signed proxy query, never the body
 * @param {string} params.idempotencyKey            from the request body, scoped to the account
 * @returns {Promise<
 *   { ok: true, status: 'active'|'creating', replayed: boolean, redemptionId: string,
 *     code: string|null, pointsUsed: number, valuePaise: number, expiresAt: Date|null, available: number }
 *   | { ok: false, reason: 'INVALID_KEY'|'OWED'|'SHORT'|'RECOVERING'|'DISCOUNT_FAILED'|'REWARD_VOIDED', message: string }
 * >}
 */
export async function redeem({ shop, shopifyCustomerId, idempotencyKey }) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > MAX_KEY_LENGTH) {
    return refusal('INVALID_KEY', 'Missing or invalid request key.');
  }

  const config = await loadConfig(shop);
  const customerId = String(shopifyCustomerId);

  const account = await prisma.loyaltyAccount.findUnique({
    where: { shop_shopifyCustomerId: { shop, shopifyCustomerId: customerId } },
  });
  if (!account) {
    return refusal('SHORT', `You need ${plural(config.pointsPerReward, 'more point')} to redeem.`, {
      needed: config.pointsPerReward,
    });
  }

  // A replay returns the stored outcome without touching Shopify again.
  const earlier = await findRedemption(account.id, idempotencyKey);
  if (earlier) return replayResult(earlier);

  // J3: before any due lot becomes spendable, ask Shopify whether the order
  // has refunds we have not applied. Done before the transaction because it is
  // a network call per lot.
  const dueLots = await prisma.pointLot.findMany({
    where: { accountId: account.id, status: 'pending', activatesAt: { lte: now() } },
    include: { orders: { select: { id: true } } },
    orderBy: { activatesAt: 'asc' },
  });
  const cleared = [];
  let recovering = false;
  for (const lot of dueLots) {
    const loyaltyOrderId = lot.orders[0]?.id;
    if (!loyaltyOrderId) continue;
    const j3 = await checkLotJ3(lot, loyaltyOrderId, shop);
    if (j3.ok) cleared.push({ lotId: lot.id, loyaltyOrderId });
    else recovering = true;
  }

  let outcome;
  try {
    outcome = await prisma.$transaction(async (tx) => {
      await lockAccount(tx, account.id, 'redeem');

      // A concurrent duplicate waited on the lock; it now sees the first one's row.
      const existing = await tx.redemption.findUnique({
        where: { accountId_idempotencyKey: { accountId: account.id, idempotencyKey } },
      });
      if (existing) return { kind: 'replay', redemption: existing };

      for (const c of cleared) {
        await activateLotInTx(tx, c.lotId, c.loyaltyOrderId);
      }

      // Read the balance only now, under the lock and after activation.
      const fresh = await tx.loyaltyAccount.findUnique({ where: { id: account.id } });

      // Refusals return (not throw), so the activations above still commit.
      // D4: the owed balance is the debt column; available is never below 0.
      const owed = fresh.debt;
      if (owed > 0) {
        return {
          kind: 'refused',
          result: refusal(
            'OWED',
            'Your points balance is paused while points from a returned order are recovered. ' +
              'New points will be used to clear it first.',
            { owed }
          ),
        };
      }

      const chunks = Math.floor(fresh.available / config.pointsPerReward);
      if (chunks < 1) {
        if (recovering) {
          return {
            kind: 'refused',
            result: refusal(
              'RECOVERING',
              'Some of your points are being checked against a recent return. Please try again shortly.'
            ),
          };
        }
        const needed = config.pointsPerReward - fresh.available;
        return {
          kind: 'refused',
          result: refusal('SHORT', `You need ${plural(needed, 'more point')} to redeem.`, { needed }),
        };
      }

      const pointsUsed = chunks * config.pointsPerReward;
      const rewardValuePaise = chunks * config.rewardValue;

      // The code is stored before commit so a crash can still be resolved by
      // looking it up in Shopify.
      const redemption = await tx.redemption.create({
        data: {
          accountId: account.id,
          shop,
          idempotencyKey,
          pointsUsed,
          rewardValuePaise,
          status: 'creating',
          discountCode: generateCode(shop),
          expiresAt: new Date(now().getTime() + config.rewardExpiryDays * DAY_MS),
        },
      });

      await consumeLots(tx, account.id, pointsUsed);

      await tx.ledgerEntry.create({
        data: {
          accountId: account.id,
          type: 'redemption',
          points: -pointsUsed,
          status: 'active',
          // LedgerEntry.dedupeKey is unique across ALL accounts, so the
          // client's key must be scoped here or two customers sending the same
          // key would collide.
          dedupeKey: `redeem:${account.id}:${idempotencyKey}`,
          note: `Redeemed ${formatPaise(rewardValuePaise, config.currency)} reward`,
          redemptionId: redemption.id,
        },
      });

      await tx.loyaltyAccount.update({
        where: { id: account.id },
        data: { available: { decrement: pointsUsed } },
      });

      return { kind: 'created', redemption };
    }, TX_OPTIONS);
  } catch (err) {
    if (err.code === 'P2002') {
      const raced = await findRedemption(account.id, idempotencyKey);
      if (raced) return replayResult(raced);
    }
    throw err;
  }

  if (outcome.kind === 'refused') return outcome.result;
  if (outcome.kind === 'replay') return replayResult(outcome.redemption);

  return issueDiscount(outcome.redemption, customerId, config);
}

/**
 * Takes points from the account's active lots, earliest activation first.
 * Points not backed by any lot (none expected in Phase 1) are simply taken
 * from the balance.
 */
async function consumeLots(tx, accountId, points) {
  const lots = await tx.$queryRaw`
    SELECT id, remaining FROM "PointLot"
     WHERE "accountId" = ${accountId} AND status = 'active' AND remaining > 0
     ORDER BY "activatesAt" ASC, "createdAt" ASC, id ASC
       FOR UPDATE`;
  let left = points;
  for (const lot of lots) {
    if (left === 0) break;
    const take = Math.min(left, lot.remaining);
    await tx.pointLot.update({
      where: { id: lot.id },
      data: { remaining: { decrement: take }, status: take === lot.remaining ? 'exhausted' : undefined },
    });
    left -= take;
  }
}

async function issueDiscount(redemption, customerId, config) {
  const gw = gatewayFactory(redemption.shop);
  try {
    const { id } = await gw.createRewardDiscount({
      code: redemption.discountCode,
      title: `Reward Points — ${formatPaise(redemption.rewardValuePaise, config.currency)} off`,
      amount: paiseToDecimal(redemption.rewardValuePaise),
      customerId,
      startsAt: now(),
      endsAt: redemption.expiresAt,
    });
    return completeRedemption(redemption.id, id, false);
  } catch (err) {
    // Shopify said no: nothing exists, give the points back now.
    if (err.definitive) return compensateRedemption(redemption.id);
    // Anything else is ambiguous (timeout, dropped connection): the code may
    // exist. Ask Shopify before deciding.
    return resolveRedemption(redemption.id);
  }
}

/**
 * Settles a redemption still in 'creating': looks the code up in Shopify, then
 * completes it if the code exists or compensates if it does not. Safe to call
 * repeatedly and concurrently; only one caller can change the state.
 * If Shopify cannot be reached the redemption stays 'creating'.
 */
export async function resolveRedemption(redemptionId) {
  const redemption = await prisma.redemption.findUnique({ where: { id: redemptionId } });
  if (!redemption) throw new Error(`Redemption ${redemptionId} not found`);
  if (redemption.status !== 'creating') return replayResult(redemption);

  let found;
  try {
    found = await gatewayFactory(redemption.shop).findDiscountByCode(redemption.discountCode);
  } catch (err) {
    console.error(`[redemption] could not resolve ${redemptionId}, leaving it creating:`, err.message);
    return replayResult(redemption);
  }
  return found ? completeRedemption(redemptionId, found.id, true) : compensateRedemption(redemptionId);
}

async function completeRedemption(redemptionId, discountCodeId, replayed) {
  await prisma.$transaction(async (tx) => {
    const moved = await tx.redemption.updateMany({
      where: { id: redemptionId, status: 'creating' },
      data: { status: 'active', discountCodeId },
    });
    if (moved.count === 0) return; // someone else settled it
    const r = await tx.redemption.findUnique({ where: { id: redemptionId } });
    await tx.reward.create({
      data: {
        accountId: r.accountId,
        shop: r.shop,
        discountCode: r.discountCode,
        discountCodeId,
        valueInPaise: r.rewardValuePaise,
        pointsUsed: r.pointsUsed,
        status: 'active',
        expiresAt: r.expiresAt,
      },
    });
  }, TX_OPTIONS);
  return replayResult(await prisma.redemption.findUnique({ where: { id: redemptionId } }), replayed);
}

/**
 * Writes the compensating 'reward_return' entry. The points come back as a
 * fresh active lot rather than into the lots they were taken from, because
 * those may have been refunded or exhausted since.
 */
async function compensateRedemption(redemptionId) {
  const redemption = await prisma.redemption.findUnique({ where: { id: redemptionId } });
  await prisma.$transaction(async (tx) => {
    await lockAccount(tx, redemption.accountId, 'compensate');
    const moved = await tx.redemption.updateMany({
      where: { id: redemptionId, status: 'creating' },
      data: { status: 'failed' },
    });
    if (moved.count === 0) return; // someone else settled it

    // D4: returned points repay any owed balance first (a refund can have landed while this
    // redemption was still 'creating', when its points counted as spent).
    const account = await tx.loyaltyAccount.findUnique({ where: { id: redemption.accountId }, select: { debt: true } });
    const repaid = Math.min(account.debt, redemption.pointsUsed);
    const usable = redemption.pointsUsed - repaid;

    const lot = await tx.pointLot.create({
      data: {
        accountId: redemption.accountId,
        originalPoints: redemption.pointsUsed,
        remaining: usable,
        status: usable > 0 ? 'active' : 'exhausted',
        shopifyOrderId: `reward:${redemptionId}`,
        activatesAt: now(),
      },
    });
    await tx.ledgerEntry.create({
      data: {
        accountId: redemption.accountId,
        type: 'reward_return',
        points: redemption.pointsUsed,
        status: 'active',
        dedupeKey: `reward_return:${redemptionId}`,
        note: 'Reward code could not be created — points returned' + (repaid > 0 ? ` (${repaid} used to repay the owed balance)` : ''),
        lotId: lot.id,
        redemptionId,
      },
    });
    await tx.loyaltyAccount.update({
      where: { id: redemption.accountId },
      data: {
        ...(usable > 0 ? { available: { increment: usable } } : {}),
        ...(repaid > 0 ? { debt: { decrement: repaid } } : {}),
      },
    });
  }, TX_OPTIONS);
  return replayResult(await prisma.redemption.findUnique({ where: { id: redemptionId } }));
}

function findRedemption(accountId, idempotencyKey) {
  return prisma.redemption.findUnique({
    where: { accountId_idempotencyKey: { accountId, idempotencyKey } },
  });
}

async function replayResult(redemption, replayed = true) {
  if (redemption.status === 'failed') {
    return refusal('DISCOUNT_FAILED', 'We could not create your reward code. No points were used.');
  }
  if (redemption.status === 'voided') {
    return refusal('REWARD_VOIDED', 'This reward was cancelled because the order it was earned on was returned or cancelled. Its points were taken back.');
  }
  const account = await prisma.loyaltyAccount.findUnique({ where: { id: redemption.accountId } });
  return {
    ok: true,
    status: redemption.status === 'creating' ? 'creating' : 'active',
    replayed,
    redemptionId: redemption.id,
    // A code is only shown once it exists in Shopify.
    code: redemption.status === 'creating' ? null : redemption.discountCode,
    pointsUsed: redemption.pointsUsed,
    valuePaise: redemption.rewardValuePaise,
    expiresAt: redemption.expiresAt,
    available: account.available,
  };
}
