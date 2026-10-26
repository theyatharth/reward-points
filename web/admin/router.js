// web/admin/router.js
//
// The admin console: static pages and a JSON API under /admin, mounted by web/index.js BEFORE the Shopify
// session validator (it has its own login, see auth.js) and outside the Shopify iframe.
//
//   GET  /admin/                  the console (static HTML; no server-side templating)
//   GET  /admin/static/*          CSS and JavaScript modules
//   POST /admin/api/login         email + password
//   GET  /admin/api/session       who am I, and the CSRF token
//   POST /admin/api/logout
//   POST /admin/api/change-password
//   ...  /admin/api/<view>        one JSON endpoint per view, behind the session, whitelisted fields only
//                                 (registered by routes.js)
//
// Public URLs go through nginx under the app's base path (APP_BASE_PATH, e.g. /reward-points-dev), which is
// stripped before Express sees them; only the cookie Path needs it. Every response is no-store and carries a
// strict Content-Security-Policy (scripts and styles from this origin only, no framing).

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  requireSession, requireCsrf, requirePasswordChanged, loginHandler, logoutHandler, sessionHandler, changePasswordHandler,
} from './auth.js';
import { registerDataRoutes } from './routes.js';
import { createShopifyAuth } from './shopify-auth.js';
import { runInstallSetup } from '../loyalty/service/install.js';
import { gatewayFactory } from '../loyalty/service/ledger.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * ADMIN_AUTH: "password" (the default: own login, used by the dev app) or "shopify" (embedded in the Shopify admin
 * with App Bridge session tokens, used by the public app). Anything else is a configuration error, never a silent default.
 */
export function adminAuthMode(value = process.env.ADMIN_AUTH) {
  const mode = String(value ?? '').trim().toLowerCase() || 'password';
  if (mode !== 'password' && mode !== 'shopify') throw new Error(`ADMIN_AUTH must be "password" or "shopify", not "${value}"`);
  return mode;
}

const SHOPIFY_CDN = 'https://cdn.shopify.com';

/**
 * The CSP of the embedded shell: the same policy, plus the App Bridge script from Shopify's CDN, Shopify's own hosts for
 * App Bridge's requests, and framing by this shop's admin only (frame-ancestors, as shopify-app-express's cspHeaders does).
 * NOT yet checked in a real Shopify admin: if App Bridge reports a blocked request, widen connect-src here.
 */
export function embeddedCsp(shop) {
  const ancestors = ['https://admin.shopify.com', ...(shop ? [`https://${shop}`] : [])].join(' ');
  return [
    "default-src 'none'",
    `script-src 'self' ${SHOPIFY_CDN}`,
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src 'self' ${SHOPIFY_CDN} https://*.shopify.com https://monorail-edge.shopifysvc.com`,
    "form-action 'self'",
    "base-uri 'none'",
    `frame-ancestors ${ancestors}`,
  ].join('; ');
}

function securityHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  next();
}

/** Writes need a JSON body (a form post cannot send application/json cross-site without a preflight). */
function jsonWritesOnly(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && !req.is('application/json')) {
    return res.status(415).json({ ok: false, error: 'JSON_REQUIRED' });
  }
  next();
}

/** The console page for the embedded build: index.html plus the App Bridge meta tag and script, and a marker the console reads. */
function embeddedPage(apiKey) {
  const html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const head = `<meta name="shopify-api-key" content="${String(apiKey).replace(/[^\w-]/g, '')}">\n<meta name="rw-auth" content="shopify">\n<script src="${SHOPIFY_CDN}/shopifycloud/app-bridge.js"></script>\n`;
  if (!html.includes('<head>\n')) throw new Error('web/admin/public/index.html has no <head> line to add App Bridge to');
  return html.replace('<head>\n', `<head>\n${head}`);
}

/**
 * @param {Object} [options]
 * @param {string} [options.basePath]  APP_BASE_PATH without a trailing slash, for the cookie Path
 * @param {'password'|'shopify'} [options.authMode]  default: ADMIN_AUTH (see adminAuthMode)
 * @param {Object} [options.shopify]   the shopifyApp() instance; required when authMode is "shopify"
 */
