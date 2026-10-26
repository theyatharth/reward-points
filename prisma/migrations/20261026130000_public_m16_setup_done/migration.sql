-- Migration 16 (public app): "Get started" is shown first to a new shop until the merchant marks it done (or the shop has an order).
-- Additive: one nullable column on ShopInstall (not on LoyaltyConfig: changing a config row would make an open Rules form look stale).
ALTER TABLE "ShopInstall" ADD COLUMN "setupDoneAt" TIMESTAMP(3);
