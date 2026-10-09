-- Migration 8: dirty tracking for the storefront metafield sync. Additive: new columns with
-- defaults, one partial index, three triggers. Nothing existing is changed or dropped.
--
-- LoyaltyAccount: "metafieldSeq" is bumped by a trigger whenever available / pending / debt change or
-- one of the account's Rewards is created or changes status, expiry or code. The worker syncs accounts
-- with "metafieldSeq" > "metafieldSyncedSeq" and stamps "metafieldSyncedSeq" with the value it read
-- BEFORE syncing, so a change that lands during the sync is not lost.
-- LoyaltyConfig: "ruleSeq" is bumped when the redeem rule changes; same idea for the shop-level rule metafield.

ALTER TABLE "LoyaltyAccount"
  ADD COLUMN "metafieldSeq"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "metafieldSyncedSeq" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "metafieldSyncedAt"  TIMESTAMP(3);

ALTER TABLE "LoyaltyConfig"
  ADD COLUMN "ruleSeq"       INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "ruleSyncedSeq" INTEGER NOT NULL DEFAULT 0;

-- Accounts that exist today have never been synced by this mechanism: make them dirty once.
UPDATE "LoyaltyAccount" SET "metafieldSeq" = 1;

CREATE INDEX "LoyaltyAccount_metafield_dirty_idx"
  ON "LoyaltyAccount" ("shop") WHERE "metafieldSeq" > "metafieldSyncedSeq";

CREATE OR REPLACE FUNCTION loyalty_account_mark_dirty()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."available" IS DISTINCT FROM OLD."available"
     OR NEW."pending" IS DISTINCT FROM OLD."pending"
     OR NEW."debt"    IS DISTINCT FROM OLD."debt" THEN
    NEW."metafieldSeq" := GREATEST(NEW."metafieldSeq", OLD."metafieldSeq" + 1);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER loyalty_account_mark_dirty_trigger
  BEFORE UPDATE ON "LoyaltyAccount"
  FOR EACH ROW EXECUTE FUNCTION loyalty_account_mark_dirty();

CREATE OR REPLACE FUNCTION loyalty_reward_mark_dirty()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW."status"       IS DISTINCT FROM OLD."status"
     OR NEW."expiresAt"    IS DISTINCT FROM OLD."expiresAt"
     OR NEW."discountCode" IS DISTINCT FROM OLD."discountCode" THEN
    UPDATE "LoyaltyAccount" SET "metafieldSeq" = "metafieldSeq" + 1 WHERE "id" = NEW."accountId";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER loyalty_reward_mark_dirty_trigger
  AFTER INSERT OR UPDATE ON "Reward"
  FOR EACH ROW EXECUTE FUNCTION loyalty_reward_mark_dirty();

CREATE OR REPLACE FUNCTION loyalty_config_mark_rule_dirty()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."pointsPerReward" IS DISTINCT FROM OLD."pointsPerReward"
     OR NEW."rewardValue"    IS DISTINCT FROM OLD."rewardValue"
     OR NEW."holdPeriodDays" IS DISTINCT FROM OLD."holdPeriodDays"
     OR NEW."currency"       IS DISTINCT FROM OLD."currency" THEN
    NEW."ruleSeq" := GREATEST(NEW."ruleSeq", OLD."ruleSeq" + 1);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER loyalty_config_mark_rule_dirty_trigger
  BEFORE UPDATE ON "LoyaltyConfig"
  FOR EACH ROW EXECUTE FUNCTION loyalty_config_mark_rule_dirty();
