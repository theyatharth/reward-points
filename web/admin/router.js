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
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  requireSession, requireCsrf, requirePasswordChanged, loginHandler, logoutHandler, sessionHandler, changePasswordHandler,
} from './auth.js';
import { registerDataRoutes } from './routes.js';

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

/**
 * @param {Object} [options]
 * @param {string} [options.basePath]  APP_BASE_PATH without a trailing slash, for the cookie Path
 */
export function createAdminRouter({ basePath = '' } = {}) {
  const router = express.Router();
  router.use(securityHeaders);

  // "/admin" and "/admin/" both reach this route (Express routing is not strict), so tell them apart by the URL the
  // request came in on. Without the slash, the console's relative asset URLs (static/app.js, api/...) would resolve
  // one level too high, so redirect to the slash form. The target is an ABSOLUTE path on the public base path, so
  // it is right whether nginx strips that prefix or not, and "/admin/" itself never redirects.
  router.get('/', (req, res) => {
    const [urlPath, query] = req.originalUrl.split('?');
    if (!urlPath.endsWith('/')) return res.redirect(308, `${basePath}/admin/${query ? `?${query}` : ''}`);
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'), { cacheControl: false });
  });
  router.use('/static', express.static(PUBLIC_DIR, { index: false, dotfiles: 'deny', cacheControl: false, etag: true }));

  const api = express.Router();
  api.use(express.json({ limit: '20kb' }));
  api.use(jsonWritesOnly);
  api.post('/login', loginHandler({ basePath }));

  api.use(requireSession);
  api.get('/session', sessionHandler);
  api.post('/logout', requireCsrf, logoutHandler({ basePath }));
  api.post('/change-password', requireCsrf, changePasswordHandler());

  // Everything below needs the one-time password to have been changed, and a CSRF token on writes.
  api.use(requirePasswordChanged, requireCsrf);
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
export function mountAdminConsole(app, { basePath = '' } = {}) {
  const base = basePath.replace(/\/$/, '');
  const paths = base ? [`${base}/admin`, '/admin'] : ['/admin'];
  app.use(paths, createAdminRouter({ basePath: base }));
}
