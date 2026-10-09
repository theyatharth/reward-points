-- Migration 6: remember when a processed event's payload was purged (the 90-day purge
-- keeps every metadata column and replaces only `payload`). Additive: one nullable column.
ALTER TABLE "WebhookEvent" ADD COLUMN "payloadPurgedAt" TIMESTAMP(3);
