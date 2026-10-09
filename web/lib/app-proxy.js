// web/lib/app-proxy.js
//
// Shopify App Proxy request checks, shared by the storefront routes.
//
// IMPORTANT: this is NOT the OAuth HMAC algorithm (shopify.api.utils.validateHmac). App Proxy signs
// sha256_hex(secret, sorted "key=value" pairs joined with NO separator). Everything Shopify forwards
// through /apps/<subpath>/* carries that `signature`; the body is NOT covered by it, so identity must come
// from the signed query string (`logged_in_customer_id`, `shop`), never from the body.

import crypto from 'node:crypto';

/** The signature Shopify would compute for these query params (everything except `signature`). */
export function appProxySignature(params, secret) {
  const message = Object.keys(params)
    .sort()
    .map((key) => `${key}=${Array.isArray(params[key]) ? params[key].join(',') : params[key]}`)
    .join('');
  return crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

/** Express middleware: 401 unless the query carries a valid App Proxy signature. */
export function verifyAppProxySignature(req, res, next) {
  const { signature, ...params } = req.query;
  const secret = process.env.SHOPIFY_API_SECRET;
  if (typeof signature !== 'string' || !secret) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const expected = Buffer.from(appProxySignature(params, secret), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Express middleware: the caller's identity from the SIGNED query only. Sets res.locals.shop and
 * res.locals.customerId (the numeric Shopify customer id as a string, the key of LoyaltyAccount).
 */
export function requireLoggedInCustomer(req, res, next) {
  const id = req.query.logged_in_customer_id;
  const shop = req.query.shop;
  if (typeof id !== 'string' || !/^\d+$/.test(id)) return res.status(401).json({ success: false, error: 'Please log in to your account.' });
  if (typeof shop !== 'string' || !SHOP_RE.test(shop)) return res.status(400).json({ success: false, error: 'Missing shop.' });
  res.locals.shop = shop;
  res.locals.customerId = id;
  next();
}
