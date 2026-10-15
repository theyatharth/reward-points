# Client test guide: Ecofynd Rewards on the test store

Written for the person testing the rewards system on the client test store (`reward-points-test-oldfdvqk.myshopify.com`, INR). Twelve scenarios,
each with the numbers you should see. It runs on the DEV app and the dev database only. Production is not involved.

## 0. Setup

**The rule on this store** (admin console → Earning & redemption): earn **1 point per ₹1 spent** (100 points per ₹100), **100 points = ₹10**,
**holding period 0 days**, reward codes valid **90 days**, rounding "proportional, round down", prices taken **after discounts**, **included tax taken
out** (GST-inclusive prices), shipping and gift cards earn nothing. A Return of points when an order is cancelled or fully refunded is on.

**What you need**

| What | Where / how |
|---|---|
| Admin console | `https://integrations.platinuminfo.tech/reward-points-dev/admin/`. Sign in with the e-mail you were given and its one-time password; you must change the password at first sign-in. |
| The storefront | The store's **storefront password** (development stores are password protected): the page asks for it before the shop opens. |
| A customer account | Customers sign in with a **one-time code sent by e-mail**, not a password (Shopify's new customer accounts). Use an inbox you can read. If the widget says "Please log in" while you are signed in, tell us at once: that is the one thing we have not yet seen on this store. |
| Where customers see their points | The floating pill ("N pts", bottom right) and the page `/pages/rewards`. |
| Shopify admin | Orders, Discounts, and Customers, to place and refund orders and to see the codes. |
| Products | Any product with no discount. Use prices that make the arithmetic easy (₹500, ₹749.95, ₹1,050). Put at least one product at **₹15** and one at **₹1,050 (5% GST included)** if the store has tax set up. |

**One admin e-mail per shop.** If the same e-mail were an admin of two shops, the console cannot know which shop you mean and refuses the sign-in with a
message saying so. Always use a different admin e-mail for each shop.

**Timing.** Orders reach us by webhook within seconds. The background worker runs every 30 seconds; with a 0-day hold, points become usable
**within about a minute** of the order. The admin Overview shows "Last worker tick": green while recent, a warning after 5 minutes. If it is red or
amber, nothing below will move: tell us.

**Before you start**, note the customer's numbers from admin → Customers → search the Shopify customer id (Shopify admin → Customers → the number in the
URL). Every scenario below is written for a customer who starts at **0 points**; if yours does not, add the difference to every "expected" figure.

---

## The twelve scenarios

### 1. Earn: a paid order
1. Place an order as the customer: **2 × ₹500**, no discount code, any payment.
2. Expected within about a minute: **+1,000 points**, usable (hold 0). The pill shows **1,000 pts**; the Rewards page shows ₹100 of rewards available;
   notifications: "You're earning 1,000 points on order #…" then "1,000 points are now available to use".
3. Admin → Customers → the customer: an `earn` entry of 1,000 and an `activate` entry. Orders: the order with 1,000 points. Overview: issued +1,000.
4. Variants: a **₹1,050 item with 5% GST included** earns **1,000** (tax taken out, then points on ₹1,000). A **₹149.99** order earns **149** (round down).
   Shipping and a gift card earn **0**.

### 2. Partial refund, by line
1. Place an order: **2 units of a ₹749.95 product** (₹1,499.90). Earns **1,499**.
2. In Shopify refund **one unit**. Expected: **−750** points (half of 1,499, rounded up).
3. Refund the **second unit**. Expected: **−749** more. Total reversed **1,499**; the order shows "fully reversed".
4. A refund of shipping only, or a money-only refund with no item, reverses **0** (the event shows as processed with no entry).

### 3. Cancel an order
1. Place an order of **₹600** (earns 600). Cancel it in Shopify (refund and restock).
2. Expected: **−600**. The order shows "cancelled". If Shopify also sends the refund (it does, a moment later), nothing is counted twice.

