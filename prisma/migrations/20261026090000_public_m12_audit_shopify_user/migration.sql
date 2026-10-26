-- Migration 12 (public app): the audit log can name the Shopify staff member behind an action.
-- Additive: one nullable column. In the embedded console there is no AdminUser; the id comes from the verified session token (sub).
-- The insert-only trigger is untouched (it fires on UPDATE and DELETE of rows, not on this DDL).
ALTER TABLE "AuditLog" ADD COLUMN "shopifyUserId" TEXT;
