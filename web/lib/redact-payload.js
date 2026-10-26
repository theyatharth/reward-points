// web/lib/redact-payload.js
//
// Redacts a Shopify webhook payload so it can be kept as a test fixture.
// Pure: no database, no filesystem, no network. KEEPS EVERY KEY (the shape is the
// point of a fixture) and replaces personal or secret VALUES.
//
// Three layers, so something unexpected is still caught:
//   1. by key:      known personal keys (email, phone, names, addresses, notes,
//                   tokens, IPs, ...) have their value replaced;
//   2. by subtree:  objects that are customer-typed or device data
//                   (client_details, note_attributes, line-item properties, ...)
//                   have every value inside replaced (keys are kept);
//   3. by content:  EVERY remaining string is swept for email addresses, IP
//                   addresses, phone-number-looking strings and secret query
//                   parameters (?key=...), whatever key it sits under.
//
// findLeftovers() is a separate, deliberately noisy check that lists PATHS (never
// values) of anything in a redacted payload that still looks personal.

const MARK = '[redacted]';

// Value replaced wherever the key appears.
const REDACT_KEYS = new Set([
  'email', 'contact_email', 'phone', 'first_name', 'last_name',
  'address1', 'address2', 'city', 'zip', 'province', 'company',
  'latitude', 'longitude', 'browser_ip', 'user_agent', 'accept_language',
  'note', 'token', 'cart_token', 'checkout_token', 'landing_site', 'referring_site',
  'order_status_url', 'source_url',
  'confirmation_number', // customer-facing order reference
  'user_id',             // the staff member who acted (refunds, transactions)
  'authorization',       // payment gateway authorization reference (transactions)
  'message',             // gateway free text (transactions)
]);

// "name" is personal inside these objects, but "#1001" at order level (and a
// product's name on a line item) is not.
const NAME_PARENTS = new Set(['billing_address', 'shipping_address', 'default_address', 'address', 'customer']);

// Objects where every string except *_code fields is replaced (addresses).
const ADDRESS_OBJECTS = new Set(['billing_address', 'shipping_address', 'default_address', 'address']);

// Every value inside is replaced; the keys and array lengths inside are kept.
const REDACT_SUBTREES = new Set(['client_details', 'note_attributes', 'properties', 'payment_details', 'receipt']);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const SECRET_QUERY = /([?&](?:key|token|access_token|auth|signature|secret)=)[^&\s"'<>]+/gi;
const PHONE_WHOLE = /^\+\d[\d\s().-]{7,}$/;                 // +91 98765 43210, +1 (555) 625-1199
const IPV6_WHOLE = /^[0-9a-fA-F:]+$/;

export function sweepString(s) {
  if (PHONE_WHOLE.test(s.trim())) return '[phone]';
  if (IPV6_WHOLE.test(s) && (s.includes('::') || (s.match(/:/g) || []).length >= 4)) return '[ip]';
  return s.replace(EMAIL, '[email]').replace(IPV4, '[ip]').replace(SECRET_QUERY, '$1[redacted]');
}

// A value this module already replaced; left as it is so redacting twice changes nothing.
const isMarked = (v) => typeof v === 'string' && v.startsWith(MARK);

// Replaces every leaf value under a subtree but keeps all keys and array lengths.
function redactAllLeaves(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactAllLeaves);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactAllLeaves(v)]));
  return value === '' || isMarked(value) ? value : `${MARK} ${typeof value}`;
}

function redactNode(value, key, parent, inAddress) {
  if (REDACT_SUBTREES.has(key)) return redactAllLeaves(value);
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redactNode(v, key, key, inAddress || ADDRESS_OBJECTS.has(key)));
  if (typeof value === 'object') {
    const addr = inAddress || ADDRESS_OBJECTS.has(key);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactNode(v, k, key, addr)]));
  }
  // leaf
  const personalKey = REDACT_KEYS.has(key) || (key === 'name' && NAME_PARENTS.has(parent));
  const addressValue = inAddress && !/_code$/.test(key) && key !== 'id' && typeof value === 'string';
  if ((personalKey || addressValue) && value !== '' && !isMarked(value)) return `${MARK} ${typeof value}`;
  return typeof value === 'string' ? sweepString(value) : value;
}

/** Returns a redacted deep copy. The input is not modified. */
export function redactPayload(payload) {
  return redactNode(payload, '', '', false);
}

// ---------------------------------------------------------------------------
// Leftover check: paths only, never values.
// ---------------------------------------------------------------------------
const SUSPICIOUS_KEY = /(name|address|city|zip|postal|phone|mobile|email|note|comment|message|ip$|_ip|token|secret|password|key$|url|birth|dob|gender|company|street)/i;
const PRODUCT_NAME_PARENTS = new Set(['line_items', 'refund_line_items', 'shipping_lines', 'tax_lines', 'discount_applications']);
const SAFE_KEY = /(^|_)(title|vendor|sku|handle|type|status|currency|locale|gateway|names?_?set|product_name)$/i;

export function findLeftovers(redacted) {
  const hits = [];
  const walk = (v, path, key, parent) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`, key, parent));
    if (typeof v === 'object') return Object.entries(v).forEach(([k, x]) => walk(x, path ? `${path}.${k}` : k, k, key));
    if (typeof v !== 'string' || v.startsWith('[redacted') || v === '[email]' || v === '[phone]' || v === '[ip]' || v === '') return;
    if (/@/.test(v)) hits.push({ path, kind: 'contains @' });
    else if (/\b\d{1,3}(\.\d{1,3}){3}\b/.test(v)) hits.push({ path, kind: 'looks like an IP address' });
    else if ((v.match(/\d/g) || []).length >= 8 && /^[+\d\s().-]+$/.test(v) && !/^\d+$/.test(v) && !/^\d{4}-\d{2}-\d{2}/.test(v)) hits.push({ path, kind: 'looks like a phone number' });
    else if (/https?:\/\/[^\s]*\?/.test(v)) hits.push({ path, kind: 'URL with a query string' });
    else if (key === 'name' && (/^#\d+$/.test(v) || PRODUCT_NAME_PARENTS.has(parent))) return; // order name, product name
    else if (SUSPICIOUS_KEY.test(key) && !SAFE_KEY.test(key) && !/_code$|_id$|^id$|admin_graphql_api_id/.test(key)) hits.push({ path, kind: `value under a personal-looking key "${key}"` });
  };
  walk(redacted, '', '', '');
  return hits;
}
