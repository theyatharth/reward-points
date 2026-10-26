// @ts-check
import express from 'express';
import { DeliveryMethod } from '@shopify/shopify-api';
import { prisma } from '../lib/prisma.js';
import {
  calculateEarnedPoints,
  calculateDeductedPoints,
  wasRewardCodeUsed,
  HOLD_PERIOD_DAYS,
} from '../lib/points.js';
import {
  syncPointsBalance,
  syncPendingSummary,
  clearDiscountCode,
  recordTransaction,
  getClientForShop,
} from '../lib/shopify-sync.js';
import { promotePendingPoints } from '../lib/promotion.js';
import PrivacyWebhookHandlers from '../privacy.js';
import { storeWebhook } from '../loyalty/service/webhook.js';
import { markUninstalled, updateScopes } from '../loyalty/service/shop-state.js';
import { gatewayFactory } from '../loyalty/service/ledger.js';

/**
 * Webhook handler for ORDERS_PAID.
 * Awards points to the customer, but holds them as a PendingPoint for
 * HOLD_PERIOD_DAYS rather than crediting spendable CustomerPoint.points
 * directly — this is what makes handleRefundsCreate's clawback meaningful:
 * cancelling a still-pending order costs the customer nothing (nothing was
 * ever spendable), instead of the old buy → earn → redeem → refund exploit.
 * Protected against duplicate delivery via ProcessedOrder idempotency table.
 */
async function handleOrdersPaid(topic, shop, body, webhookId) {
  console.log(`\n--- [WEBHOOK] ${topic} for ${shop} (ID: ${webhookId}) ---`);
  try {
    const payload = JSON.parse(body);
    await storeWebhook({
      shop,
      topic,
      payload,
      shopifyWebhookId: webhookId,
    });
    console.log(`Stored ${topic} webhook for deferred processing.`);
  } catch (error) {
    console.error(`Failed to store ${topic} webhook:`, error.message);
    // Rethrow to let Shopify know it failed so it can retry
    throw error;
  }
}

/**
 * Webhook handler for REFUNDS_CREATE.
 * Claws back points proportional to the refund amount, pulling from
 * still-pending (unreleased) points first before ever touching spendable
 * balance or creating debt.
 */
async function handleRefundsCreate(topic, shop, body, webhookId) {
  console.log(`\n--- [WEBHOOK] ${topic} for ${shop} (ID: ${webhookId}) ---`);
  try {
    const payload = JSON.parse(body);
    await storeWebhook({
      shop,
      topic,
      payload,
      shopifyWebhookId: webhookId,
    });
    console.log(`Stored ${topic} webhook for deferred processing.`);
  } catch (error) {
    console.error(`Failed to store ${topic} webhook:`, error.message);
    throw error;
  }
}

/**
 * Webhook handler for ORDERS_CANCELLED.
 */
async function handleOrdersCancelled(topic, shop, body, webhookId) {
  console.log(`\n--- [WEBHOOK] ${topic} for ${shop} (ID: ${webhookId}) ---`);
  try {
    const payload = JSON.parse(body);
    await storeWebhook({
      shop,
      topic,
      payload,
      shopifyWebhookId: webhookId,
    });
    console.log(`Stored ${topic} webhook for deferred processing.`);
  } catch (error) {
    console.error(`Failed to store ${topic} webhook:`, error.message);
    throw error;
  }
}

/**
 * Webhook handler for APP_UNINSTALLED. Marks the shop uninstalled (the background jobs then leave it alone) and drops its sessions,
 * which are the access tokens. Nothing else is touched: the shop's data stays until Shopify sends shop/redact. A reinstall
 * marks it active again (loyalty/service/install.js, from the afterAuth hook).
 *
 * Webhooks can arrive late. If the stored token still works, the shop has already reinstalled and this event is old: it is ignored,
 * so a delayed uninstall can never switch off a live shop. (shopify-app-express adds its own handler for this topic that always
 * deletes the shop's sessions; after a stale event the next visit exchanges a new token and the afterAuth hook runs again.)
 */
export async function handleAppUninstalled(topic, shop, body, webhookId) {
  console.log(`\n--- [WEBHOOK] ${topic} for ${shop} ---`);
  let stillInstalled = false;
  try {
    stillInstalled = await gatewayFactory(shop).isTokenValid();
  } catch (error) {
    console.warn(`[uninstall] could not check the token of ${shop} (${error.message}); treating the shop as uninstalled`);
  }
  if (stillInstalled) {
    console.log(`[uninstall] ${shop} still has a working token: this is an old event, ignored`);
    return;
  }
  await markUninstalled(shop);
  // The Session table is the session storage (web/shopify.js): every offline and online token of the shop goes.
  await prisma.session.deleteMany({ where: { shop } });
  console.log(`[uninstall] ${shop} marked uninstalled, sessions dropped (webhook ${webhookId})`);
}

/**
 * Webhook handler for APP_SCOPES_UPDATE: the merchant granted or revoked access scopes. Payload: { id, previous: [..], current: [..],
 * updated_at }. The new list is stored on the shop and on its session (the library checks the session's scope).
 */
export async function handleAppScopesUpdate(topic, shop, body, webhookId) {
  const payload = JSON.parse(body);
  if (!Array.isArray(payload?.current)) {
    console.warn(`[scopes] ${shop}: no "current" list in the payload; nothing stored (webhook ${webhookId})`);
    return;
  }
  const stored = await updateScopes(shop, payload.current);
  console.log(`[scopes] ${shop}: scopes now ${stored || '(none)'} (webhook ${webhookId})`);
}

/**
 * A webhook with no signature header at all is refused with 401, the same as a wrong signature (the library answers 400 for a
 * missing header and 401 only for a mismatch). Mounted in front of shopify.processWebhooks.
 */
export function requireWebhookSignature(req, res, next) {
  if (!req.get('x-shopify-hmac-sha256')) return res.status(401).send('Unauthorized');
  return next();
}

/**
 * Combined webhook handlers object — merges Shopify privacy requirements
 * with our custom business logic handlers.
 */
export const webhookHandlers = {
  ...PrivacyWebhookHandlers,
  ORDERS_PAID: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: '/api/webhooks',
    callback: handleOrdersPaid,
  },
  REFUNDS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: '/api/webhooks',
    callback: handleRefundsCreate,
  },
  ORDERS_CANCELLED: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: '/api/webhooks',
    callback: handleOrdersCancelled,
  },
  APP_UNINSTALLED: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: '/api/webhooks',
    callback: handleAppUninstalled,
  },
  APP_SCOPES_UPDATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: '/api/webhooks',
    callback: handleAppScopesUpdate,
  },
};