export function createAdminRouter({ basePath = '', authMode = adminAuthMode(), shopify } = {}) {
  const embedded = authMode === 'shopify';
  if (embedded && !shopify) throw new Error('ADMIN_AUTH=shopify needs the shopifyApp() instance');
  const router = express.Router();
  router.use(securityHeaders);

  // "/admin" and "/admin/" both reach this route (Express routing is not strict), so tell them apart by the URL the
  // request came in on. Without the slash, the console's relative asset URLs (static/app.js, api/...) would resolve
  // one level too high, so redirect to the slash form. The target is an ABSOLUTE path on the public base path, so
  // it is right whether nginx strips that prefix or not, and "/admin/" itself never redirects.
  const page = embedded ? embeddedPage(shopify.api.config.apiKey) : null;
  router.get('/', (req, res) => {
    const [urlPath, query] = req.originalUrl.split('?');
    if (!urlPath.endsWith('/')) return res.redirect(308, `${basePath}/admin/${query ? `?${query}` : ''}`);
    if (embedded) {
      // The page itself holds no data and needs no token (the API calls do); it may be framed by this shop's admin only.
      const shop = typeof req.query.shop === 'string' ? shopify.api.utils.sanitizeShop(req.query.shop) : null;
      res.set({ 'Content-Security-Policy': embeddedCsp(shop) });
      res.removeHeader('X-Frame-Options');
      return res.type('html').send(page);
    }
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'), { cacheControl: false });
  });
  router.use('/static', express.static(PUBLIC_DIR, { index: false, dotfiles: 'deny', cacheControl: false, etag: true }));

  const api = express.Router();
  api.use(express.json({ limit: '20kb' }));
  api.use(jsonWritesOnly);

  if (embedded) {
    // No login, logout or password in this mode (those paths are plain 404s below): the App Bridge session token is the
    // credential, checked on every call, and the shop comes from it.
    api.use(createShopifyAuth(shopify));
    // Opening the console is also the retry of the install setup (idempotent, never throws): a shop whose currency could not be read
    // when it installed gets its configuration here.
    api.get('/session', async (req, res) => {
      await runInstallSetup({ session: { shop: req.admin.shop } }, (shop) => gatewayFactory(shop));
      res.json({ ok: true, mode: 'shopify', admin: { shop: req.admin.shop, shopifyUserId: req.admin.shopifyUserId }, mustChangePassword: false, csrfToken: '' });
    });
  } else {
    api.post('/login', loginHandler({ basePath }));

    api.use(requireSession);
    api.get('/session', sessionHandler);
    api.post('/logout', requireCsrf, logoutHandler({ basePath }));
    api.post('/change-password', requireCsrf, changePasswordHandler());

    // Everything below needs the one-time password to have been changed, and a CSRF token on writes.
    api.use(requirePasswordChanged, requireCsrf);
  }
  registerDataRoutes(api);
  api.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND' }));
  api.use((err, _req, res, _next) => {
    console.error('[admin] error:', err.message);
    if (err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'INVALID_JSON' });
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  });

  router.use('/api', api);

  // Anything else under /admin is a plain 404 here, never the Shopify catch-all ("No shop provided").
  router.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    return res.status(404).type('text/plain').send('Not found');
  });
  return router;
}

/**
 * Mounts the console on `app` at /admin and at <basePath>/admin. nginx strips the base path, so /admin is what
 * normally arrives; the second mount keeps the console working if the prefix ever reaches Express.
 * Must be called BEFORE the Shopify session validator and catch-all.
 */
export function mountAdminConsole(app, { basePath = '', authMode, shopify } = {}) {
  const base = basePath.replace(/\/$/, '');
  const paths = base ? [`${base}/admin`, '/admin'] : ['/admin'];
  app.use(paths, createAdminRouter({ basePath: base, authMode, shopify }));
}
