-- CreateTable
CREATE TABLE "PendingPoint" (
    "id" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "eligibleAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingPoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingPoint_shop_shopifyCustomerId_idx" ON "PendingPoint"("shop", "shopifyCustomerId");

-- CreateIndex
CREATE INDEX "PendingPoint_eligibleAt_idx" ON "PendingPoint"("eligibleAt");

-- CreateIndex
CREATE UNIQUE INDEX "PendingPoint_orderId_shop_key" ON "PendingPoint"("orderId", "shop");
