# Cutover pre-flight: everything still needed before production

**This is a checklist, not a runbook. The cutover has NOT been run and must not be run from this document alone.** Production
(`reward_points`, the live app `6e567e94...`, `shopify.app.prod.toml`) has not been touched by any of the work on branch `phase1`.
Each item says what is missing, why, and what "done" looks like. Items marked **BLOCKER** stop the cutover; the rest should be decided
or accepted in writing.

## A. Decisions the client still has to make

| # | Decision | Why it matters | Default if nobody decides |
|---|---|---|---|
| A1 | **Retry policy**: is the 5th failed delivery final (the client's engine: `attempts < 5`) or is there a 6th attempt (ours today: delays 1, 5, 30, 120, 360 min then dead)? | Changes when an event gives up and needs a person | keep ours; one constant and one test |
| A2 | **Reward catalogue**: one rule per shop (ours) or several rewards (₹10 ... ₹200) with minimum cart, limits, collections? | The prototype shows five tiers; this build has one points/value pair, no minimum cart | one rule |
| A3 | **Lot expiry** (points expiring 12 months after activation) | The client's engine and tests have it; it is off by decision | off |
| A4 | **Excluded collections at earn time** | Stored in the rule but NOT applied when points are earned (only gift cards are excluded) | not applied; show the rule as informational |
| A5 | **Rule editing in the admin** (validated, audited diff) | Today the rule is changed with `scripts/seed-config.mjs`; the Rules page is read only | script only |
| A6 | **Opening balances**: what happens to every existing customer's points on cutover (see B2) | Customers must not lose or gain points | **BLOCKER**: decide, then build |
| A7 | `returnPointsOnCodeExpiry`, `restoreRewardOnFullRefund`, hold days, code validity for production | Production config values | dev values: restore on, return-on-expiry off, 30 days, 90 days |

## B. Data and migration

- **B1. Migrations.** Ten additive migrations (4 to 10, after the three from earlier phases) are applied to the dev and test databases and to CI.
  Production needs `prisma migrate deploy` only (never reset/dev/push), taken against a backup, with the app and worker stopped for the minute it takes.
  Migration 8 sets `metafieldSeq = 1` on every existing account (a one-off re-sync). Migration 5 adds a `NOT VALID` check: it does not scan old rows.
- **B2. Opening balances. BLOCKER.** Production still holds the OLD system's data (`CustomerPoint`, `PendingPoint`, `PointTransaction`, `ProcessedOrder`,
  `ProcessedRefund`) and Shopify customer metafields (`custom.reward_points`, `earned_discount_code`, `pending_points`, `pending_points_available_at`,
  `reward_history`). There is **no script** that turns an old balance into ledger entries and lots. Needed: a reviewed script that, per customer, writes an
  opening `adjustment` (active lot for spendable points; pending lots with their original release dates for held points), is idempotent, is run on a COPY
  first, and ends with a reconciliation that is clean. `ledgerStartAt` must be set to the cutover moment so orders paid before it are ignored.
- **B3. Existing unused discount codes** created by the old `/redeem`: list them (Shopify admin or API), decide whether to honour them (leave as is) or void them,
  and make sure their points are not also in the opening balance.
- **B4. Old webhook handlers.** `web/routes/webhook.routes.js` still contains the legacy order/refund handlers' helpers and `web/routes/settings.routes.js` still
  reads the old tables; the live path now stores events and the worker processes them. Remove or retire the legacy code and tables only after the cutover
  is stable, never before.
- **B5. Backups and rollback.** A verified restore of the production database taken immediately before; a written rollback: stop the new worker, redeploy the previous
  app version, restore if the ledger has been written and must be abandoned. The ledger is append-only by design: "undo" is a reversing entry, not a delete.

## C. Shopify app configuration (production app, `shopify.app.prod.toml`)

- **C1. Webhook subscriptions.** The prod toml subscribes to `app/uninstalled`, `orders/paid`, `refunds/create` only. It is **missing `orders/cancelled`** and the
  compliance topics (`customers/data_request`, `customers/redact`, `shop/redact`); the dev toml has them. Add and `app deploy --config prod`.
- **C2. API versions are not aligned**: webhook payloads follow the toml (`2026-10`), the Admin API client uses `2026-07`, and the REST `getOrder` call has not been verified
  against `2026-10`. Verify, then align.
- **C3. Scopes.** Prod scopes match dev (`read_orders, read_discounts, write_discounts, read_customers, write_customers, write_products`). Check that the app has the
  **protected customer data** access the webhooks and metafield writes need, in the production app.
