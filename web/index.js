// @ts-check
import { join } from 'path';
import { readFileSync } from 'fs';
import express from 'express';
import serveStatic from 'serve-static';

import shopify from './shopify.js';
import { webhookHandlers } from './routes/webhook.routes.js';
import proxyRouter from './routes/proxy.routes.js';
import settingsRouter from './routes/settings.routes.js';

const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT || '3000', 10);

const STATIC_PATH =
  process.env.NODE_ENV === 'production'
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

const app = express();

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
  shopify.processWebhooks({ webhookHandlers })
);

// ---------------------------------------------------------------------------
// 3. APP PROXY — Public storefront routes (redeem, history)
//    These run before the session validator so the storefront can call them.
// ---------------------------------------------------------------------------
app.use('/api/proxy', proxyRouter);

// ---------------------------------------------------------------------------
// 4. AUTHENTICATED ADMIN ROUTES — All routes below require a valid Shopify
//    admin session. shopify.validateAuthenticatedSession() enforces this.
// ---------------------------------------------------------------------------
app.use('/api/*', shopify.validateAuthenticatedSession());
app.use(express.json()); // JSON body parser for admin API routes

// Mount all authenticated admin API routes under /api
app.use('/api', settingsRouter);

// ---------------------------------------------------------------------------
// 5. FRONTEND — Serve the Polaris React admin app
// ---------------------------------------------------------------------------
app.use(shopify.cspHeaders());
app.use(serveStatic(STATIC_PATH, { index: false }));

app.use('/*', shopify.ensureInstalledOnShop(), async (_req, res, _next) => {
  return res
    .status(200)
    .set('Content-Type', 'text/html')
    .send(
      readFileSync(join(STATIC_PATH, 'index.html'))
        .toString()
        .replace('%VITE_SHOPIFY_API_KEY%', process.env.SHOPIFY_API_KEY || '')
    );
});

app.listen(PORT, () => {
  console.log(`Reward Points backend listening on port ${PORT}`);
});