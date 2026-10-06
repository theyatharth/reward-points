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
 * Webhook handler for APP_UNINSTALLED.
 * Cleans up the merchant's sessions from the session storage.
 */
async function handleAppUninstalled(topic, shop, body, webhookId) {
  console.log(`\n--- [WEBHOOK] ${topic} for ${shop} ---`);
  try {
    const shopify = (await import('../shopify.js')).default;
    await shopify.config.sessionStorage.deleteSessions(shop);
    console.log(`Sessions cleared for uninstalled shop: ${shop}`);
  } catch (error) {
    console.error('Failed to clean up sessions on uninstall:', error.message);
  }
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
};