### 4. Redeem
1. Make sure the customer has **350 points** available (scenario 1, or admin → Add points).
2. Rewards page → "Rewards you can use": **"300 points for 3 rewards in one code: ₹30 off"**, then **Redeem**.
3. Expected: balance **50**; a code `PLAT-XXXXXXXX` under "Ready to use" with a Copy button; notification "Your ₹30 reward is ready to use (300 points)".
   Shopify admin → Discounts: that code, customer-only, one use, ends in 90 days, ₹30.
4. Double-click Redeem: one code only. Two browsers at once: one succeeds.

### 5. Use the code
1. At checkout, with the code, buy a **₹500** item: ₹30 off, total ₹470.
2. Expected: the reward shows **used on order #…** (admin → the customer → Rewards). The new order earns on what was actually paid: **+470**.

### 6. Cancel an order that used a reward
1. Cancel the order from scenario 5.
2. Expected: its own **470 points reversed**, and the reward's **300 points come back** (a `reward return` entry); the reward shows "returned". The old code is deleted in Shopify
   within a minute (Discounts no longer lists it). The customer keeps the points and cannot use the old code again.

### 7. Unlock with a hold of 0
1. Place an order of **₹400**. Watch the pill: it moves from "pending" to **400 pts available** in about a minute, not 30 days.
2. Admin → Overview shows "Last worker tick" a few seconds old. Before unlocking, the worker asks Shopify whether the order has refunds we have not applied: refund the order **before** the
   worker's next tick if you can; the points are then reversed instead of becoming usable.
3. To try a hold: admin → Rules → Edit → holding period **1** day → the next order stays pending for a day. Set it back to 0.

### 8. An owed balance
1. Start from 0. Order **O1 = ₹100**: **+100** available.
2. Redeem **100 points**: a **₹10** code, balance 0.
3. Use the code on order **O2 = a ₹15 item**: pay ₹5, earns **+5**.
4. **Fully refund O1.** The 100 points cannot all be taken back: 5 come from O2's points, the code is already used, so the customer **owes 95**.
   Expected: available **0**, the page says **"95 points are being recovered"**, Redeem is **paused**. Admin → Customers shows owed 95.
   (With a ₹10 item and a 100%-off code, O2 earns 0 and the debt is the full 100, if Shopify accepts a ₹0 order.)
5. The next order of **₹200** (+200): it repays the 95 first. Expected: available **105**, owed 0, Redeem works again.
6. The same refund **before** the code is used does not leave a debt: the unused code is voided, its points come back, and the reversal is covered.

### 9. A manual adjustment
1. Admin → Customers → the customer → **Add Points**: **100**, reason "Special bonus", a note of at least 5 characters.
2. Expected: available **+100** at once; a `bonus` entry with your note and your sign-in; Audit log: `points_adjusted` (previous → new). **Deduct** more than the balance: refused.
   Submitting the same form twice applies once. A note shorter than 5 characters is refused.

### 10. Change a rule
1. Admin → Earning & redemption → **Edit rules**. Change **points earned** from 100 to **50** (per ₹100). **Review changes** shows previous → new. **Save rules**.
2. Expected: Audit log `rules_changed` with the previous and new value, your sign-in. The next order of **₹1,000** earns **500**, not 1,000. Points already earned are not rewritten.
3. Refusals to try: spend **0**, holding days **400**, points **0**, a text amount: each is refused with the field named and nothing saved. A reward worth more than 25% of spend asks you to tick a warning
   first. Open the page in two tabs, save in one, then save in the other: the second is told the rules changed. Put the rule back afterwards.

### 11. Reconciliation
1. Admin → Reconciliation → **Run reconciliation** after the scenarios above.
2. Expected: **no issues**: every account's balance equals its lots, the ledger adds up to available + pending − owed, every refund's reversal matches the order. The result is stored; the worker also runs it every night.
3. To see it complain you need a developer: it is meant to stay quiet.

