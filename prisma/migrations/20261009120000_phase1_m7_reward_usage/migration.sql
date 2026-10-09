-- Migration 7: reward usage and Shopify clean-up. Additive only.
--   usedOrderId        the Shopify order that used the code (to restore it on cancel / full refund)
--   needsShopifyDelete a code voided by D4 must be deleted in Shopify after commit; the worker does it
--   shopifyDeletedAt   when that was done
-- Plus an index to find a reward by its code (orders/paid carries the code).
ALTER TABLE "Reward"
  ADD COLUMN "usedOrderId"        TEXT,
  ADD COLUMN "needsShopifyDelete" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "shopifyDeletedAt"   TIMESTAMP(3);
CREATE INDEX "Reward_shop_discountCode_idx" ON "Reward"("shop", "discountCode");
