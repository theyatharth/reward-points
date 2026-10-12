-- Migration 9: failed-login counters for the admin console. Additive: one new table.
CREATE TABLE "AdminLoginAttempt" (
    "id"          TEXT         NOT NULL,
    "key"         TEXT         NOT NULL,
    "count"       INTEGER      NOT NULL DEFAULT 1,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdminLoginAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminLoginAttempt_key_key" ON "AdminLoginAttempt"("key");
