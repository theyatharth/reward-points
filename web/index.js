// @ts-check
import { join } from 'path';
import { readFileSync } from 'fs';
import express from 'express';
import serveStatic from 'serve-static';

import shopify from './shopify.js';
import { webhookHandlers, requireWebhookSignature } from './routes/webhook.routes.js';
import proxyRouter from './routes/proxy.routes.js';
import settingsRouter from './routes/settings.routes.js';
import { mountAdminConsole, adminAuthMode } from './admin/router.js';

// ADMIN_AUTH=password (default, the dev app) or shopify (the public app: the console is embedded in the Shopify admin).
const ADMIN_AUTH = adminAuthMode();

const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT || '3000', 10);

// ---------------------------------------------------------------------------
// APP_BASE_PATH — everything that depends on where the app is mounted is
// derived from this one variable.  Set it in .env:
//   /reward-points      (production)
//   /reward-points-dev  (development)
// ---------------------------------------------------------------------------
const BASE_PATH = (process.env.APP_BASE_PATH || '/reward-points').replace(/\/$/, '');

const STATIC_PATH =
  process.env.NODE_ENV === 'production'
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

const app = express();

// nginx is the only thing in front of this process: trust one proxy hop so req.ip is the real client
// (the admin login rate limit counts failures per IP).
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// 1. AUTH — Shopify OAuth flow
// ---------------------------------------------------------------------------
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);

// ---------------------------------------------------------------------------
// 2. WEBHOOKS — Must be registered BEFORE express.json() parses the body,
//    because Shopify HMAC validation requires the raw body.
// ---------------------------------------------------------------------------
app.post(
  shopify.config.webhooks.path,
  requireWebhookSignature,
  shopify.processWebhooks({ webhookHandlers })
);

// ---------------------------------------------------------------------------
// 3. APP PROXY — Public storefront routes (redeem, history)
//    These run before the session validator so the storefront can call them.
// ---------------------------------------------------------------------------
app.use('/api/proxy', proxyRouter);

// ---------------------------------------------------------------------------
// 3b. ADMIN CONSOLE — /admin (static pages + JSON API under /admin/api). Outside the Shopify iframe, with its
//     own login (web/admin/auth.js), so it also runs before the Shopify session validator below.
//     "/admin" redirects to "<base>/admin/"; "/admin/" serves the console; unknown paths under it are a 404.
//     Mounted at /admin (nginx strips the base path) and at <base>/admin (in case it ever does not).
// ---------------------------------------------------------------------------
mountAdminConsole(app, { basePath: BASE_PATH, authMode: ADMIN_AUTH, shopify });

// ---------------------------------------------------------------------------
// 4. AUTHENTICATED ADMIN ROUTES — All routes below require a valid Shopify
//    admin session. shopify.validateAuthenticatedSession() enforces this.
// ---------------------------------------------------------------------------
app.use('/api/*splat', shopify.validateAuthenticatedSession());
app.use(express.json()); // JSON body parser for admin API routes

// Mount all authenticated admin API routes under /api
app.use('/api', settingsRouter);

// ---------------------------------------------------------------------------
// 5. FRONTEND — Serve the Polaris React admin app
// ---------------------------------------------------------------------------
app.use(shopify.cspHeaders());
app.use(serveStatic(STATIC_PATH, { index: false }));

// The public app's application_url: Shopify opens "/?shop=…&host=…&embedded=1&id_token=…" in the admin iframe. Hand it to the
// console (the same query goes along, so App Bridge finds its host). ensureInstalledOnShop sends a top-level visit back into the admin.
if (ADMIN_AUTH === 'shopify') {
  app.use('/{*splat}', shopify.ensureInstalledOnShop(), (req, res) => {
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(302, `${BASE_PATH}/admin/${query}`);
  });
}

app.use('/{*splat}', shopify.ensureInstalledOnShop(), async (_req, res, _next) => {
  return res
    .status(200)
    .set('Content-Type', 'text/html')
    .send(
      readFileSync(join(STATIC_PATH, 'index.html'))
        .toString()
        .replace('%VITE_SHOPIFY_API_KEY%', process.env.SHOPIFY_API_KEY || '')
        .replace('%VITE_APP_BASE_PATH%', BASE_PATH)
    );
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Reward Points backend listening on port ${PORT} (base path: ${BASE_PATH})`);
});

export { BASE_PATH };
