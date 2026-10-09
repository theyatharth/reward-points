# Task 4 against the client's real engine

Reference files, copied unchanged from `~/Downloads` (byte-identical): `engine.js` (47,020 bytes, 623 lines),
`tests.js` (19,937 bytes, 43 tests), `Ecofynd Rewards V1 (1).html`. `test/vendor/engine.js` is a 59-line extract of
`clientEngineEarn` and `clientEngineRefund` only; `processDue`, `reconcile`, `rebuildCache`, `voidUnusedRewards` and
`reverseForOrder` exist only in the real file. Written BEFORE any code was changed because of this comparison.

Legend: SAME / DIFFERENT (and which side is right) / MISSING from ours.

## processDue()

| Engine | Ours (Task 4) | Verdict |
|---|---|---|
| Retries failed events when `nextRetryAt <= now && attempts < 5` | `RETRY_DELAYS_MINUTES = [1,5,30,120,360]`, dead on the 6th failed attempt | **DIFFERENT.** The engine retries only while `attempts < 5`: the 5th failure is final, which is the literal "dead after the 5th failure". I read it as the 5th retry, so every delay in the list was used. With the engine's rule the 360-minute delay is never reached. Recommend the literal reading (drop the 6th attempt); one constant plus one test. Not changed yet. |
| Retry delay: 1 h for a processing error; the simulated outage uses `min(6, 2^attempts)` hours | 1, 5, 30, 120, 360 minutes (the brief) | Brief wins; the engine's own delays are demo values. |
| Activates every order with `pendingLeft > 0`, `availableAt <= now`, not cancelled | `activateDueLots`: due pending lots, plus the J3 check against Shopify and the account lock | SAME intent. Ours adds J3 (a lot with a refund Shopify holds but we have not applied is not activated). |
| Activation: repays debt first (`addLot`: `pay = min(debt, amount)`, lot gets the rest) | `activateLotInTx`: same | SAME. |
| Activation effective date `min(now, availableAt)` | lot keeps `activatesAt`; the activate entry is dated by the clock | Cosmetic. Matters only if lot expiry is switched on. |
| Lot expiry after `expiryMonths` (12) with an `expiry` entry, oldest first; 30-day "expiring" warning | not built (decision: lot expiry stays off) | MISSING on purpose. |
| **Code expiry**: unused redemption past `expiresAt` becomes `expired`; points returned (reward_return entry + lot, debt repaid first) only if `returnPointsOnCodeExpiry` | not built | **MISSING: Task 4b, done next.** |

## reverseForOrder() and voidUnusedRewards()

| Engine | Ours | Verdict |
|---|---|---|
| Reversal by money share: `round(points x refundedMerchValue / merchValue)`, final refund exact | by line identity (D1) | DIFFERENT by decision. |
| Pending points are cancelled first (`fromPending`), then the rest is reversed from available | own lot first (pending or active), then other active lots, then rewards, then debt | SAME result. |
| When `available < rest` and policy is `void_unused_then_owe`: void unused rewards (newest first) until `need` is covered, each void returns its points as a lot; the surplus of a bigger code stays available | `takeBackPoints` step 3: newest first, surplus becomes a fresh active lot | SAME. Ours voids only after other active lots are used, the engine only for the shortfall beyond `available`: the same set. |
| Voidable = redemption `unlocked` (an expired-but-not-yet-marked code is still voidable) | `active` and not past `expiresAt` | Minor: ours never voids an expired code. |
| Shortfall left after voiding becomes `acct.debt` | same | SAME. |
| Guest orders hold points by e-mail and are claimed when the account is created | guest orders earn nothing | MISSING (D5: no e-mail anywhere; a guest has no customer id). |
| `restoreRewardIfNeeded`: full refund or cancel returns the points of the reward the order used (`restoreRewardOnFullRefund`) | not built | MISSING: Task 6. |
| Cancel is idempotent (`status === 'cancelled'`) | cancel recorded as a LoyaltyRefund row | SAME. |

## reconcile() and rebuildCache()

