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
- **Currency guard**: only currencies with two decimals work (every amount is whole hundredths). For any other (JPY, KWD, ...) the config is still created, but orders, refunds and cancellations are skipped with the reason in the event's `lastError`, redeeming and admin adjustments are refused with a clear message, the storefront says rewards are not available, and the console shows a red banner on every page.
- **Neutral text and the program name**: nothing visible says "Ecofynd". The program is called "Reward Points" until the merchant renames it on the Rules page (1 to 40 characters, audited); the name is used by the storefront blocks (page heading, widget, history labels), by the title of new discount codes and by the console heading. A test fails if the word appears in anything shipped to a browser.
- **Get started** (first page of the console for a new shop, until it is marked done or an order arrives): five steps with links that open the Shopify theme editor to turn on the widget (app embed) and add the Rewards block to a page. The link formats are in `web/admin/deep-links.js` only (from Shopify's "Theme app extensions > Configuration > Deep linking" page: `activateAppId=<api key>/<block handle>` and `addAppBlockId=<api key>/<block handle>&target=newAppsSection`). I have not been able to try them on a real store; Shopify's developer forum has reports of such links opening the editor without selecting the block, so the page says what to pick by hand.

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

## First install on a development store (checklist)

Before you start: the deploy above is done (`/healthz` answers, `shopify app deploy --config production` has pushed the config and the extension), and you have a development store (Partner Dashboard > Stores) with at least one test customer. Keep two terminals open on the server: `pm2 logs reward-points-app` and `pm2 logs reward-points-app-worker`. Open the browser's developer tools (Console and Network tabs) in the tab where you will use the app.

**1. Install**
- Partner Dashboard > Apps > Reward Points > Test your app > choose the development store > Install. Approve the four permissions (read orders, read and write customers, write discounts).
- Expect: the store admin opens the app (Apps > Reward Points) and the console loads inside the admin, on **Get started**.
- Server log (library lines, from reading `@shopify/shopify-app-express`; wording may differ slightly): `[shopify-app/INFO] No valid session found | {shop: ...}` then `[shopify-app/INFO] Requesting offline access token | {shop: ...}` (the token exchange, once), then from our hook: `[install] <shop>: configuration created (INR, hold 30 days)`. A second visit logs none of these (the session exists).
- Check the config row (through the guard wrapper; never print the connection string): `select shop, currency, "programName", "holdPeriodDays", "ledgerStartAt" from "LoyaltyConfig" where shop = '<shop>';` gives one row, `programName` = Reward Points, hold 30, `ledgerStartAt` = a minute ago. `select status, scopes from "ShopInstall" where shop = '<shop>';` gives `active` and the scopes.

**2. Console**
- Click through Overview, Customers, Orders & webhooks, Earning & redemption, Audit log. Rules shows the shop's currency and 30 days; rename the program (for example "Test Club"), save: the heading of the console changes at once.
- Audit log: `app_installed` and `rules_changed` rows, the second with "Shopify user <number>" as the admin.

**3. Theme**
- On Get started: "Open the theme editor" (App embeds panel): switch on Floating Rewards Widget, save. "Create the page": a page titled Rewards. "Add the block": the theme editor on the page template; if the block is not selected for you, Add section > Apps > Rewards Page Dashboard. Save.
- Storefront: log in as the test customer: the rewards button shows; `/pages/rewards` shows the page with the program name as its heading and "Start earning Test Club" (the live name comes from the app; the first paint uses the name in the theme metafield, which the worker pushes within a minute of a rename).

**4. An order**
- In the store admin create an order for the test customer (Orders > Create order, add a product, Mark as paid).
- Server log: `[shopify-api/INFO] Receiving webhook request`, `--- [WEBHOOK] orders/paid for <shop> (ID: ...) ---`, `Stored orders/paid webhook for deferred processing.`, `[shopify-app/INFO] Webhook processed, returned status code 200`. Worker log: `[worker] tick: picked=1 processed=1 failed=0` within about 30 seconds.
- Console: Orders & webhooks shows the event `processed`; Customers shows the customer with pending points (available after the 30-day hold; change the hold to 0 on the Rules page to see them unlock).

**5. Uninstall and reinstall**
- Apps > Reward Points > Delete. Server log: `[uninstall] <shop> marked uninstalled, sessions dropped (webhook ...)`. `ShopInstall.status` = `uninstalled`; the Session rows for the shop are gone; the config and the ledger are still there.
- Install again: the token exchange lines appear once more and `ShopInstall.status` goes back to `active` (no `configuration created` line: the config already exists).

**6. Privacy** (development store only): `shopify app webhook trigger --topic customers/data_request --address https://integrations.platinuminfo.tech/reward-points-app/api/webhooks --client-secret <the app secret>`; the request shows under Data requests. Do `customers/redact` for a throw-away customer and check the account's id became `redacted-...`. Never run `shop/redact` on a store you want to keep.

**What each failure looks like**

| What you see | What it means | What to do |
|---|---|---|
| The console shows "Open this app from Shopify" or "Your session ended" inside the admin; Network tab: `/admin/api/session` answers **401** with `{"error":"INVALID_SESSION_TOKEN"}` (and the header `X-Shopify-Retry-Invalid-Session-Request`) | The App Bridge session token was not accepted: signature (wrong `SHOPIFY_API_SECRET` for this app), audience (`SHOPIFY_API_KEY` is another app's), `iss` and `dest` not the same shop, or an expired token. | Compare `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` in the server's `.env` with the Partner Dashboard (do not print them); restart the app. A single 401 followed by success is normal: the console retries once with a fresh token. |
| The console shows "Open this app from Shopify" and the Network tab shows **no** `/admin/api/...` request at all | `window.shopify` is missing or `shopify.idToken()` failed, so the console never sent a request: App Bridge did not load (the page was opened outside the Shopify admin, or its script was blocked). A request with no `Authorization` header would get **401** `{"error":"NOT_LOGGED_IN"}`. | Open the app from Apps in the admin. If it still happens inside the admin, see the next row. |
| The page is blank or stays on "Loading", and the browser console says *Refused to load the script / Refused to connect ... because it violates the following Content Security Policy directive* | The embedded page's CSP (`embeddedCsp()` in `web/admin/router.js`) blocks something App Bridge needs. This policy has never been tried in a real admin. | Add the blocked host to the directive named in the message (usually `script-src` or `connect-src`), deploy, reload. Tell me what was blocked so it goes into the code and the tests. |
| *Refused to display ... in a frame because an ancestor violates ... frame-ancestors* | The console page was loaded without `?shop=` (so only `admin.shopify.com` may frame it) or with a shop that is not `*.myshopify.com`. | Open the app from the admin; check the nginx block passes the query string (it does in the example). |
| Console works, Get started step 1 says "being set up", Rules says there is no loyalty rule, and no `configuration created` line in the log | **No config row.** The hook could not read the shop currency. Look for `[install] <shop>: could not read the shop currency: ...` in the log. | If the reason contains `401` or `403`: the stored offline token is not accepted; uninstall and install again. If it is a network or 5xx error: open the console again (it retries on every open) or wait for the first order (the worker retries). Never create the row by hand with a guessed currency. |
| Orders & webhooks shows events `failed` with "The shop ... is not set up yet" | Same cause: events wait (retried every 5 minutes for 7 days) until the config exists, then they are processed. | Fix the cause above; nothing is lost. |
| Events `skipped` with "The shop currency (JPY) is not supported" and a red banner | The shop's currency has other than two decimals. | Nothing to fix: the program does not run for this shop by design. |
| `[uninstall] could not check the token of <shop> (...); the shop is NOT marked uninstalled, the webhook is refused so Shopify sends it again` | The token check failed for a reason other than 401/403 (network, Shopify 5xx or 429, a database error). The webhook got a 500 and Shopify redelivers it. | Nothing, unless it repeats for hours: then check the server's network and the database. |
| Webhooks answer **401** in the log (`Webhook processed, returned status code 401`) | The signature did not match: `SHOPIFY_API_SECRET` is wrong, or something between Shopify and the app changed the body (a proxy that rewrites it). | Check the secret; check the nginx block does not buffer or rewrite the body. |
| `[db-guard] APP_ENV=production may connect only to the database named in LIVE_DATABASE_NAME` at start | `DATABASE_URL` names another database than `LIVE_DATABASE_NAME`. | Fix the `.env`; do not point it at the dev or old production database. |
| `ADMIN_AUTH must be "password" or "shopify"` at start | A typo in `ADMIN_AUTH`. | Fix it (the ecosystem file sets `shopify`). |

## Known behaviours worth knowing

- The embedded page's Content-Security-Policy (`embeddedCsp` in `web/admin/router.js`) lets App Bridge load from `cdn.shopify.com` and talk to Shopify hosts. It has not been checked in a real Shopify admin; if the browser console reports a blocked request, widen it there.
- `app/uninstalled` is believed only after a check with Shopify: the stored token must be missing or refused (401 or 403). If the check itself fails (network error, 5xx, 429, a database error) the webhook is refused with a 500 so Shopify sends it again, and the shop is not marked and its sessions are not dropped. `shopify-app-express` adds its own handler for this topic that deletes the sessions whatever happened (and the library runs every handler even when one throws); `mountWebhooks()` in `web/routes/webhook.routes.js` removes it, so only ours runs. A late, stale uninstall event after a reinstall changes nothing.
- Self-heal: a signed `orders/paid`, `orders/cancelled` or `refunds/create` for a shop marked uninstalled whose token works marks the shop active again (no call to Shopify for a shop that is not marked).
- Orders and refunds stored before the intake scrub existed keep their original payloads. The public database is new, so none exist there.
- `shop/redact` erases the shop even if the shop reinstalled in the 48 hours since it uninstalled and Shopify still sends it late. Shopify's behaviour for that case is not confirmed here.

## What is left (as of the last commit; see `docs/PROGRESS.md` for the log)

Done: setup (toml, hosting files, guard, `/healthz`), embedded admin, install, privacy webhooks, uninstall (with the failed-check rule and self-heal), intake scrub, currency guard, neutral text and the editable program name, Get started.

Nothing from the sprint brief is left to build. What is left is to see it work: the checklist below, on a development store.

Not part of the brief, but needed before submitting to the App Store:
- A privacy policy and support URL for the listing, the listing text, icon and screenshots.
- A check of the storefront blocks and the console inside a real Shopify admin (nothing has been seen in a browser yet).
- `read_all_orders` is not requested, by design (see the hold cap above).
- Billing is not used (the app is free).
