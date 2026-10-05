-- T1.2: Hand-written SQL migration — Phase 1 database integrity
-- =============================================================================
-- This migration adds:
--   1. Partial unique index: one "earn" entry per order per account
--   2. Unique dedupeKey per shop (on LedgerEntry)
--   3. Unique idempotency key per account for Redemption
--   4. Trigger: LedgerEntry is append-only except for status column
--   5. Trigger: AuditLog is insert-only (no updates, no deletes)
--   6. CHECK constraints: debt, pending, and PointLot.remaining >= 0
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Partial unique index: one "earn" LedgerEntry per (accountId, shopifyOrderId)
--    using the dedupeKey format "earn:{shopifyOrderId}".
--    A partial index (WHERE type = 'earn') prevents more than one earn entry
--    for the same order while allowing other entry types freely.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "LedgerEntry_earn_dedup_idx"
  ON "LedgerEntry" ("accountId", "dedupeKey")
  WHERE "type" = 'earn';

-- ---------------------------------------------------------------------------
-- 2. Unique dedupeKey per shop across all LedgerEntry rows (any type).
--    Prevents the same external event (refund id, cancellation id) from being
--    applied twice on the same shop, even if it affects different accounts.
--    Partial: only non-null dedupeKeys (adjustments without a key are exempt).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "LedgerEntry_shop_dedupe_idx"
  ON "LedgerEntry" ("dedupeKey")
  WHERE "dedupeKey" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Unique idempotency key per account for Redemption (already declared in
--    the Prisma schema via @@unique; this comment documents the intent).
--    Prisma generates: UNIQUE("accountId", "idempotencyKey")
-- ---------------------------------------------------------------------------
-- (no additional SQL needed — handled by Prisma in migration 1)

-- ---------------------------------------------------------------------------
-- 4. LedgerEntry immutability trigger.
--    Allows: INSERT, and UPDATE that ONLY changes the status column.
--    Rejects: DELETE, and UPDATE that changes any other column.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_entry_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  -- Block deletes
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'LedgerEntry rows are immutable — DELETE is not allowed (id: %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Block updates that change anything other than status
  IF TG_OP = 'UPDATE' THEN
    IF OLD.id            <> NEW.id
    OR OLD."accountId"   <> NEW."accountId"
    OR OLD.type          <> NEW.type
    OR OLD.points        <> NEW.points
    OR OLD."dedupeKey"   IS DISTINCT FROM NEW."dedupeKey"
    OR OLD.note          IS DISTINCT FROM NEW.note
    OR OLD."lotId"       IS DISTINCT FROM NEW."lotId"
    OR OLD."orderId"     IS DISTINCT FROM NEW."orderId"
    OR OLD."refundId"    IS DISTINCT FROM NEW."refundId"
    OR OLD."redemptionId" IS DISTINCT FROM NEW."redemptionId"
    OR OLD."rewardId"    IS DISTINCT FROM NEW."rewardId"
    OR OLD."createdAt"   <> NEW."createdAt"
    THEN
      RAISE EXCEPTION
        'LedgerEntry rows are immutable — only status may be updated (id: %)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entry_immutable_trigger
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_immutable();

-- ---------------------------------------------------------------------------
-- 5. AuditLog insert-only trigger.
--    Rejects UPDATE and DELETE on AuditLog rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'AuditLog rows are immutable — % is not allowed (id: %)', TG_OP, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_log_immutable_trigger
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_insert_only();

-- ---------------------------------------------------------------------------
-- 6. CHECK constraints: debt, pending, and PointLot.remaining must be >= 0.
--    LoyaltyAccount.available has no such check — it is legitimately negative
--    when points are owed (an unpaid debt).
-- ---------------------------------------------------------------------------
ALTER TABLE "LoyaltyAccount"
  ADD CONSTRAINT "LoyaltyAccount_debt_non_negative"    CHECK ("debt"    >= 0),
  ADD CONSTRAINT "LoyaltyAccount_pending_non_negative" CHECK ("pending" >= 0);

ALTER TABLE "PointLot"
  ADD CONSTRAINT "PointLot_remaining_non_negative" CHECK ("remaining" >= 0);
