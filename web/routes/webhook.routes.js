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
import { markUninstalled, markInstalled, isMarkedUninstalled, updateScopes } from '../loyalty/service/shop-state.js';
import { gatewayFactory } from '../loyalty/service/ledger.js';

/**
 * Self-heal. A signed orders/paid, orders/cancelled or refunds/create can only come from Shopify, and Shopify only sends them to an
 * installed app. If the shop is marked uninstalled (a missed or mistaken uninstall, or a reinstall whose afterAuth never ran) and the
 * stored token works, the shop is installed: mark it active again so its jobs resume. Any trouble here (no token, a failed check)
 * leaves things as they are and never fails the webhook: the event is stored either way.
 */
export async function reactivateIfInstalled(shop) {
  try {
    if (!(await isMarkedUninstalled(shop))) return false;
    if (!(await gatewayFactory(shop).isTokenValid())) return false;
    await markInstalled(shop);
    console.log(`[uninstall] ${shop} was marked uninstalled but its token works and Shopify is sending events: marked active again`);
    return true;
  } catch (error) {
    console.warn(`[uninstall] could not check whether ${shop} is installed again (${error.message}); left as it is`);
    return false;
  }
}

/**
 * Handler for ORDERS_PAID, REFUNDS_CREATE and ORDERS_CANCELLED: store the event for the worker (the ledger is written there, in one
 * transaction, never in the request). A failure to store is rethrown so Shopify redelivers.
 */
async function storeOrderEvent(topic, shop, body, webhookId) {
  console.log(`\n--- [WEBHOOK] ${topic} for ${shop} (ID: ${webhookId}) ---`);
  try {
    const payload = JSON.parse(body);
    await storeWebhook({ shop, topic, payload, shopifyWebhookId: webhookId });
    console.log(`Stored ${topic} webhook for deferred processing.`);
  } catch (error) {
    console.error(`Failed to store ${topic} webhook:`, error.message);
    throw error; // Shopify retries
  }
  await reactivateIfInstalled(shop);
}

/**
 * Webhook handler for APP_UNINSTALLED. Marks the shop uninstalled (the background jobs then leave it alone) and drops its sessions,
 * which are the access tokens. Nothing else is touched: the shop's data stays until Shopify sends shop/redact. A reinstall
 * marks it active again (loyalty/service/install.js, from the afterAuth hook).
 *
 * The event is only believed after a check with Shopify: the stored token must be gone (no session) or refused (401 or 403).
 *  - Token still works: the shop reinstalled and this event is old; ignored.
 *  - The check itself fails (network error, 5xx, 429, a database error): THROWN, so Shopify answers 500 and redelivers the
 *    webhook. A shop is never marked uninstalled, and its sessions never dropped, on a check that did not give an answer.
 * shopify-app-express adds its own handler for this topic that deletes the shop's sessions whatever happened here (and the library
 * runs every handler even when one throws); mountWebhooks() below removes it, because this one does that job, after the check.
 */
export async function handleAppUninstalled(topic, shop, body, webhookId) {
  console.log(`\n--- [WEBHOOK] ${topic} for ${shop} ---`);
  let stillInstalled;
  try {
    stillInstalled = await gatewayFactory(shop).isTokenValid();
  } catch (error) {
    console.error(`[uninstall] could not check the token of ${shop} (${error.message}); the shop is NOT marked uninstalled, the webhook is refused so Shopify sends it again`);
    throw error;
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
    callback: storeOrderEvent,
  },
  REFUNDS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: '/api/webhooks',
    callback: storeOrderEvent,
  },
  ORDERS_CANCELLED: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: '/api/webhooks',
    callback: storeOrderEvent,
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

/**
 * The webhook route's middleware, as web/index.js mounts it: signature header required, then shopify.processWebhooks with the
 * handlers above. processWebhooks registers the handlers on the shared shopify instance, so call this ONCE per process.
 * It also removes shopify-app-express's own APP_UNINSTALLED handler (see handleAppUninstalled).
 */
export function mountWebhooks(shopify) {
  const processing = shopify.processWebhooks({ webhookHandlers });
  const handlers = shopify.api.webhooks.getHandlers('APP_UNINSTALLED'); // the live list the library calls, in order
  const ours = handlers.filter((h) => h.callback === handleAppUninstalled);
  if (ours.length !== 1) throw new Error('webhook setup: expected exactly one of our APP_UNINSTALLED handlers');
  handlers.splice(0, handlers.length, ...ours);
  return [requireWebhookSignature, ...[processing].flat()];
}
