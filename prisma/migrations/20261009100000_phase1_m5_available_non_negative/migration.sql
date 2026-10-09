-- Migration 5: LoyaltyAccount.available can no longer be negative (decision D4: what a
-- customer owes is the debt column). Additive: a CHECK constraint only.
-- NOT VALID: enforced for every new and updated row, without scanning rows written
-- before D4 (a database that ever held a negative balance must not fail this migration).
ALTER TABLE "LoyaltyAccount"
  ADD CONSTRAINT "LoyaltyAccount_available_non_negative" CHECK ("available" >= 0) NOT VALID;
