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
import { restResources } from "@shopify/shopify-api/rest/admin/2024-10";
import { prisma } from "./lib/prisma.js";

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
    apiVersion: ApiVersion.October24,
    restResources,
    future: {
      customerAddressDefaultFix: true,
      lineItemBilling: true,
      unstable_managedPricingSupport: true,
    },
    billing: undefined,
    logger: {
      level: LogSeverity.Debug,
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
  },
  hooks: {
    afterAuth: async ({ session }) => {
      await shopify.registerWebhooks({ session });
    },
  },
  sessionStorage,
});

export default shopify;