| Engine | Ours | Verdict |
|---|---|---|
| Per account: cached pending and available equal the sums of the ledger's `pendingDelta` / `availableDelta` | our ledger rows carry one signed `points`, no per-bucket delta | DIFFERENT design. We check available = active lots, pending = pending lots, and the identity ledger sum = available + pending - debt. We cannot tell from the ledger alone whether a drift is in `available` or `pending`. |
| Lot check: lots - debt = ledger available | folded into the identity above | SAME intent. |
| Order check "Missing points": order with points but no purchase entry | `order_without_earn_entry` | SAME. |
| "Duplicate points": more than one purchase entry for an order | not checked | MISSING, but a unique index makes it impossible. |
| **"Incorrect reversal": ledger reversed points differ from `order.reversed`** | we only check reversed > earned and the earn entry; we do NOT compare the sum of refund and cancel ledger entries with the sum of `LoyaltyRefund.pointsReversed` | **MISSING: worth porting (cheap).** |
| Every failed event is listed as an issue ("Failed event") | counts per status plus `stuckProcessing` in the result | DIFFERENT: ours is a summary. Listing dead and failed events (id, topic, error) belongs in the admin page (Task 8). |
| `rebuildCache` rebuilds pending and available from the ledger, audit `balance_rebuilt`; does NOT touch debt | rebuilds available and pending from lots and debt from the identity, AuditLog row, refuses a negative debt | DIFFERENT source of truth (ledger deltas vs lots). Ours also repairs debt. |

## adjust() (Task 5, point C)

Engine order of checks: no account -> `whole number other than 0` -> `reason required` -> `note of at least 5 characters (trimmed)` ->
`admin required` -> deduction above `available` refused. `Special bonus` gives a `bonus` entry (status Available), other reasons an
`adjustment` entry. A positive adjustment goes through `addLot`, so it REPAYS DEBT FIRST; a negative one consumes lots. Audit action
`points_adjusted`, previous and new available. Reasons offered in the UI: add: Customer service goodwill, Special bonus, Order issue correction,
Missing points; deduct: Order issue correction, Duplicate points, Points recovery, Policy abuse (the engine accepts any non-empty reason).

## Earning and rules

| Engine | Ours | Verdict |
|---|---|---|
| `rounding: 'block'` = `floor(value / spend) x points` (a full block only: 149 -> 100) | `block` = "award nothing unless exact" (149 -> 0) | **DIFFERENT, ours looks wrong.** The client's test "Rounding: 149 -> 149, 100 (per full 100 block), 150 when 149.5 rounds" pins the engine's meaning. `money.js` says it matches the prototype; it does not. |
| Tax: derived from a per-product GST% | real `tax_lines[].price` | Ours is better (real data). |
| Gift cards excluded; excluded collections excluded | gift cards only (collection lookup result is not applied) | MISSING: collection exclusion at earn time. |
| Campaign multiplier | off (Phase 1: `campaignEnabled = false`) | On purpose. |
| `includeShipping` | `shippingEarning` | SAME. |
| Several rewards (rw10 ... rw200: points, value, minCart, maxUses, collections, stackable, expiryDays), customer picks one | one rule (`pointsPerReward`, `rewardValue`), redeem takes every whole chunk into ONE code | **DIFFERENT product model.** The catalogue, `minCart`, `maxUses`, eligibility, coupon compatibility and `validateRewardForCart` are not built. The brief (Task 6: "value from config") implies the single rule. Tell me if the catalogue is wanted. |
| Notifications: 7 types x 3 channels, `reward_unlocked`, `points_expiring`, ... | not built (Task 9: onsite only) | Planned. |
| `stats()`: members, redemption rate, AOV, repeat rate, ... | not built | The overview page (Task 8) will cover liability only. |
| Customer created with e-mail duplicate check | by Shopify customer id (D5) | On purpose. |

## The 43 client tests (`tests.js`)

43 `t(...)` entries. Our ported file is `test/loyalty/client.test.js` plus `owed-balance.test.js`; the full mapping and the
working / partial / not-built table is for CHECKPOINT 4. Known now: the Admin group (adjust, rule validation, reward validation),
`Expired reward code returns its points` (Task 4b), `Cancelling an order that used a reward` (Task 6), the Lifecycle expiry tests (lot expiry is off),
the Customers duplicate and guest tests, and the campaign test are not built or are deliberate gaps.
