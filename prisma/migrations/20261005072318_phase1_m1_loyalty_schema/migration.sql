-- CreateTable
CREATE TABLE "LoyaltyConfig" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "earnMode" TEXT NOT NULL DEFAULT 'per_currency_unit',
    "pointsPerUnit" INTEGER NOT NULL DEFAULT 1,
    "taxHandling" TEXT NOT NULL DEFAULT 'exclusive',
    "shippingEarning" BOOLEAN NOT NULL DEFAULT false,
    "pointsRounding" TEXT NOT NULL DEFAULT 'floor',
    "pointsPerReward" INTEGER NOT NULL DEFAULT 100,
    "rewardValue" INTEGER NOT NULL DEFAULT 1000,
    "rewardExpiryDays" INTEGER NOT NULL DEFAULT 90,
    "holdPeriodDays" INTEGER NOT NULL DEFAULT 30,
    "shortfallPolicy" TEXT NOT NULL DEFAULT 'owe_only',
    "campaignEnabled" BOOLEAN NOT NULL DEFAULT false,
    "expiryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ledgerStartAt" TIMESTAMP(3),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyAccount" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "available" INTEGER NOT NULL DEFAULT 0,
    "pending" INTEGER NOT NULL DEFAULT 0,
    "debt" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "dedupeKey" TEXT,
    "note" TEXT,
    "lotId" TEXT,
    "orderId" TEXT,
    "refundId" TEXT,
    "redemptionId" TEXT,
    "rewardId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointLot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "originalPoints" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "shopifyOrderId" TEXT NOT NULL,
    "activatesAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PointLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyOrder" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "pointsEarned" INTEGER NOT NULL,
    "eligibleAmountPaise" INTEGER NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "lotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyRefund" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "shopifyRefundId" TEXT,
    "shopifyOrderId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "pointsReversed" INTEGER NOT NULL,
    "refundAmountPaise" INTEGER NOT NULL,
    "isFullCancellation" BOOLEAN NOT NULL DEFAULT false,
    "loyaltyOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Redemption" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "pointsUsed" INTEGER NOT NULL,
    "rewardValuePaise" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "discountCode" TEXT,
    "discountCodeId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Redemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reward" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "discountCode" TEXT NOT NULL,
    "discountCodeId" TEXT NOT NULL,
    "valueInPaise" INTEGER NOT NULL,
    "pointsUsed" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyWebhookId" TEXT,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "lastError" TEXT,
    "ledgerEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "adminId" TEXT,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "shop" TEXT,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "result" JSONB,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyConfig_shop_key" ON "LoyaltyConfig"("shop");

-- CreateIndex
CREATE INDEX "LoyaltyAccount_shop_idx" ON "LoyaltyAccount"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyAccount_shop_shopifyCustomerId_key" ON "LoyaltyAccount"("shop", "shopifyCustomerId");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_idx" ON "LedgerEntry"("accountId");

-- CreateIndex
CREATE INDEX "LedgerEntry_dedupeKey_idx" ON "LedgerEntry"("dedupeKey");

-- CreateIndex
CREATE INDEX "PointLot_accountId_status_idx" ON "PointLot"("accountId", "status");

-- CreateIndex
CREATE INDEX "PointLot_activatesAt_idx" ON "PointLot"("activatesAt");

-- CreateIndex
CREATE INDEX "LoyaltyOrder_accountId_idx" ON "LoyaltyOrder"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyOrder_shop_shopifyOrderId_key" ON "LoyaltyOrder"("shop", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "LoyaltyRefund_accountId_idx" ON "LoyaltyRefund"("accountId");

-- CreateIndex
CREATE INDEX "LoyaltyRefund_shopifyOrderId_idx" ON "LoyaltyRefund"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "Redemption_shop_idx" ON "Redemption"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Redemption_accountId_idempotencyKey_key" ON "Redemption"("accountId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Reward_accountId_idx" ON "Reward"("accountId");

-- CreateIndex
CREATE INDEX "Reward_shop_status_idx" ON "Reward"("shop", "status");

-- CreateIndex
CREATE INDEX "WebhookEvent_shop_status_idx" ON "WebhookEvent"("shop", "status");

-- CreateIndex
CREATE INDEX "WebhookEvent_shopifyWebhookId_idx" ON "WebhookEvent"("shopifyWebhookId");

-- CreateIndex
CREATE INDEX "WebhookEvent_nextRetryAt_idx" ON "WebhookEvent"("nextRetryAt");

-- CreateIndex
CREATE INDEX "AuditLog_shop_idx" ON "AuditLog"("shop");

-- CreateIndex
CREATE INDEX "AuditLog_adminId_idx" ON "AuditLog"("adminId");

-- CreateIndex
CREATE INDEX "AdminUser_shop_idx" ON "AdminUser"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_shop_email_key" ON "AdminUser"("shop", "email");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_token_key" ON "AdminSession"("token");

-- CreateIndex
CREATE INDEX "AdminSession_userId_idx" ON "AdminSession"("userId");

-- CreateIndex
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");

-- CreateIndex
CREATE INDEX "JobRun_jobType_status_idx" ON "JobRun"("jobType", "status");

-- CreateIndex
CREATE INDEX "JobRun_startedAt_idx" ON "JobRun"("startedAt");

-- AddForeignKey
ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_shop_fkey" FOREIGN KEY ("shop") REFERENCES "LoyaltyConfig"("shop") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LoyaltyAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "PointLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointLot" ADD CONSTRAINT "PointLot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LoyaltyAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOrder" ADD CONSTRAINT "LoyaltyOrder_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LoyaltyAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOrder" ADD CONSTRAINT "LoyaltyOrder_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "PointLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyRefund" ADD CONSTRAINT "LoyaltyRefund_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LoyaltyAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyRefund" ADD CONSTRAINT "LoyaltyRefund_loyaltyOrderId_fkey" FOREIGN KEY ("loyaltyOrderId") REFERENCES "LoyaltyOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LoyaltyAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LoyaltyAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
