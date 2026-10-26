// web/admin/shopify-auth.js
//
// Authentication for the console when it runs EMBEDDED in the Shopify admin (ADMIN_AUTH=shopify, the public app).
// There is no password and no cookie: every /admin/api call carries the App Bridge session token
// (Authorization: Bearer <JWT>), and the server derives everything from the verified token:
//
//   * the token is checked with @shopify/shopify-api (HS256 with the app secret, exp/nbf, aud = this app's API key),
//     then its iss and dest must name the same Shopify shop (*.myshopify.com);
//   * the shop's session is then loaded (or created by token exchange) by the existing shopify-app-express
//     validateAuthenticatedSession(), which is what makes a first visit after a managed install work;
//   * req.admin.shop is the shop in the token and nothing else: a ?shop= or a body field can never change it.
//     Every data query downstream is already scoped to req.admin.shop;
//   * req.admin.shopifyUserId is the token's `sub` (the staff member), recorded in the audit log instead of an e-mail.
//
// No cookie means nothing for a cross-site page to ride on, so there is no CSRF token in this mode.

export const RETRY_INVALID_SESSION_HEADER = 'X-Shopify-Retry-Invalid-Session-Request';

const bearerOf = (req) => req.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]?.trim() || null;

/** The shop a verified token is for: iss and dest on the same host, and that host a real myshopify.com shop. */
function shopOfClaims(shopify, claims) {
  try {
    const dest = new URL(String(claims.dest));
    const iss = new URL(String(claims.iss));
    if (dest.host !== iss.host) return null;
    return shopify.api.utils.sanitizeShop(dest.hostname, false) || null;
  } catch {
    return null;
  }
}

/**
 * @param {Object} shopify  the shopifyApp() instance (web/shopify.js)
 * @returns {import('express').RequestHandler}
 */
export function createShopifyAuth(shopify) {
  const validateSession = shopify.validateAuthenticatedSession();

  return function requireShopifySession(req, res, next) {
    const token = bearerOf(req);
    if (!token) return res.status(401).json({ ok: false, error: 'NOT_LOGGED_IN' });

    shopify.api.session.decodeSessionToken(token).then((claims) => {
      const shop = shopOfClaims(shopify, claims);
      const userId = typeof claims.sub === 'string' || typeof claims.sub === 'number' ? String(claims.sub) : '';
      if (!shop || !userId) return res.status(401).json({ ok: false, error: 'INVALID_SESSION_TOKEN' });

      return validateSession(req, res, () => {
        const session = res.locals.shopify?.session;
        if (!session || session.shop !== shop) return res.status(401).json({ ok: false, error: 'INVALID_SESSION_TOKEN' });
        req.admin = { id: null, shop, email: null, shopifyUserId: userId, mustChangePassword: false, csrf: null, sessionId: null };
        return next();
      });
    }, () => {
      // Forged, expired (App Bridge asks for a fresh token and retries when it sees this header) or for another app.
      res.set(RETRY_INVALID_SESSION_HEADER, '1');
      return res.status(401).json({ ok: false, error: 'INVALID_SESSION_TOKEN' });
    }).catch(next);
  };
}
