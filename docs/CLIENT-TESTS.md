# The client's 43 edge-case tests against this build

Source: `docs/reference/tests.js` (BRD section 73, the client's prototype suite). Executable version:
`test/loyalty/client-43.test.js`, one test per client test with the client's group and name and its status in the title.
Run `npm test` and read the "The client's 43 edge-case tests" suite: 29 pass as WORKING, 6 pass as PARTIAL (our form of the
behaviour), 8 are skipped as NOT BUILT with the reason in the name.

| # | Group | Client test | Status | Note |
|---|---|---|---|---|
| 1 | Customers | New customer gets exactly one loyalty account | working | |
| 2 | Customers | Returning customer: each order earns its own ledger entry | working | |
| 3 | Customers | Zero points: no rewards affordable, next reward is the smallest | **partial** | one reward rule, no catalogue: the "next reward" is that rule |
| 4 | Customers | Duplicate customer (same email) reuses the existing account | **not built** | decision D5: no e-mail; identity is the Shopify customer id |
| 5 | Customers | Guest checkout holds points; account creation claims them with the original date | **not built** | decision D5: a guest order earns nothing |
| 6 | Earning | Earning rule is configurable (₹100 → 50 points) | working | |
| 7 | Earning | Rounding: ₹149 → 149 (proportional), 100 (per full ₹100 block), 150 when ₹149.5 rounds | working | `block` fixed to the real engine's meaning |
| 8 | Earning | Eligible value excludes gift cards, shipping and GST; uses price after discount | **partial** | we use Shopify's real discount allocations (559) not the client's proportional share (619); intended difference |
| 9 | Earning | GST-inclusive price: ₹419 at 5% GST earns on ₹399.05 | working | real `tax_lines[].price` |
| 10 | Lifecycle | Purchase points start pending with the holding-period date | working | |
| 11 | Lifecycle | Points activate after the holding period (not a day before) | working | |
| 12 | Lifecycle | Holding period 0 days → available immediately | **partial** | starts pending, the worker activates it on its next tick (within a minute) |
| 13 | Lifecycle | Expired points: expire 12 months after activation, with a ledger entry | **not built** | lot expiry stays off by decision |
| 14 | Lifecycle | Expiry takes oldest points first; redeemed points are not expired again | **not built** | lot expiry stays off by decision |
| 15 | Returns & refunds | Full return before activation cancels pending points | working | |
| 16 | Returns & refunds | Full return after activation creates a linked reversal | working | |
| 17 | Returns & refunds | Partial return reverses only the returned share (₹500 of ₹2,000) | working | by line identity (D1): one of four ₹500 units |
| 18 | Returns & refunds | Multiple refunds (3 × ₹333 on ₹999) reverse exactly the points earned | working | three units of ₹333 |
| 19 | Returns & refunds | Same refund delivered twice is applied once | working | |
| 20 | Returns & refunds | Cancellation cancels pending points | working | |
| 21 | Returns & refunds | Negative balance: reward already used, return creates an owed balance that later earnings repay | working | the owed balance is the `debt` column, available never below 0 |
| 22 | Returns & refunds | Unused reward is voided before creating an owed balance | working | |
| 23 | Webhooks | Duplicate webhook (same event id) awards points once | working | |
| 24 | Webhooks | Same order via a different event id is still awarded once | working | |
| 25 | Webhooks | Failed webhook is kept, visible, and retried without duplicates | working | retry schedule 1/5/30/120/360 min |
| 26 | Webhooks | Refund arriving before its order is queued, then applied on retry | working | |
| 27 | Redemption | Exactly enough points (500) redeems ₹50 OFF and leaves 0 | working | |
| 28 | Redemption | Insufficient points (499) is refused with the gap | working | |
| 29 | Redemption | Double-tap on Redeem (same request key) debits once | working | |
| 30 | Redemption | Simultaneous redemptions from two browser sessions: only one succeeds | working | account lock |
| 31 | Redemption | Reward already used cannot be applied again | **partial** | we mark the reward used and refuse a replay; refusing a second checkout is Shopify's (single-use code) |
| 32 | Redemption | Minimum cart value is enforced server-side | **not built** | no minimum cart, no reward catalogue |
| 33 | Redemption | Another customer's code is refused | **partial** | the code is customer-bound in Shopify; if an order still carries it we do not mark it used and log it |
| 34 | Redemption | Expired reward code returns its points | working | when `returnPointsOnCodeExpiry` is on |
| 35 | Redemption | Cancelling an order that used a reward returns the reward's points | working | |
| 36 | Admin | Manual adjustment needs amount, reason, note and admin; it lands in ledger and audit log | working | |
| 37 | Admin | Deduction larger than the available balance is refused | working | |
| 38 | Admin | Invalid rule (₹0 spend) is refused and the live rule is unchanged | **partial** | no rule editing yet; the database refuses a rule with 0 spend |
| 39 | Admin | Rule change is recorded with previous and new value | **not built** | the Rules page is read only |
| 40 | Admin | Invalid reward (value above min cart) is refused | **not built** | no reward catalogue |
| 41 | Integrity | Reconciliation is clean after a busy scenario | working | |
| 42 | Integrity | Reconciliation detects a drifted cached balance; rebuild fixes it from the ledger | working | |
| 43 | Integrity | Future campaign: 2× points only inside its window, capped at max bonus | **not built** | campaigns off by design in Phase 1 |

**Totals: 29 working, 6 partial, 8 not built.**
