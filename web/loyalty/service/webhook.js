// web/loyalty/service/webhook.js
//
// Webhook intake and retry service.
// Implements the "store first, process later" pattern for Shopify webhooks.
// Every incoming webhook is stored in the WebhookEvent table before any
// processing is attempted. This allows us to immediately return 200 OK to
// Shopify, preventing timeouts, and gives us a durable queue for retries
// and auditing.

import { prisma } from '../../lib/prisma.js';
import { processEvent } from './ledger.js';
import { now } from '../adapters/clock.js';
import { normalizeTopic, isKnownTopic } from './topics.js';

/**
 * Stores an incoming webhook in the database.
 * If a webhook with the same shopifyWebhookId already exists, it is returned
 * (deduplication) and not inserted again.
 *
 * @param {Object} params
 * @param {string} params.shop             - Shopify domain (e.g. store.myshopify.com)
 * @param {string} params.topic            - Webhook topic (e.g. orders/paid)
 * @param {Object} params.payload          - Parsed JSON payload
 * @param {string} [params.shopifyWebhookId] - X-Shopify-Webhook-Id header
 * @returns {Promise<import('@prisma/client').WebhookEvent>}
 */
export async function storeWebhook({ shop, topic, payload, shopifyWebhookId }) {
  // Normalise once, at intake: events are stored in the slash form ("orders/paid").
  // An unrecognised topic is stored exactly as given and logged.
  if (!isKnownTopic(topic)) {
    console.warn(`[webhook] unmapped topic stored as given: ${JSON.stringify(topic)}`);
  }
  topic = normalizeTopic(topic);

  if (shopifyWebhookId) {
    const existing = await prisma.webhookEvent.findFirst({
      where: { shopifyWebhookId },
    });
    if (existing) {
      console.log(`[webhook] Webhook ${shopifyWebhookId} already exists. Skipping insert.`);
      return existing;
    }
  }

  const event = await prisma.webhookEvent.create({
    data: {
      shop,
      topic,
      payload,
      shopifyWebhookId,
      status: 'pending',
    },
  });

  return event;
}

/**
 * Marks a webhook as successfully processed.
 *
 * @param {string} eventId
 * @param {string} [ledgerEntryId] - ID of the LedgerEntry created/updated
 */
export async function markWebhookProcessed(eventId, ledgerEntryId) {
  return prisma.webhookEvent.update({
    where: { id: eventId },
    data: {
      status: 'processed',
      ledgerEntryId,
      updatedAt: now(),
    },
  });
}

/**
 * Retry schedule: the minutes to wait after the 1st, 2nd, ... failure of an event. An
 * event that fails once more after the last delay (its 6th failed attempt: the original
 * plus five retries) is 'dead'. An error flagged `permanent` is dead at once.
 */
export const RETRY_DELAYS_MINUTES = [1, 5, 30, 120, 360];

/**
 * What to record when an event has just failed for the `failureNumber`-th time (1-based).
 * @returns {{ status: 'failed' | 'dead', nextRetryAt: Date | null }}
 */
export function retryPlan(failureNumber, error) {
  const dead = error?.permanent === true || failureNumber > RETRY_DELAYS_MINUTES.length;
  return {
    status: dead ? 'dead' : 'failed',
    nextRetryAt: dead ? null : new Date(now().getTime() + RETRY_DELAYS_MINUTES[failureNumber - 1] * 60 * 1000),
  };
}

/**
 * An event that finds its shop not set up yet (no LoyaltyConfig, ShopNotSetUpError) is not counted against the retry schedule above:
 * it is retried every WAITING_RETRY_MINUTES until WAITING_WINDOW_DAYS after it arrived, then it is dead. The longer window is
 * for a shop whose currency could not be read at install: it is set up on its next console visit, and its first orders must
 * not be lost in the meantime.
 */
export const WAITING_RETRY_MINUTES = 5;
export const WAITING_WINDOW_DAYS = 7;

/** @returns {{ status: 'failed' | 'dead', nextRetryAt: Date | null }} */
export function waitingPlan(event) {
  const t = now();
  const expired = t.getTime() - event.createdAt.getTime() > WAITING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return expired
    ? { status: 'dead', nextRetryAt: null }
    : { status: 'failed', nextRetryAt: new Date(t.getTime() + WAITING_RETRY_MINUTES * 60 * 1000) };
}

/**
 * Marks a webhook as failed and schedules its retry per RETRY_DELAYS_MINUTES, or
 * marks it 'dead' (see retryPlan). The reason is kept in lastError either way.
 *
 * @param {string} eventId
 * @param {Error} error
 */
export async function markWebhookFailed(eventId, error) {
  const event = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
  if (!event) return;

  const attempts = event.attempts + 1;
  const { status, nextRetryAt } = error?.waitingForShop ? waitingPlan(event) : retryPlan(attempts, error);

  return prisma.webhookEvent.update({
    where: { id: eventId },
    data: {
      status,
      attempts,
      lastError: error?.message || String(error),
      nextRetryAt,
      updatedAt: now(),
    },
  });
}

/**
 * Marks a webhook as skipped (e.g. predates ledger, irrelevant).
 *
 * @param {string} eventId
 * @param {string} reason
 */
export async function markWebhookSkipped(eventId, reason) {
  return prisma.webhookEvent.update({
    where: { id: eventId },
    data: {
      status: 'skipped',
      lastError: reason, // Store reason in lastError for visibility
      updatedAt: now(),
    },
  });
}

/**
 * Polls the WebhookEvent table for pending or due-for-retry webhooks,
 * and processes them sequentially via the ledger service.
 * In a real production system with high throughput, this would be a
 * concurrent worker pool or triggered by SQS/EventBridge, but a simple
 * polling loop is sufficient for Phase 1 MVP.
 *
 * @param {Object} [options]
 * @param {string} [options.shop] - only process this shop's events. Omit for the
 *   worker, which processes every shop. Tests pass their own shop so events left
 *   behind by other tests are never picked up.
 */
export async function processPendingWebhooks(options = {}) {
  return (await processPendingWebhooksWithStats(options)).processed;
}

/**
 * Same as processPendingWebhooks, but reports what happened:
 *   picked    - events fetched this batch
 *   processed - events that ran without throwing
 *   failed    - events that threw (recorded as failed/dead on the event row)
 * The worker uses it so a tick with only failures is still visible.
 *
 * @param {Object} [options]
 * @param {string} [options.shop]
 * @returns {Promise<{ picked: number, processed: number, failed: number }>}
 */
export async function processPendingWebhooksWithStats({ shop } = {}) {
  const batchSize = 50;

  const events = await prisma.webhookEvent.findMany({
    where: {
      ...(shop ? { shop } : {}),
      OR: [
        { status: 'pending' },
        {
          status: 'failed',
          nextRetryAt: { lte: now() },
        },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
  });

  if (events.length === 0) return { picked: 0, processed: 0, failed: 0 };

  let processedCount = 0;
  let failedCount = 0;
  for (const event of events) {
    try {
      // Claim the event so two workers never process it together. If another worker got
      // there first nothing was claimed: leave the event to it (it is not a failure).
      const claimed = await prisma.webhookEvent.updateMany({
        where: { id: event.id, status: event.status },
        data: { status: 'processing', updatedAt: now() },
      });
      if (claimed.count === 0) continue;

      await processEvent(event);
      processedCount++;
    } catch (error) {
      console.error(`Error processing webhook event ${event.id}:`, error);
      failedCount++;
      await markWebhookFailed(event.id, error);
    }
  }

  return { picked: events.length, processed: processedCount, failed: failedCount };
}
