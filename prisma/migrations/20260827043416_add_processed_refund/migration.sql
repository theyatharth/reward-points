-- Adds idempotency tracking for REFUNDS_CREATE webhook deliveries, mirroring
-- ProcessedOrder. Purely additive — a new table, so this cannot conflict
-- with any existing data.

-- CreateTable
CREATE TABLE "ProcessedRefund" (
    "id" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedRefund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProcessedRefund_shop_idx" ON "ProcessedRefund"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedRefund_refundId_shop_key" ON "ProcessedRefund"("refundId", "shop");
