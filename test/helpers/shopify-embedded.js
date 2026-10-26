// test/helpers/shopify-embedded.js
//
// The public app's embedded console under test: the real router in ADMIN_AUTH=shopify mode on an ephemeral port, the
// real shopify-app-express validation (web/shopify.js), and a minter for App Bridge session tokens (HS256 JWTs signed
// with the app secret, exactly what Shopify sends). A Session row stands in for the shop's stored offline token, so the
// "session exists" path runs and no call leaves the machine (a missing session would go to Shopify for a token exchange).

import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { prisma } from '../../web/lib/prisma.js';

export const TEST_API_KEY = 'test-api-key-0123456789abcdef';
export const TEST_API_SECRET = 'test-api-secret-0123456789abcdef0123456789abcdef';

let loaded;

/** web/shopify.js reads its settings from the environment when first imported; give it test ones, then put the environment back. */
export async function loadShopify() {
  if (loaded) return loaded;
  const keys = ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'HOST', 'SCOPES'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { SHOPIFY_API_KEY: TEST_API_KEY, SHOPIFY_API_SECRET: TEST_API_SECRET, HOST: 'https://app.test.example', SCOPES: 'read_orders,write_discounts,read_customers,write_customers' });
  try {
    loaded = (await import('../../web/shopify.js')).default;
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  return loaded;
}

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

/**
 * An App Bridge session token. Every claim can be overridden; `secret` signs it (default: the app's own secret).
 * @param {string} shop  e.g. "x.myshopify.com"
 */
export function sessionToken(shop, { sub = '4242', aud = TEST_API_KEY, iss, dest, exp, nbf, secret = TEST_API_SECRET, alg = 'HS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: iss ?? `https://${shop}/admin`, dest: dest ?? `https://${shop}`, aud, sub, exp: exp ?? now + 60, nbf: nbf ?? now - 5, iat: now, jti: crypto.randomUUID(), sid: crypto.randomUUID() };
  const head = b64({ alg, typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** The offline Session row web/shopify.js looks for, so the shop counts as installed. */
export async function installShop(shop, { scope = 'read_orders,write_discounts,read_customers,write_customers' } = {}) {
  await prisma.session.upsert({
    where: { id: `offline_${shop}` },
    create: { id: `offline_${shop}`, shop, state: 'test', isOnline: false, scope, accessToken: `test-token-${crypto.randomUUID()}` },
    update: { accessToken: `test-token-${crypto.randomUUID()}` },
  });
}

export async function startEmbeddedConsole({ basePath = '/reward-points' } = {}) {
  const shopify = await loadShopify();
  const { mountAdminConsole } = await import('../../web/admin/router.js');
  const app = express();
  app.set('trust proxy', true);
  mountAdminConsole(app, { basePath, authMode: 'shopify', shopify });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/admin`;
  const call = async (method, path, { token, body, headers = {} } = {}) => {
    const target = path.startsWith('?') ? `${url}/${path}` : `${url}/api/${path}`; // '?…' is the page itself
    const res = await fetch(target, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      redirect: 'manual',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { url, shopify, call, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * The webhook route as web/index.js mounts it: shopify.processWebhooks with the app's real handlers (privacy, orders, uninstall ...).
 * `send` signs the body with the app secret exactly as Shopify does (HMAC-SHA256, base64, X-Shopify-Hmac-Sha256).
 */
let webhookMiddleware;

export async function startWebhookServer() {
  const shopify = await loadShopify();
  const { mountWebhooks } = await import('../../web/routes/webhook.routes.js');
  // processWebhooks() REGISTERS the handlers on the shared shopify instance: calling it twice would run every handler twice.
  // web/index.js calls it once; so does this helper, however many servers a test file starts.
  webhookMiddleware ??= mountWebhooks(shopify);
  const app = express();
  app.post(shopify.config.webhooks.path, webhookMiddleware);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}${shopify.config.webhooks.path}`;
  const send = async (topic, shop, payload, { secret = TEST_API_SECRET, hmac, webhookId = crypto.randomUUID(), body } = {}) => {
    const raw = body ?? JSON.stringify(payload);
    const signature = hmac === undefined ? crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('base64') : hmac;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'X-Shopify-Topic': topic, 'X-Shopify-Shop-Domain': shop, 'X-Shopify-API-Version': '2026-10',
        'X-Shopify-Webhook-Id': webhookId, ...(signature === null ? {} : { 'X-Shopify-Hmac-Sha256': signature }),
      },
      body: raw,
    });
    return { status: res.status, text: await res.text() };
  };
  return { url, send, close: () => new Promise((resolve) => server.close(resolve)) };
}
