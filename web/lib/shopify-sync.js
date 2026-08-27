// @ts-check
import { prisma } from './prisma.js';

/**
 * Syncs one or more metafield values to Shopify for a given customer.
 * @param {import('@shopify/shopify-api').GraphqlClient} client
 * @param {Array<{ ownerId: string, namespace: string, key: string, value: string, type: string }>} metafields
 */
export async function syncMetafields(client, metafields) {
  const response = await client.request(
    `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { key value }
        userErrors { field message }
      }
    }`,
    { variables: { metafields } }
  );

  const errors = response.data?.metafieldsSet?.userErrors;
  if (errors && errors.length > 0) {
    console.error('Shopify metafield sync errors:', errors);
  }
  return response;
}

/**
 * Syncs the customer's point balance metafield to Shopify.
 * @param {import('@shopify/shopify-api').GraphqlClient} client
 * @param {string} shopifyGid
 * @param {number} points
 */
export async function syncPointsBalance(client, shopifyGid, points) {
  return syncMetafields(client, [
    {
      ownerId: shopifyGid,
      namespace: 'custom',
      key: 'reward_points',
      value: points.toString(),
      type: 'number_integer',
    },
  ]);
}

/**
 * Clears the earned_discount_code metafield (sets to "NONE") after a customer uses their reward.
 * @param {import('@shopify/shopify-api').GraphqlClient} client
 * @param {string} shopifyGid
 * @param {number} points - current balance to also sync
 */
export async function clearDiscountCode(client, shopifyGid, points) {
  return syncMetafields(client, [
    {
      ownerId: shopifyGid,
      namespace: 'custom',
      key: 'reward_points',
      value: points.toString(),
      type: 'number_integer',
    },
    {
      ownerId: shopifyGid,
      namespace: 'custom',
      key: 'earned_discount_code',
      value: 'NONE',
      type: 'single_line_text_field',
    },
  ]);
}

/**
 * Syncs both the point balance and the newly generated discount code to Shopify.
 * @param {import('@shopify/shopify-api').GraphqlClient} client
 * @param {string} shopifyGid
 * @param {number} points
 * @param {string} discountCode
 */
export async function syncBalanceAndCode(client, shopifyGid, points, discountCode) {
  return syncMetafields(client, [
    {
      ownerId: shopifyGid,
      namespace: 'custom',
      key: 'reward_points',
      value: points.toString(),
      type: 'number_integer',
    },
    {
      ownerId: shopifyGid,
      namespace: 'custom',
      key: 'earned_discount_code',
      value: discountCode,
      type: 'single_line_text_field',
    },
  ]);
}

/**
 * Records a point transaction in the local Prisma database.
 * This replaces the old Shopify Metafield-based history.
 * @param {string} shopifyCustomerId
 * @param {string} shop
 * @param {string} action - Human-readable description (e.g. "Order #1234")
 * @param {number} points - Positive = earned, Negative = deducted
 * @param {string} [status]
 * @param {string} [orderId]
 */
export async function recordTransaction(
  shopifyCustomerId,
  shop,
  action,
  points,
  status = 'Approved',
  orderId = null
) {
  try {
    await prisma.pointTransaction.create({
      data: { shopifyCustomerId, shop, action, points, status, orderId },
    });
  } catch (err) {
    // Non-fatal: log and continue — never let history recording break core logic
    console.error('Non-fatal: Failed to record point transaction:', err.message);
  }
}

/**
 * Gets the Shopify GraphQL client for a given shop using the stored OFFLINE
 * session. Now that sessions live in Postgres (shared across instances,
 * multiple shops, possibly multiple staff logins), findSessionsByShop() can
 * return several rows — an arbitrary sessions[0] could be an ONLINE session
 * tied to one staff member's 24h browser login, which expires and carries
 * narrower permissions than the app's own offline token. Webhook/proxy code
 * runs with no logged-in staff member, so it must always use the offline one.
 * Returns null if no valid offline session is found.
 * @param {any} shopifyConfig
 * @param {string} shop
 * @returns {Promise<import('@shopify/shopify-api').GraphqlClient | null>}
 */
export async function getClientForShop(shopifyConfig, shop) {
  const sessions = await shopifyConfig.sessionStorage.findSessionsByShop(shop);
  const offlineSession = sessions?.find((/** @type {any} */ s) => !s.isOnline && s.accessToken);
  if (!offlineSession) return null;
  return new shopifyConfig.api.clients.Graphql({ session: offlineSession });
}
