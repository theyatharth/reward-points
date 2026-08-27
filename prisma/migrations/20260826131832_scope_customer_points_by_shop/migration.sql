-- Fixes cross-tenant IDOR: shopifyCustomerId was globally unique, so a
-- customer ID that happens to match across two different shops let one
-- shop's redeem/adjust calls read or mutate another shop's balance.
-- The old global-unique constraint is strictly stronger than the new
-- composite one, so this cannot conflict with any existing data.

-- DropIndex
DROP INDEX "CustomerPoint_shopifyCustomerId_key";

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPoint_shop_shopifyCustomerId_key" ON "CustomerPoint"("shop", "shopifyCustomerId");
