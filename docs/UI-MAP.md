# UI map: the client's design, screen by screen

Design: `docs/reference/Ecofynd Rewards V1 (1).html` (the prototype's own engine fakes all its data in the browser).
This file maps every screen of that design to the data it shows, the endpoint that provides it in this build, and
whether it exists. **Missing means the screen shows "Not available in this version"; nothing is simulated.**

Admin console: static HTML, CSS and ES modules served by Express under `/admin` (`web/admin/`), outside the Shopify
iframe, with its own login. One JSON endpoint per view under `/admin/api/`, behind the admin session, fields
whitelisted in `web/admin/data/*.js`. Every value reaches the page through `esc.js` (`h` tagged templates);
`test/loyalty/admin-esc.test.js` fails otherwise.

Legend: **exists** (built and tested) · **partial** · **missing** (not in this version).

## Admin console

| Screen (design) | Data shown | Endpoint | Status |
|---|---|---|---|
| Sign in, forced password change | login, one-time password, new password | `POST /admin/api/login`, `GET /admin/api/session`, `POST /admin/api/change-password`, `POST /admin/api/logout` | exists (argon2, httpOnly Secure SameSite=Strict cookie, hashed session token, CSRF token + Origin check, login rate limit, idle 60 min / absolute 8 h) |
| Overview: Members (total, active 90 d, new 30 d, returning buyers) | accounts, ledger activity, orders per account | `GET /admin/api/overview` | exists (built, `admin-overview.test.js`) |
| Overview: Points (issued, pending, available, redeemed, expired, reversed) + "where issued points are now" bar | ledger sums, lots | `GET /admin/api/overview` | exists (expired = codes expired without return; lot expiry is off) |
| Overview: liability table (available, unlocked-not-used codes, pending, redeemed, expired, being recovered) | balances x rule value per point, rewards | `GET /admin/api/overview` | exists |
| Overview: Rewards (unlocked, used, open codes, redemption rate) | Reward / Redemption rows | `GET /admin/api/overview` | exists |
| Overview: Business (member revenue, AOV, repeat rate, orders per buyer, CLV) | order totals and revenue | none | **missing**: the ledger stores eligible value per order, not order totals or revenue. Shown as "Not available". |
| Overview: recent events (new) | last webhook events: topic, status, time | `GET /admin/api/overview` | exists |
| Customers: search by name, e-mail or phone | the design searches personal data | `GET /admin/api/customers?query=` | **changed by decision D5**: no name, e-mail or phone is stored; search is by Shopify customer id (exact, or a prefix of 4+ digits) |
| Customers: balances (available, pending, lifetime earned, lifetime redeemed, owed) | account, ledger sums | `GET /admin/api/customers/:id` | exists |
| Customers: ledger table (transaction, created, activity, points, status, order, source, available/expires, why) | LedgerEntry (type, points, status, note), order and lot references | `GET /admin/api/customers/:id?cursor=` (paged) | exists (columns follow our ledger: no separate pending/available delta columns) |
| Customers: Add / Deduct points form (amount, reason from the fixed lists, admin, internal note) | `adjustPoints` | `POST /admin/api/customers/:id/adjust` | exists (admin = the logged-in admin; idempotency key; reasons are `ADJUST_REASONS`) |
| Customers: orders and rewards & redemptions tables | LoyaltyOrder, Reward | `GET /admin/api/customers/:id` | exists |
| Orders & webhooks: orders table (paid, eligible, points, state, status) | LoyaltyOrder + refunds | `GET /admin/api/orders` | partial: customer name and order total are not stored (customer id and eligible value are) |
| Orders & webhooks: failed events awaiting retry + Retry now | WebhookEvent (failed, dead) | `GET /admin/api/events?status=`, `POST /admin/api/events/:id/retry` | exists |
| Orders & webhooks: "Failure simulator", Return / Refund / Cancel / Resend buttons | the prototype simulates Shopify | none | **missing on purpose**: events come from real Shopify webhooks; nothing is simulated |
| Earning & redemption (rules) | LoyaltyConfig | `GET /admin/api/rules` | partial: **read only** in this step (editing with validation, audit and diff is a later step). The design's earn rule has spend / points / rounding / basis / tax / shipping / gift cards / collections; ours stores spend, points, rounding, basis, tax handling, shipping, gift cards, excluded collections (not applied at earn), redemption points and value, hold days, code expiry days and the two J2 switches |
| Earning & redemption: campaign rule | campaign multiplier | none | **missing** (Phase 1: campaigns are off by design) |
| Earning & redemption: points expiry (months) | lot expiry | none | **missing** (lot expiry stays off) |
| Reward catalogue | several rewards, each with points, value, minimum cart, usage limit, collections, validity | none | **missing**: one redemption rule per shop, no catalogue, no minimum cart |
| Reconciliation: run, last run, issues, per-member table | JobRun `reconcile` result | `GET /admin/api/reconciliation`, `POST /admin/api/reconciliation/run` | exists (issues and counts; "simulate drift" and "rebuild" buttons are not exposed: rebuilds run from the script and are audited) |
| Notifications: 7 message types x on-site / e-mail / WhatsApp, outbox | notification settings, outbox | none | **missing** (Task 9 plans on-site notifications only) |
| Audit log | AuditLog: when, admin, action, previous, new, reason | `GET /admin/api/audit?cursor=` | exists (previous / new / reason derived per action type; raw detail is never sent) |
| Analytics events | event counts and stream | none | **missing**: no event pipeline |
| Test suite view, Build notes view | the prototype's own tests | none | not part of the product (our tests run in CI; `docs/` holds the notes) |

## Storefront (theme blocks, signed App Proxy)

| Screen (design) | Data shown | Endpoint | Status |
|---|---|---|---|
| Widget, collapsed (button with "N pts") | available points | metafield `custom.reward_points` for the first paint, then `GET /apps/<proxy>/history` | exists as the current floating widget; restyle to the design is a later step |
| Widget, expanded (balance, value, next reward bar, pending, View Rewards) | balance, rule, pending | `GET /apps/<proxy>/history` | exists; restyle later |
| Rewards page: balance + reward value | available, rule | `GET /apps/<proxy>/history` | exists |
| Rewards page: "points expire on ..." | lot expiry | none | **missing** (lot expiry is off) |
| Rewards page: owed ("being recovered") card | debt | `GET /apps/<proxy>/history` (`balance.owed`) | exists |
| Rewards page: pending card with dates | pending lots | `GET /apps/<proxy>/history` (`pending`) | exists |
| Rewards page: "Ready to use" codes | active rewards | `GET /apps/<proxy>/history` (`rewards`) | exists |
| Rewards page: several rewards you can use / next reward from the catalogue | reward catalogue | none | **partial**: one reward card for our single rule (points per reward, value) |
| Rewards page: Redeem button | `redeem` | `POST /apps/<proxy>/redeem` | exists |
| Rewards page: history | ledger | `GET /apps/<proxy>/history` (`history`) | exists |
| Rewards page: ways to earn | static copy | none | static text |
| Shop, product page, cart (reward code validation, minimum cart, stacking), checkout | the prototype's demo store | none | **missing**: the real store is Shopify; cart validation of a reward code is Shopify's (the code is created customer-bound and single use) |
| Account tab, sign-up, guest holds ("held for guest") | accounts by e-mail | none | **missing by decision D5** (no e-mail; guest orders earn nothing) |
