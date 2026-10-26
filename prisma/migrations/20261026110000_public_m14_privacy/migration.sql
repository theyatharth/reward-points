-- Migration 14 (public app): privacy webhooks.
--
--  * LoyaltyAccount."redactedAt": set when customers/redact replaced the account's customer id with a random token.
--  * "DataRequest": a customers/data_request received from Shopify (what was asked, for which customer, when it was sent on).
--  * "ShopInstall": per shop, whether the app is installed (used by the uninstall handling).
--  * redact_customer() and redact_shop(): the ONLY way to change or delete ledger and audit rows. Both refuse to run unless the
--    caller's own transaction first set rewardpoints.redact_allowed = 'on' (set_config(..., true) = local to that transaction), and
--    while they run they set rewardpoints.redacting = 'on', which is what the two immutability triggers below look for.
--    Everywhere else the triggers behave exactly as before: LedgerEntry changes status only, AuditLog is insert-only.
--    While redacting: LedgerEntry may be deleted and its note changed (nothing else); AuditLog may be deleted, and its detail
--    changed (nothing else).

ALTER TABLE "LoyaltyAccount" ADD COLUMN "redactedAt" TIMESTAMP(3);

CREATE TABLE "DataRequest" (
    "id"                TEXT         NOT NULL,
    "shop"              TEXT         NOT NULL,
    "shopifyRequestId"  TEXT         NOT NULL,
    "shopifyCustomerId" TEXT         NOT NULL,
    "accountId"         TEXT,
    "ordersRequested"   JSONB        NOT NULL DEFAULT '[]',
    "status"            TEXT         NOT NULL DEFAULT 'open',
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"       TIMESTAMP(3),
    CONSTRAINT "DataRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DataRequest_shop_shopifyRequestId_key" ON "DataRequest"("shop", "shopifyRequestId");
CREATE INDEX "DataRequest_shop_status_idx" ON "DataRequest"("shop", "status");

CREATE TABLE "ShopInstall" (
    "shop"          TEXT         NOT NULL,
    "status"        TEXT         NOT NULL DEFAULT 'active',
    "installedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "scopes"        TEXT,
    "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShopInstall_pkey" PRIMARY KEY ("shop")
);

-- ---------------------------------------------------------------------------
-- The two triggers, with the redaction exception.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_entry_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  redacting boolean := coalesce(current_setting('rewardpoints.redacting', true), '') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF redacting THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION
      'LedgerEntry rows are immutable — DELETE is not allowed (id: %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.id            <> NEW.id
    OR OLD."accountId"   <> NEW."accountId"
    OR OLD.type          <> NEW.type
    OR OLD.points        <> NEW.points
    OR OLD."dedupeKey"   IS DISTINCT FROM NEW."dedupeKey"
    OR (OLD.note         IS DISTINCT FROM NEW.note AND NOT redacting)
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

CREATE OR REPLACE FUNCTION audit_log_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('rewardpoints.redacting', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE'
       AND OLD.id = NEW.id
       AND OLD.shop = NEW.shop
       AND OLD."adminId" IS NOT DISTINCT FROM NEW."adminId"
       AND OLD."shopifyUserId" IS NOT DISTINCT FROM NEW."shopifyUserId"
       AND OLD.action = NEW.action
       AND OLD.ip IS NOT DISTINCT FROM NEW.ip
       AND OLD."createdAt" = NEW."createdAt" THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION
    'AuditLog rows are immutable — % is not allowed (id: %)', TG_OP, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- ---------------------------------------------------------------------------
-- customers/redact
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION redact_customer(p_shop text, p_customer_id text, p_orders text[], p_token text)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_now      timestamp(3) := (now() AT TIME ZONE 'UTC');
  v_account  text;
  v_orders   text[];
  v_notes    int := 0;
  v_audit    int := 0;
  v_events   int := 0;
  v_attempts int := 0;
  v_legacy   int := 0;
  v_requests int := 0;
  n          int;
BEGIN
  IF coalesce(current_setting('rewardpoints.redact_allowed', true), '') <> 'on' THEN
    RAISE EXCEPTION 'redact_customer may only run inside a redaction transaction (rewardpoints.redact_allowed is not set)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_shop IS NULL OR p_shop = '' OR p_customer_id IS NULL OR p_customer_id = '' OR p_token IS NULL OR p_token = '' THEN
    RAISE EXCEPTION 'redact_customer needs a shop, a customer id and a token';
  END IF;
  PERFORM set_config('rewardpoints.redacting', 'on', true);

  SELECT id INTO v_account FROM "LoyaltyAccount" WHERE shop = p_shop AND "shopifyCustomerId" = p_customer_id;

  -- The customer's orders: the ones Shopify listed and the ones the ledger holds for the account.
  SELECT coalesce(array_agg(DISTINCT x), '{}') INTO v_orders FROM (
    SELECT unnest(coalesce(p_orders, '{}'::text[])) AS x
    UNION
    SELECT "shopifyOrderId" FROM "LoyaltyOrder" WHERE v_account IS NOT NULL AND "accountId" = v_account
  ) q;

  IF v_account IS NOT NULL THEN
    UPDATE "LedgerEntry" SET note = NULL WHERE "accountId" = v_account AND note IS NOT NULL;
    GET DIAGNOSTICS v_notes = ROW_COUNT;
  END IF;

  -- Audit rows about this customer lose the customer id and the admin's free-text note; everything else stays.
  UPDATE "AuditLog"
     SET detail = (detail - 'shopifyCustomerId' - 'note') || '{"customerRedacted": true}'::jsonb
   WHERE shop = p_shop AND detail IS NOT NULL AND jsonb_typeof(detail) = 'object'
     AND (detail->>'shopifyCustomerId' = p_customer_id OR (v_account IS NOT NULL AND detail->>'accountId' = v_account));
  GET DIAGNOSTICS v_audit = ROW_COUNT;

  -- Stored webhook payloads of this customer's orders, cancellations and refunds are blanked the way the 90-day purge does
  -- it; one still waiting to be processed is skipped instead (it would earn on an order whose customer asked to be forgotten).
  UPDATE "WebhookEvent"
     SET payload = '{"_purged": true, "_redacted": true}'::jsonb,
         "payloadPurgedAt" = v_now,
         status = CASE WHEN status IN ('pending', 'failed', 'processing') THEN 'skipped' ELSE status END,
         "lastError" = CASE WHEN status IN ('pending', 'failed', 'processing') THEN 'Customer data redacted' ELSE "lastError" END,
         "nextRetryAt" = CASE WHEN status IN ('pending', 'failed', 'processing') THEN NULL ELSE "nextRetryAt" END,
         "updatedAt" = v_now
   WHERE shop = p_shop
     AND (
          (topic IN ('orders/paid', 'orders/cancelled', 'ORDERS_PAID', 'ORDERS_CANCELLED')
             AND (payload->'customer'->>'id' = p_customer_id OR payload->>'id' = ANY (v_orders)))
       OR (topic IN ('refunds/create', 'REFUNDS_CREATE') AND payload->>'order_id' = ANY (v_orders))
     );
  GET DIAGNOSTICS v_events = ROW_COUNT;

  DELETE FROM "RedemptionAttempt" WHERE shop = p_shop AND "customerGid" = 'gid://shopify/Customer/' || p_customer_id;
  GET DIAGNOSTICS v_attempts = ROW_COUNT;

  UPDATE "CustomerPoint" SET "shopifyCustomerId" = p_token WHERE shop = p_shop AND "shopifyCustomerId" = p_customer_id;
  GET DIAGNOSTICS n = ROW_COUNT; v_legacy := v_legacy + n;
  UPDATE "PendingPoint" SET "shopifyCustomerId" = p_token WHERE shop = p_shop AND "shopifyCustomerId" = p_customer_id;
  GET DIAGNOSTICS n = ROW_COUNT; v_legacy := v_legacy + n;
  UPDATE "PointTransaction" SET "shopifyCustomerId" = p_token WHERE shop = p_shop AND "shopifyCustomerId" = p_customer_id;
  GET DIAGNOSTICS n = ROW_COUNT; v_legacy := v_legacy + n;

  UPDATE "DataRequest" SET "shopifyCustomerId" = p_token WHERE shop = p_shop AND "shopifyCustomerId" = p_customer_id;
  GET DIAGNOSTICS v_requests = ROW_COUNT;

  IF v_account IS NOT NULL THEN
    UPDATE "LoyaltyAccount"
       SET "shopifyCustomerId" = p_token, "redactedAt" = v_now, "metafieldSyncedSeq" = "metafieldSeq", "updatedAt" = v_now
     WHERE id = v_account;
  END IF;

  PERFORM set_config('rewardpoints.redacting', 'off', true);
  RETURN jsonb_build_object(
    'accountId', v_account, 'matched', v_account IS NOT NULL, 'ledgerNotesCleared', v_notes, 'auditRowsScrubbed', v_audit,
    'webhookPayloadsBlanked', v_events, 'redemptionAttemptsDeleted', v_attempts, 'legacyRowsRenamed', v_legacy, 'dataRequestsRenamed', v_requests);
END;
$$;

-- ---------------------------------------------------------------------------
-- shop/redact: every row of the shop. Ledger and audit rows go too (the triggers allow it only while redacting).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION redact_shop(p_shop text)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_deleted jsonb := '{}'::jsonb;
  n int;
BEGIN
  IF coalesce(current_setting('rewardpoints.redact_allowed', true), '') <> 'on' THEN
    RAISE EXCEPTION 'redact_shop may only run inside a redaction transaction (rewardpoints.redact_allowed is not set)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_shop IS NULL OR p_shop = '' THEN
    RAISE EXCEPTION 'redact_shop needs a shop';
  END IF;
  PERFORM set_config('rewardpoints.redacting', 'on', true);

  -- Children of the accounts first (foreign keys), then the accounts, then the config.
  DELETE FROM "LedgerEntry" WHERE "accountId" IN (SELECT id FROM "LoyaltyAccount" WHERE shop = p_shop);
  GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('LedgerEntry', n);
  DELETE FROM "LoyaltyRefund" WHERE shop = p_shop;
  GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('LoyaltyRefund', n);
  DELETE FROM "LoyaltyOrder" WHERE shop = p_shop;
  GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('LoyaltyOrder', n);
  DELETE FROM "PointLot" WHERE "accountId" IN (SELECT id FROM "LoyaltyAccount" WHERE shop = p_shop);
  GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('PointLot', n);
  DELETE FROM "Redemption" WHERE shop = p_shop;
  GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('Redemption', n);
  DELETE FROM "Reward" WHERE shop = p_shop;
  GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('Reward', n);
  DELETE FROM "Notification" WHERE shop = p_shop;
  GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('Notification', n);
  DELETE FROM "LoyaltyAccount" WHERE shop = p_shop;
  GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('LoyaltyAccount', n);
  DELETE FROM "LoyaltyConfig" WHERE shop = p_shop;
  GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('LoyaltyConfig', n);

  DELETE FROM "WebhookEvent" WHERE shop = p_shop;
  GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('WebhookEvent', n);
  DELETE FROM "AuditLog" WHERE shop = p_shop;
  GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('AuditLog', n);
  DELETE FROM "DataRequest" WHERE shop = p_shop;
  GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('DataRequest', n);
  DELETE FROM "JobRun" WHERE shop = p_shop;
  GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('JobRun', n);

  DELETE FROM "AdminUser" WHERE shop = p_shop;   -- AdminSession goes with it (ON DELETE CASCADE)
  GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('AdminUser', n);
  DELETE FROM "AdminLoginAttempt" WHERE "key" LIKE 'acct:' || p_shop || ':%';
  DELETE FROM "Session" WHERE shop = p_shop;
  GET DIAGNOSTICS n = ROW_COUNT; v_deleted := v_deleted || jsonb_build_object('Session', n);
  DELETE FROM "ShopSettings" WHERE shop = p_shop;
  DELETE FROM "ShopInstall" WHERE shop = p_shop;
  DELETE FROM "RedemptionAttempt" WHERE shop = p_shop;
  DELETE FROM "ProcessedOrder" WHERE shop = p_shop;
  DELETE FROM "ProcessedRefund" WHERE shop = p_shop;
  DELETE FROM "CustomerPoint" WHERE shop = p_shop;
  DELETE FROM "PendingPoint" WHERE shop = p_shop;
  DELETE FROM "PointTransaction" WHERE shop = p_shop;

  PERFORM set_config('rewardpoints.redacting', 'off', true);
  RETURN v_deleted;
END;
$$;
