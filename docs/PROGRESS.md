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

## Next
- Task 5 (adjust(), point C), Task 6, Task 7, CHECKPOINT 2.

## Blockers / notes
- Excluded-COLLECTION lines are not applied at earn time (`writeEarning` looks the collections up but the result is
  not used; the fake gateway returns {}), so a snapshot line is only ever excluded for `gift_card` today. The snapshot
  field `excludedReason` is where a collection exclusion will go.
- Remote access: ssh with the PEM given in the brief, DEV_DIR=/home/ubuntu/reward-points-dev (not a git repo; sync by
  `git archive HEAD -- <files> | tar -x`), node 22 via nvm, database only through `$DEV_DIR/.tmp/run-db.mjs <dev|test> ...`.
  This Mac has no wrapper; local tests are the pure ones, database tests run in CI or on the server.
