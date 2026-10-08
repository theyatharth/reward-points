// web/loyalty/service/topics.js
//
// Webhook topic names. Shopify's library hands handlers the ENUM form
// ("ORDERS_PAID") while payload headers and the toml use the slash form
// ("orders/paid"). Events are stored in the slash form; this explicit map is the
// only place the two are related. Pure: no database, no logging.

export const TOPIC_MAP = Object.freeze({
  ORDERS_PAID: 'orders/paid',
  REFUNDS_CREATE: 'refunds/create',
  ORDERS_CANCELLED: 'orders/cancelled',
  APP_UNINSTALLED: 'app/uninstalled',
  CUSTOMERS_DATA_REQUEST: 'customers/data_request',
  CUSTOMERS_REDACT: 'customers/redact',
  SHOP_REDACT: 'shop/redact',
});

const KNOWN_SLASH_TOPICS = new Set(Object.values(TOPIC_MAP));

/**
 * Enum form -> slash form. A slash form passes through. Anything else is
 * returned exactly as given (callers decide whether to log it).
 */
export function normalizeTopic(topic) {
  if (typeof topic === 'string' && Object.prototype.hasOwnProperty.call(TOPIC_MAP, topic)) {
    return TOPIC_MAP[topic];
  }
  return topic;
}

/** True for any topic this app knows, in either form. */
export function isKnownTopic(topic) {
  return typeof topic === 'string' &&
    (Object.prototype.hasOwnProperty.call(TOPIC_MAP, topic) || KNOWN_SLASH_TOPICS.has(topic));
}
