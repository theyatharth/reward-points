// @ts-check
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

// Load .env from the project root (one level up from web/).
// Must run before any process.env access.
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
try {
  const dotenv = require("dotenv");
  dotenv.config({ path: join(__dirname, "..", ".env") });
} catch {
  // dotenv not available — rely on real env vars set by the environment
}

import { ApiVersion, LogSeverity } from "@shopify/shopify-api";
import { shopifyApp } from "@shopify/shopify-app-express";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { restResources } from "@shopify/shopify-api/rest/admin/2026-07";
import { prisma } from "./lib/prisma.js";
import { runInstallSetup } from "./loyalty/service/install.js";
import { gatewayFactory } from "./loyalty/service/ledger.js";

// ---------------------------------------------------------------------------
// Session Storage — Postgres, via the same Prisma client as the rest of the
// app's data.
//
// This USED to be SQLite on the container's local disk. That file lives on
// ephemeral storage: it's wiped on every redeploy/restart and isn't shared
// across instances when scaled out. getClientForShop() would then silently
// start returning null, and every metafield sync (earn, redeem, refund)
// would go dead with no error — points kept accruing correctly in Postgres
// while the storefront widget froze at its last synced balance. Moving
// sessions into the same Postgres database this app already depends on for
// everything else removes that failure mode entirely.
// ---------------------------------------------------------------------------
const sessionStorage = new PrismaSessionStorage(prisma);

const shopify = shopifyApp({
  api: {
    // API versions are deliberately not aligned yet:
    //   - the webhook PAYLOAD shape follows shopify.app.toml [webhooks] api_version (2026-10);
    //   - this Admin API client uses 2026-07 (ApiVersion.July26);
    //   - the REST getOrder call in web/loyalty/adapters/gateway.js has NOT been verified
    //     against 2026-10.
    apiVersion: ApiVersion.July26,
    restResources,
    future: {
      customerAddressDefaultFix: true,
      lineItemBilling: true,
      unstable_managedPricingSupport: true,
    },
    billing: undefined,
    logger: {
      level: LogSeverity.Info,
    },
  },
  auth: {
    path: "/api/auth",
    callbackPath: "/api/auth/callback",
  },
  webhooks: {
    path: "/api/webhooks",
  },
  future: {
    tokenExchange: true,
    // Shopify now refuses non-expiring offline tokens with 403 "Non-expiring access
    // tokens are no longer accepted". This flag makes the library request a short-lived
    // access token (with a refresh token) instead of the old permanent one. It lives here,
    // at the shopifyApp() level (config.future), NOT inside api.future — the library reads
    // it from config in perform-token-exchange.js, validate-authenticated-session.js, and
    // auth-callback.js. Placing it in api.future is what produced the log line
    // "Future flag expiringOfflineAccessTokens is disabled".
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    // Runs after token exchange (a shop's first visit) and after the OAuth callback. Creates the shop's rewards configuration; it
    // is idempotent and never throws, so it can never fail the request (see loyalty/service/install.js).
    afterAuth: (arg) => runInstallSetup(arg, (shop) => gatewayFactory(shop)),
  },
  // No afterAuth registerWebhooks(): webhook subscriptions are declared in
  // shopify.app.toml (app-specific). Registering the same topics through the API
  // as well creates a second, shop-specific subscription to the same URL and every
  // event arrives twice (T2.5).
  sessionStorage,
});

export default shopify;
