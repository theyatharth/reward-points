# The public app: "Reward Points"

A free public Shopify app (`shopify.app.production.toml`, client id in that file), built from this repository next to the dev app and
the old production app. It shares the code with them and nothing else: its own checkout, its own PM2 processes, its own port, its own
database. **It never touches the old production app or its database** (`reward_points`), which the database guard still refuses.

How it differs from the dev app (the differences are switched by environment variables, so one code base serves both):

| | dev app | public app |
|---|---|---|
| Config file | `shopify.app.toml` | `shopify.app.production.toml` (`--config production`) |
| Where | `/reward-points-dev`, port 3001 | `/reward-points-app`, port 3004 |
| Console sign-in | e-mail and password (`ADMIN_AUTH=password`) | embedded in the Shopify admin, App Bridge session token (`ADMIN_AUTH=shopify`), no passwords |
| Shop setup | `scripts/onboard-shop.mjs` | automatic on first visit (afterAuth hook: currency from the Admin API, hold 30 days) |
| Storefront path | `/apps/rewards-dev` | `/apps/reward-points` |
| Database | `reward_points_dev` | the one named in `LIVE_DATABASE_NAME` |

## Environment variables (names only; values live in `<checkout>/.env`, never in git, never in this file)

| Name | Needed by | What it is |
|---|---|---|
| `DATABASE_URL` | web, worker, `prisma migrate deploy` | Postgres URL of the public app's database. |
| `LIVE_DATABASE_NAME` | web, worker | The one database name the app may use when `APP_ENV=production` (see "Database guard"). |
| `APP_ENV` | web, worker | `production` on the server (set by `deploy/ecosystem.public.config.cjs`). |
| `NODE_ENV` | web, worker | `production`. |
| `SHOPIFY_API_KEY` | web | The public app's client id (same as `client_id` in the toml). |
| `SHOPIFY_API_SECRET` | web | The app's secret. Signs and verifies session tokens, webhooks and app-proxy requests. |
| `SCOPES` | web | `read_orders,write_discounts,read_customers,write_customers` (same as the toml). |
| `HOST` | web | `https://integrations.platinuminfo.tech/reward-points-app` (same as `application_url`). |
| `PORT` (or `BACKEND_PORT`) | web | `3004` (set by the ecosystem file). |
| `APP_BASE_PATH` | web | `/reward-points-app` (set by the ecosystem file). |
| `ADMIN_AUTH` | web | `shopify` (set by the ecosystem file). Unset or `password` is the dev app's mode. Any other value stops the app at start. |
| `WORKER_INTERVAL_MS` | worker | Optional, default 30000. |
| `NIGHTLY_HOUR_UTC` | worker | Optional, hour of the nightly reconciliation. |
| `PROTECTED_DATABASES` | scripts | Optional comma list of databases the operator scripts refuse to write to. |
| `TEST_DATABASE_URL` | tests only | Never set on the public server. The test runner refuses `APP_ENV=production`. |

Not used by the public app: `ADMIN_SHOP` (password console only).

## Database guard (`web/lib/db-guard.js`)

Everything that imports `web/lib/prisma.js` (web, worker, scripts) is checked at start.
- Always refused: the host `proluma-db-instance`, the databases `reward_points`, `PlantCare`, `adgenius`, `attendix`, `hawkerdb`, `postgres`, `template0`, `template1`, `rdsadmin`.
- `APP_ENV=production`: the database must be exactly `LIVE_DATABASE_NAME`, which must be set, be one plain name, and not be a refused name. Nothing else can be reached from a production process.
- Any other `APP_ENV`: a URL naming `LIVE_DATABASE_NAME` is refused, so a dev checkout or a test run cannot write to the live database.
- `prisma migrate deploy` does not go through the guard (it is the Prisma CLI): check the `DATABASE_URL` you give it.

## What the public app does on its own

