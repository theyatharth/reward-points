-- CreateTable
CREATE TABLE "CustomerPoint" (
    "id" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointTransaction" (
    "id" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Approved',
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedOrder" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "spendAmount" INTEGER NOT NULL DEFAULT 100,
    "earnPoints" INTEGER NOT NULL DEFAULT 1,
    "redeemPoints" INTEGER NOT NULL DEFAULT 100,
    "discountValue" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPoint_shopifyCustomerId_key" ON "CustomerPoint"("shopifyCustomerId");

-- CreateIndex
CREATE INDEX "CustomerPoint_shop_idx" ON "CustomerPoint"("shop");

-- CreateIndex
CREATE INDEX "PointTransaction_shopifyCustomerId_idx" ON "PointTransaction"("shopifyCustomerId");

-- CreateIndex
CREATE INDEX "PointTransaction_shop_idx" ON "PointTransaction"("shop");

-- CreateIndex
CREATE INDEX "ProcessedOrder_shop_idx" ON "ProcessedOrder"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedOrder_orderId_shop_key" ON "ProcessedOrder"("orderId", "shop");

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");
