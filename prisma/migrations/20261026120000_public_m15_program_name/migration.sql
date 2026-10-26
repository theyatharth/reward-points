-- Migration 15 (public app): the program's name, editable by the merchant on the Rules page ("Reward Points" until they change it).
-- Additive: one column with a default, a length check, and the rule-dirty trigger now also notices a name change (the name is part
-- of the rule metafield the theme blocks read, so a rename must be pushed to Shopify like any other rule change).
ALTER TABLE "LoyaltyConfig" ADD COLUMN "programName" TEXT NOT NULL DEFAULT 'Reward Points';
ALTER TABLE "LoyaltyConfig"
  ADD CONSTRAINT "LoyaltyConfig_programName_length" CHECK (char_length("programName") BETWEEN 1 AND 40);

CREATE OR REPLACE FUNCTION loyalty_config_mark_rule_dirty()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."pointsPerReward" IS DISTINCT FROM OLD."pointsPerReward"
     OR NEW."rewardValue"    IS DISTINCT FROM OLD."rewardValue"
     OR NEW."holdPeriodDays" IS DISTINCT FROM OLD."holdPeriodDays"
     OR NEW."currency"       IS DISTINCT FROM OLD."currency"
     OR NEW."programName"    IS DISTINCT FROM OLD."programName" THEN
    NEW."ruleSeq" := GREATEST(NEW."ruleSeq", OLD."ruleSeq" + 1);
  END IF;
  RETURN NEW;
END;
$$;
