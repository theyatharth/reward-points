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

## Next
- TASK 2 Refund and cancel rewrite (D1 to D3, migration 4). The real orders/paid captures for #1019, #1020, #1021
  are in captures/ (gitignored); they are added to real/ as part of Task 2 because its tests need them.
  Expected: #1019 earns 1349, R1 reverses 675, R2 674; #1020 earns 674, R3 and R4 reverse 0; #1021 earns 749,
  R5 reverses 749 and the cancel 0 more.

## Blockers / notes
- `.tmp/run-db.mjs` (the database wrapper) does not exist on the machine this session runs on, and `.env` points
  at the remote RDS, which standing rules say may only be reached through that wrapper. Pure tests run locally;
  tests that need a database are verified by CI (local Postgres 17 service) until the wrapper is available here.
