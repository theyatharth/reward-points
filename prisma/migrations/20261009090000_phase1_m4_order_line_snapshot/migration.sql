-- Migration 4: per-line earn snapshot and refund line quantities (D1 to D3).
-- Additive only: two nullable JSONB columns, no backfill (orders earned before this
-- migration have lines = NULL and rebuild it from the stored orders/paid event on
-- their first refund, or fail visibly).
ALTER TABLE "LoyaltyOrder"  ADD COLUMN "lines" JSONB;
ALTER TABLE "LoyaltyRefund" ADD COLUMN "lines" JSONB;
