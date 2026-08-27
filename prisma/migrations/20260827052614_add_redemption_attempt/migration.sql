-- Adds Postgres-backed redemption rate limiting, replacing an in-memory Map
-- that was per-process and unbounded. Purely additive — a new table, so this
-- cannot conflict with any existing data.

-- CreateTable
CREATE TABLE "RedemptionAttempt" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerGid" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "count" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RedemptionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RedemptionAttempt_shop_customerGid_key" ON "RedemptionAttempt"("shop", "customerGid");
