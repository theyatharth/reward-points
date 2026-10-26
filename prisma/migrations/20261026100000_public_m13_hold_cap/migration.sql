-- Migration 13 (public app): the holding period is at most 55 days (see MAX_HOLD_DAYS in web/loyalty/rules/config.js: Shopify gives
-- read_orders the last 60 days of orders, and the unlock check reads the order from Shopify when the hold ends).
-- NOT VALID: a row saved earlier with a longer hold is not rejected by this migration; every new or changed row must satisfy it.
ALTER TABLE "LoyaltyConfig"
  ADD CONSTRAINT "LoyaltyConfig_holdPeriodDays_range" CHECK ("holdPeriodDays" >= 0 AND "holdPeriodDays" <= 55) NOT VALID;