- **C4. App proxy.** Prod subpath is `rewards` (`/apps/rewards`); dev is `rewards-dev`. The theme blocks' "App proxy path" setting defaults to `/apps/rewards`.
  Set and verify on the live theme. The proxy URL points at `shopify.platinuminfo.tech/reward-points` (a different host from dev's `integrations.platinuminfo.tech`).
- **C5. Theme.** Deploy the extension with the prod config; add the app embed "Floating Rewards Widget" and the "Rewards Page Dashboard" block on `/pages/rewards`;
  check on the live theme that nothing in it clashes with the scoped styles (everything is under `.ecr`) and that the page works logged out and logged in.
  `app.metafields.rewards.redeem_rule` is no longer needed for the first paint (the widget reads `/history`).
- **C6. Privacy webhooks are stubs.** `web/privacy.js` handles `customers/data_request`, `customers/redact` and `shop/redact` with empty callbacks. The ledger stores only a
  Shopify customer id, order ids and points (no name, e-mail or phone, decision D5), and `WebhookEvent.payload` holds raw payloads for 90 days. Needed before a public
  app review: implement the three handlers (answer the data request from the ledger; for redact, anonymise rather than delete, because ledger rows are immutable
  by trigger: write down the legal reading), and confirm the 90-day payload purge is running.

## D. Server and operations

- **D1. Production process layout.** A separate worker process for production (`deploy/ecosystem.config.cjs` has `reward-points-dev-worker` only), started from
  the production checkout with its own `.env`; the database guard refuses the wrong database at start. Exactly one worker runs (an advisory lock makes a second harmless).
- **D2. Environment.** `.env` on the production box: `DATABASE_URL` (production), `SHOPIFY_API_KEY/SECRET` (production app), `APP_BASE_PATH=/reward-points`,
  `ADMIN_SHOP` (or exactly one shop with a loyalty config), `PROTECTED_DATABASES` set correctly. `NODE_ENV=production` (the fake gateway is only used under `NODE_ENV=test`).
- **D3. nginx.** `/reward-points/admin/` must reach the app with the base path stripped like the other routes; `X-Forwarded-For` and `Host` forwarded (the admin login rate
  limit counts per IP, and the Origin check compares with the Host header). The app trusts exactly one proxy hop.
- **D4. Admin accounts.** Create the production admins with `scripts/admin-user.mjs` (a one-time password each, forced change at first login); remove the dev admin pattern;
  decide who may adjust points.
- **D5. Seed the production rule** with `scripts/seed-config.mjs` after A7, with `ledgerStartAt` = the cutover moment. Confirm with `scripts/run-reconciliation.mjs`.
- **D6. Monitoring.** Nobody is alerted today when events die, the worker stops or reconciliation finds something. Minimum: a check on `WebhookEvent` with status `dead`
  or `failed` older than an hour, on the latest `JobRun` (`process_events`, `activate_lots`, `reconcile_nightly`, `sync_metafields`) not being recent, and the nightly reconcile result.
- **D7. Shopify API limits and sessions.** The worker uses the offline session; the first run of `sync_metafields` after cutover touches every customer (6 per call).
  Run `scripts/reset-metafields.mjs --dry-run` on production first to see the volume; the old metafields must be cleared and re-synced deliberately.
- **D8. Secrets.** Rotate anything that has appeared in a terminal or log during the prototype (the admin one-time passwords, any token pasted for testing). Nothing in the repo
  holds a secret; `captures/` is git-ignored and holds redacted exports.

## E. Verification still owed (not yet seen against real Shopify)

From `test/fixtures/shopify/README.md`, still UNVERIFIED: partial refunds of a taxed line on a **tax-inclusive** order; **non-USD** orders and refunds (production is INR: shop money
versus presentment money); the **returns flow** (`returns/*`, a refund generated from a return); guest orders; two tax lines on one line item (CGST and SGST).
Each needs a real capture on the dev store (or a staging production-like store in INR) with `scripts/export-webhook-payloads.mjs`, a fixture, and a test, **before** cutover.

Also not yet seen in a browser: the admin console and the restyled widget and Rewards page on the live theme; the theme-editor settings (proxy path, side, page path).

## F. Cutover order (outline only, to be turned into a runbook after A6 and B2 are done)

1. Freeze: announce a short window; stop the production worker; record counts (customers, total points, open codes).
2. Backup and verify the restore. 3. `migrate deploy` on production. 4. Deploy the new app version, webhooks (C1), proxy and theme (C4, C5).
5. Seed the rule (D5) with `ledgerStartAt` = now. 6. Run the opening-balance script (B2) and reconcile to clean. 7. Start the worker; watch the first ticks.
8. Clear and re-sync the metafields (D7). 9. One real order, one real redeem by staff, one refund: check the admin console numbers against Shopify.
10. Monitor for a day with the rollback (B5) ready.
