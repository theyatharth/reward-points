// web/lib/intake-scrub.js
//
// Removes personal data from a Shopify webhook payload BEFORE it is stored (web/loyalty/service/webhook.js storeWebhook, the one
// place every orders/paid, refunds/create and orders/cancelled event passes through). Pure: no database, no network.
//
// KEPT: everything the points calculation, the refund line-matching and support need: ids, line items (title, quantity, price,
// sku, gift_card flag, tax and discount allocations), discount applications and codes, tax lines, totals, currency, timestamps,
// refunds and refund line items, transactions' amounts, and the customer's Shopify id (customer.id and its gid).
// REMOVED (the key is dropped, not blanked): names, e-mail addresses, phone numbers, every address, the customer's other
// fields (tags, notes, marketing state, order counts), order and refund notes, note attributes, line-item properties (text the
// customer typed), browser and device data, tokens and customer-facing URLs, payment details and gateway free text, and the staff
// member behind a refund.
// As a last net every remaining string is swept for e-mail addresses, IP addresses, phone-number-looking values and secret
// query parameters, whatever key it is under.
//
// web/lib/redact-payload.js does the same job for exporting fixtures (it keeps every key and replaces the values); this one drops.

import { sweepString } from './redact-payload.js';

/** Dropped wherever the key appears. */
const DROP_KEYS = new Set([
  'email', 'contact_email', 'phone', 'first_name', 'last_name',
  'billing_address', 'shipping_address', 'default_address', 'addresses', 'address', 'address1', 'address2', 'city', 'zip', 'province', 'company', 'latitude', 'longitude',
  'client_details', 'browser_ip', 'user_agent', 'accept_language', 'customer_locale',
  'note', 'note_attributes', 'properties',
  'token', 'cart_token', 'checkout_token', 'landing_site', 'landing_site_ref', 'referring_site', 'order_status_url', 'source_url', 'confirmation_number',
  'payment_details', 'receipt', 'authorization', 'message',
  'user_id',
  'tracking_company', 'tracking_number', 'tracking_numbers', 'tracking_url', 'tracking_urls',
]);

/** What of the customer object is kept. */
const CUSTOMER_KEEP = new Set(['id', 'admin_graphql_api_id']);

const MAX_DEPTH = 40;

function scrub(value, key, depth) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map((v) => scrub(v, key, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP_KEYS.has(k)) continue;
      if (k === 'customer' && v && typeof v === 'object' && !Array.isArray(v)) {
        out.customer = Object.fromEntries(Object.entries(v).filter(([ck]) => CUSTOMER_KEEP.has(ck)));
        continue;
      }
      out[k] = scrub(v, k, depth + 1);
    }
    return out;
  }
  return typeof value === 'string' ? sweepString(value) : value;
}

/**
 * @param {unknown} payload  a parsed webhook body
 * @returns {unknown} a scrubbed deep copy; the input is not modified. Anything that is not an object or array comes back as it is.
 */
export function scrubPayload(payload) {
  return scrub(payload, '', 0);
}
