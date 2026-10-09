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

## Next
- TASK 4 Jobs in the worker, then CHECKPOINT 1.

## Blockers / notes
- Excluded-COLLECTION lines are not applied at earn time (`writeEarning` looks the collections up but the result is
  not used; the fake gateway returns {}), so a snapshot line is only ever excluded for `gift_card` today. The snapshot
  field `excludedReason` is where a collection exclusion will go.
- `.tmp/run-db.mjs` (the database wrapper) does not exist on the machine this session runs on, and `.env` points
  at the remote RDS, which standing rules say may only be reached through that wrapper. Pure tests run locally;
  tests that need a database are verified by CI (Postgres 17 service) until the wrapper is available here.
  Consequence: migrations 4 onward have NOT yet been applied to the test or dev database (CHECKPOINT 1 needs this).