- **Install** (`web/loyalty/service/install.js`): the first visit after install runs Shopify's token exchange, then the `afterAuth` hook marks the shop installed, reads its currency with the Admin API and creates its `LoyaltyConfig` from the seed profile (hold 30 days, `ledgerStartAt` = now). Idempotent, never fails the request. If the currency cannot be read there is no config (never a guessed one); it is retried when the console opens and when the worker meets an event for the shop. Such events wait (retried every 5 minutes for 7 days) instead of earning with default rules.
- **Holding period** is at most **55 days** (`MAX_HOLD_DAYS`, `web/loyalty/rules/config.js`, database CHECK in migration 13). Reason: Shopify lets an app holding `read_orders` read only the last 60 days of orders (Shopify's documentation; the installed `@shopify` packages say nothing about it), and when a hold ends the worker reads the order from Shopify (the J3 refund check) and will not unlock points without it. A hold of N days means the order is N days plus a little old at that moment, so 60 would already be outside the window.
- **Privacy webhooks** (`web/privacy.js`, `web/loyalty/service/privacy.js`): signed requests only (401 otherwise). `customers/data_request` is stored and shown under "Data requests" in the console; `customers/redact` replaces the account's customer id with a random token, clears ledger notes and audit notes and blanks stored webhook payloads for that customer; `shop/redact` erases every row of the shop. The ledger and audit triggers still refuse every change except inside the two SQL functions `redact_customer` and `redact_shop`, which run only in a transaction that first sets `rewardpoints.redact_allowed`. New audit rows carry our account id, not the Shopify customer id.
- **Intake scrub** (`web/lib/intake-scrub.js`): names, e-mails, phones, addresses, notes and device data are dropped from every webhook payload before it is stored. Customer id, lines, discounts, taxes and refunds are kept.
- **Uninstall**: `app/uninstalled` marks the shop uninstalled, drops its sessions (the tokens); the jobs skip it; data stays until `shop/redact`; the next visit after a reinstall reactivates it. `app/scopes_update` stores the new scopes.
- **`/healthz`**: 200 `{"ok":true}` when the database answers, 503 otherwise.

## Deploy, first time (dev server, `/home/ubuntu/reward-points-app`)

Nothing here touches `reward-points-dev`, its database or the old production app.

1. **Database.** Create an empty Postgres database for the public app (its name goes into `LIVE_DATABASE_NAME`; it must not be one of the refused names). Do not reuse `reward_points_dev`.
2. **Checkout.** Put the code in `/home/ubuntu/reward-points-app` the way the dev app is synced (`git archive <commit> | tar -x -C /home/ubuntu/reward-points-app`), then, with Node 22 first on `PATH`: `npm ci` in that directory.
3. **`.env`** in that directory with the variable names above (values from the Partner Dashboard and the database; do not copy the dev app's `.env`).
4. **Prisma and migrations:** `./node_modules/.bin/prisma generate`, then `DATABASE_URL=<the public database> ./node_modules/.bin/prisma migrate deploy` (all migrations, 1 to 14 and later).
5. **nginx:** add the two `location` blocks from `deploy/nginx-reward-points-app.conf.example` to the HTTPS server of `integrations.platinuminfo.tech`; `sudo nginx -t && sudo systemctl reload nginx`.
6. **PM2:** `pm2 start deploy/ecosystem.public.config.cjs` (`reward-points-app` on 3004 and `reward-points-app-worker`), `pm2 save`.
7. **Check:** `curl -s https://integrations.platinuminfo.tech/reward-points-app/healthz` gives `{"ok":true}`; `pm2 logs reward-points-app-worker` shows ticks.
8. **Shopify app config** (from the Mac, logged in to the Partner account, Shopify CLI): `shopify app deploy --config production`. This pushes the URLs, scopes, the eight webhook topics, the app proxy and the theme app extension to the public app. Read the CLI's output: it must list the extension `rewards-widget` for this app.
9. **Try it** on a development store: install from the app's test install link; the console opens inside the admin (`Apps > Reward Points`); the shop's currency and 30-day hold appear under "Earning & redemption"; place a test order and mark it paid; the event is processed within a minute (Orders & webhooks). Add the Rewards theme blocks in the theme editor and check `/apps/reward-points/history` answers on the storefront.
10. **Privacy test:** `shopify app webhook trigger --topic customers/redact --address https://integrations.platinuminfo.tech/reward-points-app/api/webhooks --client-secret <the app secret>` (and `customers/data_request`, `shop/redact` only against a throw-away store).

## Deploy, later

Sync the changed files, `prisma migrate deploy` on the public database, `pm2 restart reward-points-app reward-points-app-worker`, check `/healthz`. If the toml, the scopes, the webhooks, the proxy or the extension changed: `shopify app deploy --config production`.

## Known behaviours worth knowing

- The embedded page's Content-Security-Policy (`embeddedCsp` in `web/admin/router.js`) lets App Bridge load from `cdn.shopify.com` and talk to Shopify hosts. It has not been checked in a real Shopify admin; if the browser console reports a blocked request, widen it there.
- `shopify-app-express` adds its own `app/uninstalled` handler that always deletes the shop's sessions. A late, stale uninstall event therefore costs one token exchange on the next visit; it does not switch the shop off (our handler checks that the stored token no longer works first).
- Orders and refunds stored before the intake scrub existed keep their original payloads. The public database is new, so none exist there.
- `shop/redact` erases the shop even if the shop reinstalled in the 48 hours since it uninstalled and Shopify still sends it late. Shopify's behaviour for that case is not confirmed here.

## What is left (as of the last commit; see `docs/PROGRESS.md` for the log)

Done: setup (toml, hosting files, guard, `/healthz`), embedded admin, install, privacy webhooks, uninstall and scopes, intake scrub.

Not yet built from the sprint brief:
- **Currency guard:** only two-decimal currencies. `isTwoDecimalCurrency()` exists and the install step records it; the banner and "no points earned or redeemed" are not wired in yet.
- **Neutral text:** "Ecofynd" still appears in the console, the theme blocks, notifications and discount titles; the program name is not yet merchant-editable.
- **Setup page:** the "Get started" page with deep links is not built.

Not part of the brief, but needed before submitting to the App Store:
- A privacy policy and support URL for the listing, the listing text, icon and screenshots.
- A check of the storefront blocks and the console inside a real Shopify admin (nothing has been seen in a browser yet).
- `read_all_orders` is not requested, by design (see the hold cap above).
- Billing is not used (the app is free).
