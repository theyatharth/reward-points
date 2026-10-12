# Demo: Ecofynd Rewards on the dev store

A step-by-step walk through everything the prototype does, with the numbers you should see. It runs on the DEV app
(`Reward Points (Dev)`), the dev database `reward_points_dev` and `platinum-ecofynd-test-store`. **Nothing here touches production.**

Rule on the dev store (admin console → Earning & redemption): **earn 100 points per 100.00 spent**, **100 points = 10.00**,
**30-day hold**, reward codes valid **90 days**. The store sells in USD; the numbers are the same, only the symbol differs.
The test customer is Shopify customer id `10156980011205` (the one who placed orders #1015 to #1021).

Where the numbers come from: points = floor(eligible value × 100 / 100.00). Eligible value is the line price after discounts, with
included tax taken out, gift cards excluded, shipping excluded. Use products with no tax and no discount for the exact numbers below.

## 0. What you need open

- The storefront, logged in as the test customer: the floating pill "N pts" (bottom right) and the page `/pages/rewards`.
- The admin console: `https://integrations.platinuminfo.tech/reward-points-dev/admin/` (sign in; the one-time password forces a change).
- The Shopify admin (orders, discounts) and, optionally, pgAdmin on `reward_points_dev`.

## 1. The starting picture (admin console)

1. **Overview.** 1 member. Points: issued about 5,323 (earned on #1015 to #1021) plus any bonus granted during testing; reversed 2,098
   (#1019: 675 + 674, #1021: 749); pending 3,225. Liability is valued at 100 points = 10.00. Recent events: processed.
2. **Customers → search `10156980011205`.** The ledger shows one earn per order and the three refund entries (−675, −674, −749). Point lots:
   five pending lots usable from 7 Nov 2026 (the 30-day hold).
3. **Orders & webhooks.** #1019 "fully reversed", #1020 "earned" (R3 gift card and R4 money-only refunds reversed 0), #1021 "cancelled".
   Events: all processed, nothing failed.

## 2. Earn: a paid order (webhook → ledger → storefront)

1. In the dev store, place an order as the test customer: **2 units of "The Collection Snowboard: Liquid" at 749.95**, no discount code, bogus
   gateway. Eligible value 1,499.90.
2. Within about 30 seconds (the worker): **+1,499 points pending**. Admin → Customers shows an `earn` entry of 1,499 and a new pending lot usable
   30 days later. Orders shows the order with 1,499 points.
3. Storefront: the pill's balance does not change (pending is not spendable); the panel and the Rewards page show
   "1,499 more on the way" with the date, and a new notification "You're earning 1,499 points on order #…" (a dot on the pill until read).

## 3. Refund by line: reversal by line identity

1. In Shopify, refund **one of the two units** (restock or not). Expected reversal: **750 points** (half of 1,499 rounds up).
2. Refund the **second unit**. Expected: **749 more**, total 1,499 reversed, the order shows "fully reversed", pending back to what it was.
3. A refund of only shipping, or a money-only refund, reverses 0 and still appears in the ledger as processed with no entry.
4. Cancel a fresh order instead: all of its points are reversed at once; if its refund arrives too (it does, ~40 ms apart), nothing is counted twice.

## 4. Activate: points become spendable

The 30-day hold is real, so for the demo move a lot forward **on the dev database only** (pgAdmin, dev):

```sql
UPDATE "PointLot" SET "activatesAt" = NOW()
 WHERE id = (SELECT id FROM "PointLot" WHERE status = 'pending' ORDER BY "createdAt" DESC LIMIT 1);
```

Within 5 minutes the worker activates it (it asks Shopify first whether the order has refunds we have not applied). Expected: the lot's points
move from pending to **available**, a notification "N points are now available to use", the pill shows "N pts" (the metafield sync follows
within a minute). Admin → Overview: available and liability rise by the same amount.

## 5. Adjust: a manual bonus (admin)

Customers → the member → **Add Points**: 100, reason "Special bonus", note "Demo bonus". Expected: available +100 at once (an active lot, no
hold), a `bonus` ledger entry showing your note and your sign-in under "Why", and an **Audit log** row `points_adjusted`
(previous → new available). Try **Deduct Points** for more than the available balance: refused. Submitting the same form twice applies once.

## 6. Redeem: one real Shopify code

1. `/pages/rewards` → "Rewards you can use": with 100 available it says **10 off** and offers Redeem. With 350 available it says
   "300 points for 3 rewards in one code: 30 off". Click **Redeem**.
2. Expected: balance drops by the points used; a code `PLAT-XXXXXXXX` appears under "Ready to use" with a Copy button; the notification
   "Your 10 reward is ready to use (100 points)". In the Shopify admin → Discounts: that code, **this customer only**, **one use**, ends in 90 days,
   amount 10.00.
3. Double-click Redeem: one code only (same request key). Open the page in two browsers and click at once: one succeeds.
4. While points are owed (step 8) Redeem is paused with a message.

## 7. Use the code, then cancel: the reward comes back

1. At checkout enter the code: the order is paid with 10.00 off. The webhook marks the reward **used** (admin → the member → Rewards shows
   "used on order …").
2. **Cancel that order** in Shopify. Expected: the order's own points are cancelled, and the **reward's 100 points come back** as available
   (a `reward_return` entry), the reward shows "returned", and the OLD code is deleted from Shopify (Discounts no longer lists it; the
   worker does it within a minute). The customer cannot use the code again and keeps the points.

## 8. Refund after redeeming: unused code voided, or points owed

1. Earn and activate 100 points from an order, then redeem (step 6) but do NOT use the code.
2. **Fully refund the order the points came from.** Expected: the unused code is **voided** (reward "returned", the Shopify code deleted),
   its points come back and cancel the reversal: **no debt**, balance 0. The customer's page no longer lists the code.
3. If the code HAD been used on an order: the reversal cannot be taken from anywhere, so the member **owes** the points: available stays 0, "100
   points are being recovered" appears on the page, Redeem is paused, and the next activated points repay the debt first.

## 9. Operate: events, reconciliation, audit

- **Orders & webhooks.** Filter events by status. A failed event shows its error and the automatic retry time (1, 5, 30, 120, 360 minutes); a dead
  one has a **Retry** button (fresh attempts; audited). To see one: a refund for an order the ledger has not seen yet fails "not yet in ledger"
  and applies by itself once the order arrives.
- **Reconciliation → Run reconciliation.** Expected: "no issues" for the 1 account: balances equal their lots, the ledger adds up, every
  reversal matches. (The worker also runs it every night.)
- **Audit log.** Sign-ins, adjustments, retries, with who, previous value, new value and reason. It cannot be edited or deleted (database trigger).
- **Rules.** Read only: the numbers above.
- **Not available in this version** (the pages say so): reward catalogue, e-mail/WhatsApp notifications, analytics events, rule editing.

## 10. What the demo deliberately does not show

Several rewards in a catalogue, a minimum cart value, points that expire with age, campaigns (2× points), e-mail identity and guest orders, tax-inclusive
partial refunds on a taxed line, non-USD orders, and the returns flow (`returns/*` webhooks): see `docs/CLIENT-TESTS.md` and
`test/fixtures/shopify/README.md` for exactly what is verified against real captures and what is not.