### 12. A Shopify Return
1. In Shopify admin, open an earned order → **Return items**, choose a unit, create the return, and then **refund** it (the refund is what Shopify sends us).
2. Expected: when the **refund** is created it behaves exactly like scenario 2: the returned unit's share is reversed, by line.
   A return that is only requested or closed **without a refund** changes nothing (we do not subscribe to the return events).
3. **This flow has not been seen against real Shopify.** Please run it once and tell us what you saw (orders and amounts); the first real return is the capture that proves it.

---

## How the scenarios map to the client's 43 tests

The full table, with the status of each of the 43, is `docs/CLIENT-TESTS.md`; each is an automated test in `test/loyalty/client-43.test.js`. **31 are working, 5 partial, 7 not built.**

| Scenario | Client tests it exercises |
|---|---|
| 1 Earn | 1, 2, 6, 7, 8, 9, 10, 11 |
| 2 Partial refund | 16, 17, 18, 19, 23 |
| 3 Cancel | 15, 16, 20, 24 |
| 4 Redeem | 27, 28, 29, 30 |
| 5 Use the code | 31, 33 |
| 6 Cancel with a reward | 35 |
| 7 Unlock, hold 0 (and a hold of 1 day) | 10, 11, 12, 15 |
| 8 Owed balance | 21, 22 |
| 9 Adjustment | 36, 37 |
| 10 Rule change | 38, 39 |
| 11 Reconciliation | 41, 42 |
| 12 Return | 15, 16, 17 (and the unverified returns flow) |

Tests 25 and 26 (a failed webhook is kept and retried; a refund that arrives before its order waits and is applied) happen by themselves: look for them in the console under Orders & webhooks.

Not exercised by any scenario because they are not built: 4 and 5 (e-mail identity and guest orders), 13 and 14 (points expiring after 12 months), 32 and 40 (minimum cart and the reward catalogue), 43 (campaigns).
Test 34 (an unused code expires and returns its points) is off by default (`returnPointsOnCodeExpiry` is off): it needs a developer to switch it on and wait out a code's validity.

## Known gaps: what this build does not do

**By decision**
- One redemption rule per shop, not a catalogue of several rewards with a minimum cart, usage limits and collections (client tests 32, 40).
- Points never expire with age (13, 14). Campaign multipliers are off (43).
- Customers are identified by their Shopify customer id only: no e-mail, name or phone is stored, so guest orders earn nothing and are not claimed later (4, 5).
- On-site notifications only: no e-mail or WhatsApp, no per-channel switches.

**Not built yet**
- Excluded collections are stored but not applied when points are earned (only gift cards are excluded).
- The admin shows no revenue, average order value or repeat-purchase figures (the ledger stores eligible value, not order totals); there is no analytics events page.
- Retry policy: a failing webhook is retried at 1, 5, 30, 120 and 360 minutes and is dead on the 6th failure. The client's engine stops at the 5th. One constant to change once decided.
- Nobody is alerted when an event dies, the worker stops, or reconciliation finds something: today you look at the Overview.
- Currencies with no minor unit (JPY) or three decimals (KWD) are not supported: every amount is handled in hundredths.
- Signing in to the console with the same e-mail in two shops is refused (use one e-mail per shop).

**Not yet seen against real Shopify** (this store is the first INR store)
- Partial refunds of a taxed line on a tax-inclusive order; non-USD orders and refunds; the returns flow; two tax lines on one item (CGST and SGST); guest orders; customer accounts with one-time codes
  through the App Proxy. Each one you try and report becomes a captured, tested case. What was already proven on the dev store (USD): earn, refunds by line, cancel, redeem, use, the unlock check against Shopify's own refund list.

**Before production** see `docs/cutover-preflight.md`: opening balances for existing customers, the production webhook subscriptions, the privacy webhooks, monitoring, backups and a rollback plan.
