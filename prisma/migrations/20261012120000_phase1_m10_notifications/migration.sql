-- Migration 10: on-site notifications (points earned, points activated, reward redeemed). Additive: one new table.
CREATE TABLE "Notification" (
    "id"        TEXT         NOT NULL,
    "accountId" TEXT         NOT NULL,
    "shop"      TEXT         NOT NULL,
    "type"      TEXT         NOT NULL,
    "data"      JSONB        NOT NULL,
    "dedupeKey" TEXT         NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt"    TIMESTAMP(3),
    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");
CREATE INDEX "Notification_accountId_createdAt_idx" ON "Notification"("accountId", "createdAt");
CREATE INDEX "Notification_shop_createdAt_idx" ON "Notification"("shop", "createdAt");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LoyaltyAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
