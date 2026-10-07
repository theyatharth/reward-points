-- Migration 3: LoyaltyConfig fields the M5 seed table needs.
-- Additive only: every column has a default that reproduces today's behaviour
-- (gift cards were already excluded in code; the spend denominator was fixed at 100 paise).
ALTER TABLE "LoyaltyConfig"
  ADD COLUMN "spendAmountPaise"          INTEGER   NOT NULL DEFAULT 100,
  ADD COLUMN "earnBasis"                 TEXT      NOT NULL DEFAULT 'after_discount',
  ADD COLUMN "excludeGiftCards"          BOOLEAN   NOT NULL DEFAULT true,
  ADD COLUMN "excludedCollectionIds"     TEXT[]    NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "restoreRewardOnFullRefund" BOOLEAN   NOT NULL DEFAULT true,
  ADD COLUMN "returnPointsOnCodeExpiry"  BOOLEAN   NOT NULL DEFAULT false;

ALTER TABLE "LoyaltyConfig"
  ADD CONSTRAINT "LoyaltyConfig_spendAmountPaise_positive" CHECK ("spendAmountPaise" > 0),
  ADD CONSTRAINT "LoyaltyConfig_earnBasis_valid" CHECK ("earnBasis" IN ('after_discount', 'before_discount'));
