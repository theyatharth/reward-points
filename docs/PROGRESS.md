# Progress (prototype on the dev test store)

Goal: a working prototype on platinum-ecofynd-test-store (dev app 0f07160c..., database reward_points_dev).
Production is not touched. Branch: phase1. One commit and push per task; CI green before the next task.
Reference logic: test/vendor/engine.js (client's, unmodified).

## Done
- TASK 1 Redaction and real refund fixtures: `user_id`, `transactions[].authorization`, `transactions[].message`
  added to REDACT_KEYS and `receipt` to REDACT_SUBTREES (keys kept); redaction made idempotent; tests added.
  Six real fixtures added under test/fixtures/shopify/real/ (R1 to R5 and orders-cancelled-1021) with `_provenance`.
  Fixtures README updated: refund and cancel shapes VERIFIED; still unverified: partial refunds of taxed lines on
  tax-inclusive orders, non-USD, the returns flow.

- TASK 2 Refund and cancel rewrite (D1 to D3), migration 4 (`LoyaltyOrder.lines`, `LoyaltyRefund.lines`, both nullable
  JSONB, no backfill).
  * `web/loyalty/rules/refund-lines.js`: pure per-line reversal (round half up per line, cumulative, final refund exact).
  * `earning.js` returns a per-line result; `writeEarning` stores it as the order's snapshot.
  * `writeRefund` / `writeCancel` rewritten: lockAccount first, everything re-read inside the transaction, redelivery
    and cancel/refund in either order add nothing twice, refund before its order is RETRIED (the order's stored
    orders/paid event, or the Shopify lookup, decides retry versus skip), no snapshot -> rebuilt from the stored
    orders/paid event (and checked against what the ledger recorded) or the event fails visibly.
  * Permanent errors (`error.permanent`, e.g. quantity above the line quantity, a refund entry with no line id) go
    straight to `dead` with the reason in `lastError`.
  * D4 basics came with it, because available can no longer go negative: `takeBackPoints` (own lot, then other active
    lots oldest first, then the debt column), new activated points repay debt first, redemption refuses on debt.
  * Real fixtures #1019 to #1021 (orders/paid) added; tests `real-refunds.test.js`, `refund-lines.test.js`; the older
    ledger / client / redemption / topic-pipeline tests moved from money-amount refunds to line refunds.
  * Hand-computed numbers reproduced by the pure tests: R1 = 675, R2 = 674 (1349). The database-backed assertions
    (674 for #1020; 749 for #1021 with the cancel either side) are verified by CI.

- TASK 3 Concurrency, debt, invariants (D4), migration 5 (`CHECK available >= 0`, NOT VALID: enforced on new and
  updated rows, never scans old ones).
  * lockAccount is the first statement of every ledger writer (earn, refund, cancel, activate, redeem, compensate;
    adjust joins in Task 5), lots and rewards are read FOR UPDATE inside the transaction, every balance change is a
    delta. `setLockHook` is a test seam (accountId, tag) used to force writers to reach the lock together.
  * `takeBackPoints`: own lot, other active lots (oldest first), then unused reward codes (newest first; a voided
    code returns its points, any surplus stays as a fresh active lot, Reward -> 'returned', Redemption -> 'voided',
    `reward_return` ledger entry), then debt. A 'creating' redemption and an expired code are not voidable.
    Deleting a voided code in Shopify is NOT done yet: Task 6 (needs a column or job to remember it).
  * Returned points of a failed redemption repay debt first; replaying a voided redemption answers REWARD_VOIDED.
  * Event claim fixed: a worker that loses the claim no longer marks the event failed (updateMany count 0 -> skip).
  * Tests: `test/helpers/invariants.js` (assertLedgerInvariants / assertLedgerBalances / assertShopInvariants),
    `owed-balance.test.js` (voiding, debt, repayment, refusal, CHECK), `ledger-concurrency.test.js` (20 barrier-forced
    refund-versus-redeem runs, both interleavings asserted; three workers on the same events).

- TASK 4 Jobs in the worker, migration 6 (`WebhookEvent.payloadPurgedAt`).
  * (a) `activateDueLots`: due pending lots go through `activatePendingLot` (J3 check through the gateway, account
    lock, lot re-read, debt repaid first); a lot failing J3 stays pending and is reported in `blocked`.
  * (b) `RETRY_DELAYS_MINUTES = [1, 5, 30, 120, 360]`: the failure that follows the last delay (the 6th failed
    attempt, i.e. the original plus five retries) is `dead`. READING OF THE BRIEF: "dead after the 5th failure" is
    taken as "after the 5th retry fails", so every listed delay is used; to make the 5th failure dead instead, drop
    the last delay (one constant, pinned by a test). A payload that is not a JSON object, or any error flagged
    `permanent`, is dead on the first attempt with the reason in `lastError`.
  * (c) `recoverStuckEvents`: 'processing' for > 10 minutes counts as a failed attempt and follows the schedule.
  * (d) `purgeOldPayloads`: processed events older than 90 days (by receipt time) get payload `{"_purged": true}`
    and `payloadPurgedAt`; every other column is kept. Caveat: an order earned BEFORE migration 4 can no longer
    rebuild its line snapshot once its orders/paid payload is purged.
  * (e) `web/loyalty/service/reconcile.js`: `reconcileAccount` (balances vs lots, the ledger identity, lot and order
    sanity), `rebuildCache` (available/pending from lots, debt from the identity, AuditLog row per change, refuses
    a negative debt), `runReconciliation({shop, repair})` -> JobRun 'reconcile' with the result, and
    `runNightlyReconciliation` (from 21:00 UTC, once per 23 h, report only; JobRun 'reconcile_nightly' marks the run).
    On demand: `node scripts/run-reconciliation.mjs --shop <shop> [--repair]`.
  * `createWorkerWork()` is the worker tick: drain events, recover stuck, activate (every 5 min), purge (daily),
    nightly reconcile; each job writes its own JobRun and one failing job does not stop the others. `web/worker.js` uses it.
  * NOTE: the brief points at `processDue`, `reconcile` and `rebuildCache` in `test/vendor/engine.js`, but that file
    only holds `clientEngineEarn` and `clientEngineRefund`; the jobs were built from the semantics in the brief and
    the ledger identity, not ported from client code.
  * Tests: `jobs.test.js` (all on the fake clock).

- CHECKPOINT 1 PASSED (2026-10-09). Server: 46 files synced (sizes verified, no deletions), prisma generate (6.19.3,
  client knows LoyaltyOrder.lines and WebhookEvent.payloadPurgedAt), migrations 4 to 6 applied test then dev through
  `.tmp/run-db.mjs`, full suite twice on reward_points_dev_test: 297 / 297 / 0 failures both times. After restarting
  reward-points-dev and reward-points-dev-worker: tick picked=9 processed=9 failed=0; all 13 events processed; pending
  3225, available 0, debt 0; refunds -675 and -674 (#1019), -749 (#1021), none for #1020; invariants match; JobRun shows
  process_events and purge_payloads.

- A DONE: client files copied unchanged to docs/reference/; `docs/reference/COMPARISON.md` lists the differences between
  Task 4 and the real processDue / reconcile / rebuildCache / voidUnusedRewards / reverseForOrder. Not changed because of
  it (reported first): retry policy (engine: 5th failure is final), `block` rounding (engine: full blocks; ours: exact
  only), the missing "incorrect reversal" reconcile check, the reward catalogue, collection exclusion at earn.
- TASK 4b DONE: `expireUnusedCodes` (jobs.js): an ACTIVE Reward past `expiresAt` -> Reward and Redemption 'expired';
  points back (reward_return entry + fresh active lot, debt repaid first) only if `returnPointsOnCodeExpiry`.
  Shared helper `returnPoints` in ledger.js (also used by the failed-redemption compensation). Replaying an expired
  redemption answers REWARD_EXPIRED. Lot expiry stays off. Tests: `code-expiry.test.js` (fake clock).

- TASK 5 DONE (point C included): `web/loyalty/service/adjustment.js` `adjustPoints`: whole number != 0 (|n| <= 1,000,000),
  reason required, note >= 5 characters trimmed, admin id of an existing admin of the shop, idempotency key (scoped
  by account), deduction above AVAILABLE refused (pending is not deductible), reason "Special bonus" -> `bonus` entry
  (a negative one is a plain adjustment), positive -> ACTIVE lot at once and repays debt first, deduction consumes
  active lots earliest first, one AuditLog row `points_adjusted` per adjustment with before/after, account locked
  first (tag 'adjust'). Customer by Shopify id only (D5). `consumeLots` moved to ledger.js; `returnPoints` takes a
  ledger type. Tests: `adjustment.test.js`.

- TASK 6 DONE (migration 7: `Reward.usedOrderId`, `needsShopifyDelete`, `shopifyDeletedAt`, index on (shop, discountCode)).
  * `/api/proxy/redeem` and `/history` rewritten over the new ledger (`routes/proxy.routes.js`, `lib/app-proxy.js`,
    `loyalty/service/storefront.js`): signature verified, customer = the signed `logged_in_customer_id` only (a body
    field is ignored), idempotency key from the `Idempotency-Key` header or the body, rate limit kept, responses built
    field by field (D6): no internal ids, no notes, no admin names. Redeem answers `{success, status, code, pointsUsed,
    value, currency, expiresAt, balance}`; refusals `{success:false, reason, message, needed?|owed?}` with 400/409/410/502.
    History answers `{balance{available,pending,owed}, rule, pending[{points,availableOn}], rewards[{code,value,expiresAt}],
    history[{date,kind,points,label}]}`. The old metafield/CustomerPoint code is no longer used by these routes.
  * The real gateway already creates the code (customer-bound, single use, `endsAt` = redemption expiry from
    `rewardExpiryDays`, value from `rewardValue`); new `deleteRewardDiscount` (discountCodeDelete) + fake.
  * orders/paid with a reward code (`recordRewardUse`): Reward and Redemption -> 'used', order remembered; runs even if
    the order earns 0; wrong customer, second use, use after expiry/void are logged to AuditLog
    (`reward_used_by_other_customer`, `reward_used_twice`, `reward_used_after_<status>`), no automatic claw-back.
  * Cancel, or a refund that completes EVERY line (gift cards included), returns the reward when
    `restoreRewardOnFullRefund` (`restoreRewardForOrder`: reward_return entry + fresh active lot, debt repaid first,
    once per reward). Replaying a used / returned / expired / voided redemption never shows the code.
  * D4 void -> `needsShopifyDelete`; worker job `delete_voided_codes` deletes the code in Shopify, retried on failure.
  * Tests: `reward-wiring.test.js` (ledger side, fake gateway), `proxy-routes.test.js` (HTTP, signed requests).
    `scripts/live-redeem-test.mjs`: ONE real redeem on the dev store from EC2 through the wrapper (needs available points).
  * NOT built: minimum cart value and per-reward limits (the engine's reward catalogue; our rule is one points/value pair).

### Race edge (asked about; NOT changed)
Redeem first, the refund of the source order lands while the redemption is still `creating`: the refund finds no
Reward row to void, so it takes what it can and the rest becomes DEBT; then `completeRedemption` creates the code.
What the customer experiences: the redeem succeeds, they get a working code (50.00 off) and see balance 0 with an
owed balance (the refunded order's points); further redemption is paused until new points repay the debt. They hold
a discount and owe the points for it. Should a code issued while debt > 0 be voided in Shopify right after creation?
Recommendation: YES. It is the same situation D4 already handles (an unused code is voided before a customer owes),
the window is a few hundred milliseconds so it is rare, and otherwise the shop pays out a reward for points whose
order was refunded. Implementation if wanted: in `completeRedemption`, under the account lock, if `debt > 0` after
the Reward is created: mark Reward 'returned' and Redemption 'voided', `returnPoints` (which repays the debt first),
set `needsShopifyDelete`. The customer then sees "this reward could not be issued because an order was just returned"
and the code never works. The cost is a code that appears and is withdrawn seconds later, in a rare race.

- TASK 7 DONE (migration 8: dirty counters + three triggers).
  * Metafield sync (`loyalty/service/metafield-sync.js`, worker job `sync_metafields`): triggers bump
    `LoyaltyAccount.metafieldSeq` when balances change or one of the account's rewards is created / changes status,
    expiry or code, and `LoyaltyConfig.ruleSeq` when pointsPerReward, rewardValue, holdPeriodDays or currency change.
    The sync reads the seq FIRST, writes `custom.reward_points`, `pending_points`, `pending_points_available_at`,
    `earned_discount_code` (newest live code or "NONE") six customers per call, then stamps `metafieldSyncedSeq` with
    the value it read, so a change during a sync stays dirty. Failed batch -> one by one; a customer Shopify says no
    longer exists is marked synced; anything else stays dirty. The rule goes to the app metafield
    `rewards.redeem_rule` (JSON). Failure-only runs are recorded at most once per 10 minutes.
    `scripts/resync-metafields.mjs --shop` marks everything dirty (after `reset-metafields.mjs`).
  * Widget fixes (T3.6): proxy path is a block setting (`proxy_path`, default `/apps/rewards`; set `/apps/rewards-dev`
    for the dev app) validated by `EcoRewards.safeProxyPath`; the redeem threshold and hold period come from the
    rule (app metafield for the first paint, `/history` as the truth) - no `= 100`, no "30 days"; innerHTML replaced by
    createElement/textContent everywhere; `customer.first_name`, codes and dates escaped in Liquid, no inline
    `onclick` with interpolated codes; no customer id sent from the browser; idempotency key per redeem kept across a
    network error; the `reward_history` metafield is no longer read (history comes from the ledger); the rewards
    page's invalid two-object schema fixed. Shared code: `extensions/rewards-widget/assets/rewards-client.js`.
    Tests: `metafield-sync.test.js` (DB), `widget-client.test.js` (pure: vm sandbox + static checks of the blocks).
  * UNVERIFIED until the theme runs: that `app.metafields.rewards.redeem_rule` is readable in the blocks (spike T3.0
    was never run). If it is not, the first paint shows "Checking your rewards..." and the live numbers appear as
    soon as `/history` answers, so nothing breaks.

- TASK 8 (re-scoped) DONE: admin console, static HTML/CSS/ES modules under `/admin` (`web/admin/`), outside the Shopify iframe,
  before the Shopify session validator; the client's design tokens, fonts and markup (`public/admin.css` is copied from the
  prototype). Nothing of Task 8 existed before (the premise "keep what Task 8 built" was wrong): login, sessions, CSRF, rate
  limit and forced password change were BUILT here (migration 9: `AdminLoginAttempt`).
  * Auth: argon2 (scrypt fallback), httpOnly Secure SameSite=Strict cookie scoped to `<base>/admin`, session token stored as
    SHA-256, idle 60 min / absolute 8 h, CSRF token derived from the session token + Origin check on every write, JSON-only
    writes, failed-login counters per account (5/15 min) and per IP (30/15 min) in Postgres, one-time password forces a change
    (everything else 403 until then; other sessions are revoked), login/logout/failed login/password change in the audit log,
    strict CSP (no inline script or style), `X-Frame-Options: DENY`, no-store.
  * One JSON endpoint per view, whitelisted fields only, scoped to the admin's shop: `overview`, `customers` (+ `/:id`,
    `/:id/adjust`), `orders`, `events` (+ `/:id/retry`), `audit`, `reconciliation` (+ `/run`), `rules` (read only), `meta`.
  * Pages in the design's order, one commit each: Overview, Customers (ledger + adjust), Orders & webhooks (filter, retry),
    Audit log, Reconciliation, Rules. Catalogue, Notifications and Analytics say "Not available in this version".
  * `esc.js`: every value goes through `esc()` via the `h` tagged template; `test/loyalty/admin-esc.test.js` scans every console
    script and FAILS on an HTML template that is not `h`, an unquoted or URL-valued interpolated attribute, an inline handler,
    HTML in a string literal, or innerHTML outside esc.js; the scanner is itself tested against unsafe sources.
  * `docs/UI-MAP.md`: every screen -> data -> endpoint -> exists / partial / missing.
  * Admin URL: `<application_url>/admin/` = https://integrations.platinuminfo.tech/reward-points-dev/admin/ (assumes nginx
    strips the base path like it does for `/api/proxy`; not yet seen in a browser). The console serves `ADMIN_SHOP`, or the
    only shop with a loyalty config (dev has one).
  * Tests: 463 in CI and on the persistent test database (twice). One old test (worker JobRun order) tied on a fixed clock and
    was fixed.
- CHECKPOINT 3 is WAITING FOR THE USER ("continue"): files synced (39, sizes verified), migration 9 applied test then dev.

- STEP 5 DONE (restyle of the widget and Rewards page to the prototype): generated scoped stylesheet
  (`assets/rewards-theme.css`, `scripts/build-storefront-css.mjs`), shared renderers and `initPage` / `initWidget` in
  `assets/rewards-client.js`, both blocks rewritten (widget: pill + panel, side and page-path settings; page: balance, owed,
  pending, ready codes, ONE reward card, next-reward progress, ways to earn, activity). `/history` rule now carries
  `earnPoints` and `earnSpend`. Tests: `storefront-render.test.js` (fake DOM + fake fetch). Needs `app deploy` and a theme
  check on the Mac to be seen: not yet viewed in a browser.

- STEP 6 DONE (the four agreed fixes, in order):
  1. Race fix: `completeRedemption` (now under the account lock) voids the code when the customer owes points: Reward
     `returned` + `needsShopifyDelete`, Redemption `voided`, `returnPoints` (repays the debt first), the customer gets
     REWARD_VOIDED and never sees the code. The 20-run race test no longer accepts "reward active with debt".
  2. A reward restored after a cancel or full refund now also queues its OLD code for deletion in Shopify (Shopify gives a
     cancelled order's discount usage back); the same worker job deletes it.
  3. `block` rounding = whole spend blocks (`floor(paise / spend) x points`), as `engine.js pointsFor`. The 59-line vendor
     extract had the opposite reading; the differential test compares `block` with the real engine (10,000 inputs, 0 unexplained).
  4. Reconciliation: `reversal_mismatch` (ledger refund/cancel entries per order vs the reversals recorded on the order).

- TASK 9 (part): ON-SITE NOTIFICATIONS DONE (migration 10: `Notification`). Written inside the ledger transaction for points
  earned (order name), points activated (what became usable after debt repayment) and reward redeemed (not for a code voided as
  it is issued); dedupe keys make a redelivery write nothing twice. `/history` returns `notifications {unread, items[{type, text,
  date, read}]}`, `POST /apps/<proxy>/notifications/read` marks the caller's read; widget dot + panel lines, Rewards page
  section; admin Notifications page is a read-only log (e-mail/WhatsApp/switches/outbox: not available, D8).

- TASK 9 DOCS DONE: `docs/DEMO.md` (steps with expected numbers), `docs/cutover-preflight.md` (checklist only; the cutover
  was NOT run and production was not touched), `docs/CLIENT-TESTS.md` (the 43 client tests: working / partial / not built) and
  `test/loyalty/client-43.test.js` (one test per client test; the not-built ones are `test.skip`).

- BUG FIX (admin console did not open): `app.get('/admin')` also matched `/admin/` (Express is not strict), so `/admin/`
  redirected to the relative `admin/` = `/admin/admin/` and fell into the Shopify catch-all ("No shop provided"). Now
  `mountAdminConsole()` (web/admin/router.js): `/admin` -> 308 to the ABSOLUTE `<APP_BASE_PATH>/admin/`, `/admin/` serves the
  console, any other path under it is a 404, and the console is mounted at `/admin` AND `<base>/admin` (works if nginx stops
  stripping). `admin-routing.test.js` covers it over real HTTP in three ways (through a prefix-stripping proxy, direct, direct
  with prefix). The old behaviour fails 10 of its 19 tests.

- CLIENT TEST READINESS, step 1 (status as of 2026-10-15):

  | Item | Status | Commit |
  |---|---|---|
  | Race fix (void a code issued while debt > 0) | done | 017e3dd |
  | Old-code deletion on reward restore | done | 017e3dd |
  | `block` rounding (whole spend blocks) | done | 017e3dd |
  | Reconcile reversal check (`reversal_mismatch`) | done | 017e3dd |
  | Rules page editing | NOT done: read only (568f283); being built in step 3 | - |

- CLIENT TEST READINESS (2026-10-15), steps 2 to 10:
  * `scripts/check-real-order.mjs` (83243f0): real `getOrder` works on API 2026-07; 8 of 8 dev orders MATCH Shopify's refund list.
  * Rules page editing (preview, audited save, stale-form check); client tests 38 and 39 now working (31 working, 5 partial, 7 not built).
  * Overview "last worker tick" (migration 11, `WorkerHeartbeat`), amber after 5 minutes.
  * Currency: every amount label follows the shop's configured code (`rules/currency.js` plus two browser copies, proven equal by a test);
    the admin Orders page no longer hardcodes INR.
  * `scripts/onboard-shop.mjs` (config from the seed profile, ledgerStartAt = now, idempotent, optional admin, refuses protected databases).
  * Tenant isolation test: three shops (INR, USD, EUR), the same customer id in each, admin and proxy APIs: no leak found.
    One admin e-mail in two shops is refused with a clear message (only to someone who knows the password); different e-mails sign in with ADMIN_SHOP unset.
  * `docs/CLIENT-TEST-GUIDE.md`. Server: files synced, migration 11 on test then dev, suite twice: 667 tests, 0 failures.
  * First client test store onboarded on dev: reward-points-test-oldfdvqk.myshopify.com, INR, hold 0 (offline session found).
  * ADMIN_SHOP is not set in the server .env.

## Next
- Checkpoint 4: sync to the server, apply migration 10 (test, then dev), run the suite twice, report the 43-test table.

## Blockers / notes
- Excluded-COLLECTION lines are not applied at earn time (`writeEarning` looks the collections up but the result is
  not used; the fake gateway returns {}), so a snapshot line is only ever excluded for `gift_card` today. The snapshot
  field `excludedReason` is where a collection exclusion will go.
- Remote access: ssh with the PEM given in the brief, DEV_DIR=/home/ubuntu/reward-points-dev (not a git repo; sync by
  `git archive HEAD -- <files> | tar -x`), node 22 via nvm, database only through `$DEV_DIR/.tmp/run-db.mjs <dev|test> ...`.
  This Mac has no wrapper; local tests are the pure ones, database tests run in CI or on the server.
