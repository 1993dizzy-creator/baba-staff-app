-- BABA 2026-08 — PRIVATE/ISOLATED PostgreSQL maintenance proposal.
-- ! DO NOT RUN ON PRODUCTION ! Not a migration. Not installed or SQL-runtime tested.
-- Operators must complete real PostgreSQL fixture tests and gain separate DB approval.
-- This has no PUBLIC/anon/authenticated/service_role EXECUTE grants. SQL Editor only.
-- It preserves original ledger_transactions / ledger_movements / payables / POS.
-- Materializes only zero-P&L correction entries and actual transfers.
-- A SQL error aborts the entire statement/transaction, not a partial batch.

CREATE SCHEMA IF NOT EXISTS baba_august_rebuild_private;
REVOKE ALL ON SCHEMA baba_august_rebuild_private FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS baba_august_rebuild_private.runs (
  run_id uuid PRIMARY KEY,
  manifest_digest text NOT NULL,
  sheet_cell_digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('applying', 'applied', 'reversed')),
  actor_user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  manifest jsonb NOT NULL,
  before_balance jsonb NOT NULL,
  after_balance jsonb,
  payable_fingerprint text NOT NULL,
  closure_history_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  reversed_at timestamptz
);
CREATE TABLE IF NOT EXISTS baba_august_rebuild_private.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES baba_august_rebuild_private.runs(run_id) ON DELETE RESTRICT,
  event_key text NOT NULL UNIQUE,
  event_data jsonb NOT NULL,
  created_transaction_id bigint NOT NULL UNIQUE REFERENCES public.ledger_transactions(id) ON DELETE RESTRICT,
  reversed_transaction_id bigint UNIQUE REFERENCES public.ledger_transactions(id) ON DELETE RESTRICT
);
REVOKE ALL ON ALL TABLES IN SCHEMA baba_august_rebuild_private FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION baba_august_rebuild_private.balances_at(p_end_exclusive date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $balance$
  SELECT COALESCE(jsonb_object_agg(f.code, trim_scale(COALESCE((
    SELECT SUM(m.amount) FROM public.ledger_movements m
    JOIN public.ledger_transactions t ON t.id=m.transaction_id
    WHERE m.fund_account_id=f.id AND t.status='confirmed' AND t.business_date < p_end_exclusive
  ),0))::text), '{}'::jsonb)
  FROM public.ledger_fund_accounts f WHERE f.id IN (1,2,3,5)
$balance$;

CREATE OR REPLACE FUNCTION baba_august_rebuild_private.payable_fingerprint()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fingerprint$
  WITH a AS (
    SELECT x.id,x.payable_id,x.payment_transaction_id,x.allocated_amount
    FROM public.ledger_payable_allocations x
    JOIN public.ledger_payables p ON p.id=x.payable_id
    JOIN public.ledger_transactions src ON src.id=p.expense_transaction_id
    JOIN public.ledger_transactions payment ON payment.id=x.payment_transaction_id
    WHERE src.business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
      AND src.status='confirmed' AND payment.status='confirmed'
      AND payment.business_date BETWEEN DATE '2026-09-01' AND DATE '2026-10-31'
  ) SELECT md5(COALESCE(string_agg(
    id::text||':'||payable_id::text||':'||payment_transaction_id::text||':'||allocated_amount::text,
    '|' ORDER BY id),'')) FROM a
$fingerprint$;

CREATE OR REPLACE FUNCTION baba_august_rebuild_private.history_fingerprint()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $history$
  SELECT md5(COALESCE(string_agg(
    id::text||':'||revision::text||':'||COALESCE(snapshot_hash,''),
    '|' ORDER BY month,id),''))
  FROM public.ledger_month_closure_history
  WHERE month IN (DATE '2026-08-01',DATE '2026-09-01') AND revision<=4
$history$;

-- Invariants of untouched source rows; no update/delete of these sources is allowed.
CREATE OR REPLACE FUNCTION baba_august_rebuild_private.pos_original_fingerprint()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $pos$
  SELECT md5(COALESCE(string_agg(
    id::text||':'||business_date::text||':'||status||':'||amount::text||':'||COALESCE(source_key,''),
    '|' ORDER BY id),'')) FROM public.ledger_transactions
  WHERE business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
    AND source_type='pos_sales_daily_payment'
$pos$;

CREATE OR REPLACE FUNCTION baba_august_rebuild_private.inventory_original_fingerprint()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $inventory$
  SELECT md5(COALESCE(string_agg(
    id::text||':'||COALESCE(business_date::text,'')||':'||COALESCE(item_id::text,'')||':'||
      COALESCE(change_quantity::text,'')||':'||COALESCE(new_purchase_price::text,''),
    '|' ORDER BY id),'')) FROM public.inventory_logs
  WHERE business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
$inventory$;

CREATE OR REPLACE FUNCTION baba_august_rebuild_private.audit_prefix_fingerprint(p_max_id bigint)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $audit$
  SELECT md5(COALESCE(string_agg(
    id::text||':'||action||':'||COALESCE(entity_type,'')||':'||COALESCE(entity_id::text,'')||':'||
      COALESCE(after_snapshot::text,''), '|' ORDER BY id),''))
  FROM public.ledger_audit_logs WHERE id <= p_max_id
$audit$;

-- Intentional production compatibility checks:
-- 1. Source metadata non-null for any non-manual transaction.
-- 2. Each 'correction' is zero-P&L amount=0, category/recognition_month null.
-- 3. Exactly one movement per correction (index on transaction_id,fund_account_id).
-- 4. August 8 historical technical adjustments are replaced exactly once.
-- 5. 124 day/account, August/September/October balances, and future payables
--    are checked INSIDE the SQL transaction. No applied result before postflight.
CREATE OR REPLACE FUNCTION baba_august_rebuild_private.apply_v1(
  p_manifest jsonb, p_actor_user_id bigint, p_approved_sheet_digest text,
  p_approved_manifest_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET lock_timeout='5s' AS $apply$
DECLARE
  v_run uuid;
  v_existing baba_august_rebuild_private.runs%ROWTYPE;
  v_manifest_hash text;
  v_before jsonb;
  v_after jsonb;
  v_payables text;
  v_history text;
  v_event jsonb;
  v_movement jsonb;
  v_source_id bigint;
  v_source public.ledger_transactions%ROWTYPE;
  v_technical bigint;
  v_technical_movement public.ledger_movements%ROWTYPE;
  v_kind text;
  v_type text;
  v_key text;
  v_date date;
  v_at timestamptz;
  v_amount numeric;
  v_sum numeric;
  v_event_count int;
  v_effect_count int;
  v_new_tx bigint;
  v_orig_id bigint;
  v_record record;
  v_expected numeric;
  v_observed numeric;
  v_tech_ids bigint[];
  v_account bigint;
  v_account_code text;
  v_target jsonb;
  v_month text;
  v_scope_count int;
  v_group jsonb;
  v_prior jsonb;
  v_later jsonb;
  v_source_movement public.ledger_movements%ROWTYPE;
  v_group_count int;
  v_expected_payables text;
  v_expected_payable_count int;
  v_original_pos_fingerprint text;
  v_original_inventory_fingerprint text;
  v_audit_max_id bigint;
  v_audit_fingerprint text;
BEGIN
  IF session_user <> 'postgres' THEN RAISE EXCEPTION 'DBA_SESSION_REQUIRED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=p_actor_user_id AND lower(role::text) IN ('owner','master')
    AND is_active=true AND app_login_enabled=true) THEN RAISE EXCEPTION 'OWNER_REQUIRED'; END IF;
  IF p_manifest IS NULL OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object'
    OR p_manifest->>'month' IS DISTINCT FROM '2026-08'
    OR p_manifest->>'status' IS DISTINCT FROM 'READY_FOR_ISOLATED_DB_TEST_ONLY'
    OR (p_manifest->>'sourceRows')::int IS DISTINCT FROM 427
    OR (p_manifest->>'cellCount')::int IS DISTINCT FROM 505
    OR (p_manifest->>'cardTotal')::numeric IS DISTINCT FROM 225925720
    OR (p_manifest->>'moneyScale')::int IS DISTINCT FROM 3
    OR jsonb_typeof(p_manifest->'events') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_manifest->'expectedDaily') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_manifest->'expectedDaily') IS DISTINCT FROM 124
    OR jsonb_typeof(p_manifest->'requiredTechnicalMovementIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_manifest->'requiredProtectedFingerprints') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_manifest->'requiredProtectedFingerprints') IS DISTINCT FROM 5
    OR p_approved_sheet_digest IS NULL OR p_approved_sheet_digest !~ '^[0-9a-f]{64}$'
    OR p_manifest->>'sheetCellDigest' IS DISTINCT FROM p_approved_sheet_digest THEN
    RAISE EXCEPTION 'REBUILD_MANIFEST_CONTRACT_INVALID';
  END IF;
  v_run:=(p_manifest->>'runId')::uuid;
  IF v_run IS NULL THEN RAISE EXCEPTION 'RUN_ID_REQUIRED'; END IF;
  v_manifest_hash:=md5(p_manifest::text);
  -- Separate human approval of the COMPLETE execution manifest, not just sheet amounts.
  -- The owner must confirm this digest from a read-only PostgreSQL JSONB rendering.
  IF p_approved_manifest_hash IS NULL OR p_approved_manifest_hash !~ '^[0-9a-f]{32}$'
     OR v_manifest_hash IS DISTINCT FROM p_approved_manifest_hash THEN
    RAISE EXCEPTION 'APPROVED_EXECUTION_PLAN_CHANGED';
  END IF;
  IF jsonb_array_length(p_manifest->'events')=0 THEN RAISE EXCEPTION 'EMPTY_ACTIONS'; END IF;
  IF (SELECT count(DISTINCT e->>'key') FROM jsonb_array_elements(p_manifest->'events') e)
     <> jsonb_array_length(p_manifest->'events') THEN RAISE EXCEPTION 'EVENT_KEY_DUPLICATE'; END IF;

  -- Month serialization + conservative short-time ledger write locks.
  PERFORM pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));
  FOR v_month IN SELECT unnest(ARRAY['2026-08','2026-09','2026-10']) LOOP
    PERFORM pg_advisory_xact_lock(hashtext('ledger_month_close:'||v_month));
  END LOOP;
  FOR v_record IN SELECT month FROM public.ledger_month_closures
    WHERE month IN (DATE '2026-08-01',DATE '2026-09-01') ORDER BY month FOR UPDATE LOOP NULL; END LOOP;
  IF (SELECT count(*) FROM public.ledger_month_closures WHERE month IN (DATE '2026-08-01',DATE '2026-09-01')
      AND status='reopened' AND revision=4)<>2 OR
      EXISTS(SELECT 1 FROM public.ledger_month_closures WHERE month=DATE '2026-10-01' AND status='closed') THEN
    RAISE EXCEPTION 'MONTH_STATE_DRIFT';
  END IF;
  LOCK TABLE public.ledger_transactions IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.ledger_movements IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.ledger_payables IN SHARE MODE;
  LOCK TABLE public.ledger_payable_allocations IN SHARE MODE;
  LOCK TABLE public.ledger_candidates IN SHARE MODE;
  LOCK TABLE public.ledger_card_reconciliations IN SHARE MODE;
  LOCK TABLE public.ledger_card_reconciliation_lines IN SHARE MODE;
  LOCK TABLE public.inventory_logs IN SHARE MODE;
  LOCK TABLE public.ledger_audit_logs IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_existing FROM baba_august_rebuild_private.runs WHERE run_id=v_run FOR UPDATE;
  IF FOUND THEN
    IF v_existing.manifest_digest<>v_manifest_hash OR v_existing.sheet_cell_digest<>p_approved_sheet_digest
      THEN RAISE EXCEPTION 'RUN_IDEMPOTENCY_CONFLICT'; END IF;
    IF v_existing.status='applied' THEN
      RETURN jsonb_build_object('status','already_applied','runId',v_run);
    END IF;
    RAISE EXCEPTION 'RUN_ALREADY_REVERSED';
  END IF;
  IF EXISTS(SELECT 1 FROM baba_august_rebuild_private.runs WHERE status='applied') THEN
    RAISE EXCEPTION 'ANOTHER_REBUILD_ALREADY_APPLIED';
  END IF;

  v_original_pos_fingerprint:=baba_august_rebuild_private.pos_original_fingerprint();
  v_original_inventory_fingerprint:=baba_august_rebuild_private.inventory_original_fingerprint();
  SELECT COALESCE(MAX(id),0) INTO v_audit_max_id FROM public.ledger_audit_logs;
  v_audit_fingerprint:=baba_august_rebuild_private.audit_prefix_fingerprint(v_audit_max_id);
  v_payables:=baba_august_rebuild_private.payable_fingerprint();
  v_history:=baba_august_rebuild_private.history_fingerprint();
  -- Verify the five EXPECTED snapshots against their independent current sources.
  -- Previously all but payable_allocations were compared only against themselves
  -- immediately before/after this function, allowing a stale approved plan through.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_manifest->'requiredProtectedFingerprints') e
    WHERE (e->>'fingerprint') IS DISTINCT FROM CASE e->>'name'
      WHEN 'payable_allocations' THEN v_payables
      WHEN 'pos_receipts' THEN v_original_pos_fingerprint
      WHEN 'month_closure_history' THEN v_history
      WHEN 'ledger_audit_history' THEN v_audit_fingerprint
      WHEN 'inventory_logs' THEN v_original_inventory_fingerprint
      ELSE NULL END
    OR (e->>'beforeCount')::bigint IS DISTINCT FROM CASE e->>'name'
      WHEN 'payable_allocations' THEN (
        SELECT count(*) FROM public.ledger_payable_allocations a
        JOIN public.ledger_payables p ON p.id=a.payable_id
        JOIN public.ledger_transactions src ON src.id=p.expense_transaction_id
        JOIN public.ledger_transactions pay ON pay.id=a.payment_transaction_id
        WHERE src.business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
          AND src.status='confirmed' AND pay.status='confirmed'
          AND pay.business_date BETWEEN DATE '2026-09-01' AND DATE '2026-10-31')
      WHEN 'pos_receipts' THEN (SELECT count(*) FROM public.ledger_transactions
        WHERE business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
          AND source_type='pos_sales_daily_payment')
      WHEN 'month_closure_history' THEN (SELECT count(*) FROM public.ledger_month_closure_history
        WHERE month IN (DATE '2026-08-01',DATE '2026-09-01') AND revision<=4)
      WHEN 'ledger_audit_history' THEN (SELECT count(*) FROM public.ledger_audit_logs WHERE id <= v_audit_max_id)
      WHEN 'inventory_logs' THEN (SELECT count(*) FROM public.inventory_logs
        WHERE business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31')
      ELSE NULL END
  ) THEN RAISE EXCEPTION 'APPROVED_PROTECTION_SNAPSHOT_STALE'; END IF;
  SELECT e->>'fingerprint',(e->>'beforeCount')::int INTO v_expected_payables,v_expected_payable_count
    FROM jsonb_array_elements(p_manifest->'requiredProtectedFingerprints') e
    WHERE e->>'name'='payable_allocations';
  IF v_payables IS DISTINCT FROM v_expected_payables OR
    (SELECT count(*) FROM public.ledger_payable_allocations a
      JOIN public.ledger_payables p ON p.id=a.payable_id
      JOIN public.ledger_transactions src ON src.id=p.expense_transaction_id
      JOIN public.ledger_transactions paid ON paid.id=a.payment_transaction_id
      WHERE src.business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
      AND src.status='confirmed' AND paid.status='confirmed'
      AND paid.business_date BETWEEN DATE '2026-09-01' AND DATE '2026-10-31')<>v_expected_payable_count THEN
    RAISE EXCEPTION 'LATER_PAYABLES_CHANGED';
  END IF;
  IF (SELECT count(*) FROM public.ledger_month_closure_history WHERE month IN(DATE '2026-08-01',DATE '2026-09-01'))<>8 THEN
    RAISE EXCEPTION 'MONTH_HISTORY_CHANGED';
  END IF;

  v_before:=jsonb_build_object(
    '2026-08',baba_august_rebuild_private.balances_at(DATE '2026-09-01'),
    '2026-09',baba_august_rebuild_private.balances_at(DATE '2026-10-01'),
    '2026-10',baba_august_rebuild_private.balances_at(DATE '2026-11-01'));
  IF v_before->'2026-08' IS DISTINCT FROM p_manifest->'expectedCurrentClosing'
      OR v_before->'2026-09' IS DISTINCT FROM
        (SELECT e->'current' FROM jsonb_array_elements(p_manifest->'expectedFollowup') e WHERE e->>'month'='2026-09')
      OR v_before->'2026-10' IS DISTINCT FROM
        (SELECT e->'current' FROM jsonb_array_elements(p_manifest->'expectedFollowup') e WHERE e->>'month'='2026-10') THEN
    RAISE EXCEPTION 'FUNDS_SNAPSHOT_STALE';
  END IF;

  -- Fixed authoritative four-fund closing totals, independently of any manifest.
  IF p_manifest->'expectedClosing' IS DISTINCT FROM
    '{"store_cash":"51502786","vuong_personal_custody":"6774110","cho_personal_custody":"46343661","baba_corporate_bank":"222917683"}'::jsonb THEN
    RAISE EXCEPTION 'AUGUST_SHEET_CLOSING_CHANGED';
  END IF;
  IF jsonb_array_length(p_manifest->'requiredTechnicalMovementIds')<>8 THEN
    RAISE EXCEPTION 'TECHNICAL_EIGHT_REQUIRED';
  END IF;
  IF (SELECT count(DISTINCT e->>'name') FROM jsonb_array_elements(p_manifest->'requiredProtectedFingerprints') e)<>5
      OR EXISTS(SELECT 1 FROM unnest(ARRAY['payable_allocations','pos_receipts','month_closure_history','ledger_audit_history','inventory_logs']) x(name)
        WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_manifest->'requiredProtectedFingerprints') e
          WHERE e->>'name'=x.name AND length(COALESCE(e->>'fingerprint',''))>0)) THEN
    RAISE EXCEPTION 'REQUIRED_PROTECTION_MISSING';
  END IF;
  IF (SELECT COUNT(DISTINCT e->>'month') FROM jsonb_array_elements(p_manifest->'expectedFollowup') e)<>2 THEN
    RAISE EXCEPTION 'EXPECTED_FOLLOWUP_DUPLICATED';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_manifest->'expectedDaily') d
    WHERE (d->>'businessDate')::date NOT BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
    OR (d->>'accountId')::int NOT IN(1,2,3,5) OR
    scale((d->>'signedAmount')::numeric)>3) THEN
    RAISE EXCEPTION 'INVALID_DAILY_SOURCE';
  END IF;

  -- Pairwise relocation is checked BEFORE any insertion. The first effect
  -- reverses the exact original; the second effect re-applies the same amount.
  FOR v_record IN SELECT e->>'adjustmentId' AS action_id, count(*) AS num
     FROM jsonb_array_elements(p_manifest->'events') e WHERE e->>'kind'='relocate-payment'
     GROUP BY e->>'adjustmentId' LOOP
    IF v_record.num<>2 THEN RAISE EXCEPTION 'RELOCATE_PAIR_COUNT:%',v_record.action_id; END IF;
    SELECT jsonb_agg(e ORDER BY e->>'key') INTO v_group
       FROM jsonb_array_elements(p_manifest->'events') e WHERE e->>'adjustmentId'=v_record.action_id;
    v_prior:=v_group->0;
    v_later:=v_group->1;
    IF v_prior->>'kind'<>'relocate-payment' OR v_later->>'kind'<>'relocate-payment' OR
      v_prior->>'originalMovementId' IS DISTINCT FROM v_later->>'originalMovementId' OR
      v_prior->>'sourceTransactionId' IS DISTINCT FROM v_later->>'sourceTransactionId' OR
      v_prior->>'businessDate' IS NULL OR v_later->>'businessDate' IS NULL THEN
      RAISE EXCEPTION 'RELOCATE_PAIR_DRIFT:%',v_record.action_id;
    END IF;
    SELECT * INTO v_source_movement FROM public.ledger_movements WHERE id=(v_prior->>'originalMovementId')::bigint;
    IF NOT FOUND OR v_source_movement.transaction_id<>(v_prior->>'sourceTransactionId')::bigint OR
      v_prior->'movements'->0->>'accountId' IS DISTINCT FROM v_source_movement.fund_account_id::text OR
      (v_prior->'movements'->0->>'amount')::numeric<>-v_source_movement.amount OR
      (v_later->'movements'->0->>'amount')::numeric<>v_source_movement.amount OR
      (SELECT business_date::text FROM public.ledger_transactions WHERE id=v_source_movement.transaction_id)
       IS DISTINCT FROM v_prior->>'businessDate' THEN
      RAISE EXCEPTION 'RELOCATE_ORIGINAL_NOT_EXACT:%',v_record.action_id;
    END IF;
  END LOOP;
  SELECT array_agg((e->>'originalMovementId')::bigint ORDER BY (e->>'originalMovementId')::bigint)
    INTO v_tech_ids
  FROM jsonb_array_elements(p_manifest->'events') e WHERE e->>'kind'='remove-technical';
  IF v_tech_ids IS DISTINCT FROM ARRAY[526,527,528,529,536,537,710,711]::bigint[]
     OR (SELECT array_agg(x.id::bigint ORDER BY x.id::bigint)
           FROM jsonb_array_elements_text(p_manifest->'requiredTechnicalMovementIds') x(id))
       IS DISTINCT FROM ARRAY[526,527,528,529,536,537,710,711]::bigint[] THEN
    RAISE EXCEPTION 'LEGACY_EIGHT_NOT_EXACT';
  END IF;
  -- Each original movement may be reversed only once per run. Relocation uses
  -- two matched entries for one adjustmentId, so count distinct adjustments.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT e->>'originalMovementId' AS movement_id,
             count(DISTINCT e->>'adjustmentId') AS uses
      FROM jsonb_array_elements(p_manifest->'events') e
      WHERE e->>'originalMovementId' IS NOT NULL
      GROUP BY e->>'originalMovementId'
    ) uses WHERE uses.uses>1
  ) THEN RAISE EXCEPTION 'DUPLICATE_ORIGINAL_MOVEMENT_REVERSAL'; END IF;
  -- Multiple cash-only restorations of one original expense cannot exceed the
  -- originating recognized amount; never use a source as an unlimited cash plug.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT (e->>'sourceTransactionId')::bigint AS tx_id,
             sum(abs((e->'movements'->0->>'amount')::numeric)) AS restored_amount
      FROM jsonb_array_elements(p_manifest->'events') e
      WHERE e->>'kind' IN ('restore-outflow','restore-inflow')
      GROUP BY (e->>'sourceTransactionId')::bigint
    ) totals
    LEFT JOIN public.ledger_transactions source ON source.id=totals.tx_id
    WHERE source.id IS NULL OR totals.restored_amount>source.amount
  ) THEN RAISE EXCEPTION 'RESTORATION_OVER_ORIGINAL_AMOUNT'; END IF;

  -- Only this one batch is staged, never a visible user-interface transaction.
  INSERT INTO baba_august_rebuild_private.runs(run_id,manifest_digest,sheet_cell_digest,status,actor_user_id,
    manifest,before_balance,payable_fingerprint,closure_history_fingerprint)
  VALUES(v_run,v_manifest_hash,p_approved_sheet_digest,'applying',p_actor_user_id,p_manifest,v_before,v_payables,v_history);

  v_event_count:=0;
  FOR v_event IN SELECT value FROM jsonb_array_elements(p_manifest->'events') LOOP
    v_key:=v_event->>'key';
    v_kind:=v_event->>'kind';
    v_type:=v_event->>'type';
    v_date:=(v_event->>'businessDate')::date;
    v_at:=(v_event->>'occurredAt')::timestamptz;
    v_source_id:=NULLIF(v_event->>'sourceTransactionId','')::bigint;
    v_technical:=NULLIF(v_event->>'originalMovementId','')::bigint;
    v_amount:=(v_event->>'amount')::numeric;
    v_effect_count:=jsonb_array_length(v_event->'movements');
    IF v_kind NOT IN ('transfer','remove-technical','restore-outflow','restore-inflow','relocate-payment')
       OR v_key !~ ('^aug-rebuild:'||v_run::text||':[a-zA-Z0-9_-]{1,80}:[0-9]+$')
       OR length(btrim(COALESCE(v_event->>'reason','')))=0
       OR length(btrim(COALESCE(v_event->>'evidenceReference','')))=0
       OR v_date NOT BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
       OR ((v_at AT TIME ZONE 'Asia/Ho_Chi_Minh') - INTERVAL '3 hours')::date <> v_date
       OR v_amount < 0 OR scale(v_amount)>3 OR
          v_effect_count NOT IN (1,2) THEN
      RAISE EXCEPTION 'INVALID_REBUILD_EVENT: %',v_key;
    END IF;
    v_sum:=0;
    FOR v_movement IN SELECT value FROM jsonb_array_elements(v_event->'movements') LOOP
      v_account:=(v_movement->>'accountId')::bigint;
      v_expected:=(v_movement->>'amount')::numeric;
      IF v_account NOT IN (1,2,3,5) OR v_expected=0 OR scale(v_expected)>3 THEN
        RAISE EXCEPTION 'INVALID_MOVEMENT: %',v_key;
      END IF;
      v_sum:=v_sum+v_expected;
    END LOOP;
    IF v_type='transfer' THEN
      IF v_kind<>'transfer' OR v_effect_count<>2 OR v_sum<>0 OR v_amount<=0
        OR v_source_id IS NOT NULL OR v_technical IS NOT NULL OR
        (SELECT count(DISTINCT (a->>'accountId')::int) FROM jsonb_array_elements(v_event->'movements') a)<>2 THEN
        RAISE EXCEPTION 'INVALID_TRANSFER: %',v_key;
      END IF;
    ELSIF v_type='correction' THEN
      IF v_kind='transfer' OR v_effect_count<>1 OR v_amount<>0 OR v_source_id IS NULL
        OR NOT EXISTS(SELECT 1 FROM public.ledger_transactions WHERE id=v_source_id
          AND status='confirmed' AND business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-31') THEN
        RAISE EXCEPTION 'INVALID_CORRECTION_SOURCE: %',v_key;
      END IF;
      SELECT * INTO v_source FROM public.ledger_transactions WHERE id=v_source_id;
      IF v_kind='remove-technical' THEN
        SELECT * INTO v_technical_movement FROM public.ledger_movements WHERE id=v_technical;
        IF v_source.type<>'balance_adjustment' OR v_technical_movement.transaction_id IS DISTINCT FROM v_source_id
          OR v_date<>v_source.business_date
          OR (v_event->'movements'->0->>'accountId')::bigint<>v_technical_movement.fund_account_id
          OR v_sum<>-v_technical_movement.amount THEN
          RAISE EXCEPTION 'TECHNICAL_REVERSAL_DRIFT: %',v_key;
        END IF;
      ELSIF v_kind IN('restore-outflow','restore-inflow') THEN
        IF v_technical IS NOT NULL OR v_source.source_type<>'legacy_sheet_detail'
          OR EXISTS(SELECT 1 FROM public.ledger_movements WHERE transaction_id=v_source_id)
          OR EXISTS(SELECT 1 FROM public.ledger_payables WHERE expense_transaction_id=v_source_id)
          OR (v_kind='restore-outflow' AND (v_source.type<>'expense' OR v_sum>=0))
          OR (v_kind='restore-inflow' AND (v_source.type<>'income' OR v_sum<=0)) THEN
          RAISE EXCEPTION 'RESTORATION_SOURCE_DRIFT: %',v_key;
        END IF;
      ELSIF v_kind='relocate-payment' THEN
        SELECT * INTO v_technical_movement FROM public.ledger_movements WHERE id=v_technical;
        IF v_technical_movement.transaction_id IS DISTINCT FROM v_source_id
          OR v_source.source_type='pos_sales_daily_payment' THEN
          RAISE EXCEPTION 'RELOCATE_SOURCE_DRIFT: %',v_key;
        END IF;
      END IF;
    ELSE RAISE EXCEPTION 'INVALID_EVENT_TYPE: %',v_key;
    END IF;

    -- No recognition_month / category_id, hence every new correction is cash-only.
    INSERT INTO public.ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,
      amount,category_id,party_id,status,source_type,source_key,source_snapshot,
      source_fingerprint,source_synced_at,correction_of_id,memo,created_by,confirmed_by,economic_effect_sign)
    VALUES(gen_random_uuid(),v_type,v_at,v_date,NULL,v_amount,NULL,NULL,'confirmed',
      'ledger_correction',v_key,jsonb_build_object('runId',v_run,'source',v_event),
      md5(jsonb_build_object('runId',v_run,'source',v_event)::text),now(),v_source_id,
      left(v_event->>'reason',2000),p_actor_user_id,p_actor_user_id,1)
    RETURNING id INTO v_new_tx;
    FOR v_movement IN SELECT value FROM jsonb_array_elements(v_event->'movements') LOOP
      INSERT INTO public.ledger_movements(transaction_id,fund_account_id,amount)
      VALUES(v_new_tx,(v_movement->>'accountId')::bigint,(v_movement->>'amount')::numeric);
    END LOOP;
    INSERT INTO baba_august_rebuild_private.events(run_id,event_key,event_data,created_transaction_id)
      VALUES(v_run,v_key,v_event,v_new_tx);
    INSERT INTO public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason)
      VALUES(p_actor_user_id,'august_rebuild_applied','transaction',v_new_tx,
        jsonb_build_object('runId',v_run,'event',v_event,'createdTransactionId',v_new_tx),
        'Approved 2026-08 reconstruction; cash-only correction');
    v_event_count:=v_event_count+1;
  END LOOP;

  -- 124 audited day/account cash totals: opening entries deliberately excluded.
  FOR v_record IN SELECT value AS item FROM jsonb_array_elements(p_manifest->'expectedDaily') LOOP
    v_date:=(v_record.item->>'businessDate')::date;
    v_account:=(v_record.item->>'accountId')::bigint;
    v_expected:=(v_record.item->>'signedAmount')::numeric;
    SELECT COALESCE(SUM(m.amount),0) INTO v_observed
      FROM public.ledger_movements m JOIN public.ledger_transactions t ON t.id=m.transaction_id
      WHERE t.status='confirmed' AND t.business_date=v_date AND t.type<>'opening'
        AND m.fund_account_id=v_account;
    IF v_observed<>v_expected THEN RAISE EXCEPTION 'DAILY_BALANCE_MISMATCH:%:%:%,%',v_date,v_account,v_observed,v_expected; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT ((x->>'businessDate')||':'||(x->>'accountId'))) FROM jsonb_array_elements(p_manifest->'expectedDaily') x)<>124
    THEN RAISE EXCEPTION 'DAILY_124_NOT_UNIQUE'; END IF;
  FOR v_record IN SELECT * FROM (VALUES
    ('2026-08',DATE '2026-09-01','store_cash',51502786::numeric),
    ('2026-08',DATE '2026-09-01','vuong_personal_custody',6774110::numeric),
    ('2026-08',DATE '2026-09-01','cho_personal_custody',46343661::numeric),
    ('2026-08',DATE '2026-09-01','baba_corporate_bank',222917683::numeric),
    ('2026-09',DATE '2026-10-01','store_cash',38479206::numeric),
    ('2026-09',DATE '2026-10-01','vuong_personal_custody',8463910::numeric),
    ('2026-09',DATE '2026-10-01','cho_personal_custody',24040861::numeric),
    ('2026-09',DATE '2026-10-01','baba_corporate_bank',267861665::numeric),
    ('2026-10',DATE '2026-11-01','store_cash',78005406::numeric),
    ('2026-10',DATE '2026-11-01','vuong_personal_custody',6512710::numeric),
    ('2026-10',DATE '2026-11-01','cho_personal_custody',54391381::numeric),
    ('2026-10',DATE '2026-11-01','baba_corporate_bank',175285689::numeric)
  ) targets(month,endexclusive,accountcode,expected_amount) LOOP
    SELECT (baba_august_rebuild_private.balances_at(v_record.endexclusive)->>v_record.accountcode)::numeric INTO v_observed;
    IF v_observed<>v_record.expected_amount THEN
      RAISE EXCEPTION 'MONTH_BALANCE_MISMATCH:%:%:%,%',v_record.month,v_record.accountcode,v_observed,v_record.expected_amount;
    END IF;
  END LOOP;
  IF baba_august_rebuild_private.payable_fingerprint()<>v_payables OR
     baba_august_rebuild_private.history_fingerprint()<>v_history OR
     baba_august_rebuild_private.pos_original_fingerprint()<>v_original_pos_fingerprint OR
     baba_august_rebuild_private.inventory_original_fingerprint()<>v_original_inventory_fingerprint OR
     baba_august_rebuild_private.audit_prefix_fingerprint(v_audit_max_id)<>v_audit_fingerprint THEN
    RAISE EXCEPTION 'PROTECTED_DATA_CHANGED';
  END IF;
  v_after:=jsonb_build_object('2026-08',baba_august_rebuild_private.balances_at(DATE '2026-09-01'),
    '2026-09',baba_august_rebuild_private.balances_at(DATE '2026-10-01'),
    '2026-10',baba_august_rebuild_private.balances_at(DATE '2026-11-01'));
  UPDATE baba_august_rebuild_private.runs SET status='applied',applied_at=now(),after_balance=v_after WHERE run_id=v_run;
  RETURN jsonb_build_object('status','applied','runId',v_run,'eventCount',v_event_count,'before',v_before,'after',v_after);
END;
$apply$;

-- Post-commit inverse corrections are append-only and must be invoked explicitly
-- after reopening both months. They do not delete original rows, movements, or logs.
CREATE OR REPLACE FUNCTION baba_august_rebuild_private.reverse_v1(
 p_run_id uuid,p_actor_user_id bigint,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET lock_timeout='5s' AS $reverse$
DECLARE
 v_run baba_august_rebuild_private.runs%ROWTYPE;
 v_row baba_august_rebuild_private.events%ROWTYPE;
 v_orig public.ledger_transactions%ROWTYPE;
 v_orig_movement record;
 v_new_tx bigint;
 v_count int:=0;
 v_snapshot jsonb;
 v_reason text;
 v_account text;
 v_period record;
BEGIN
 IF session_user<>'postgres' THEN RAISE EXCEPTION 'DBA_SESSION_REQUIRED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=p_actor_user_id AND lower(role::text) IN('owner','master') AND is_active AND app_login_enabled) THEN
   RAISE EXCEPTION 'OWNER_REQUIRED'; END IF;
 v_reason:=nullif(btrim(p_reason),'');
 IF v_reason IS NULL THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));
 FOR v_account IN SELECT unnest(ARRAY['2026-08','2026-09','2026-10']) LOOP
   PERFORM pg_advisory_xact_lock(hashtext('ledger_month_close:'||v_account));
 END LOOP;
 IF (SELECT count(*) FROM public.ledger_month_closures WHERE month IN(DATE '2026-08-01',DATE '2026-09-01') AND status='reopened')<>2
    OR EXISTS(SELECT 1 FROM public.ledger_month_closures WHERE month=DATE '2026-10-01' AND status='closed') THEN
   RAISE EXCEPTION 'MONTHS_MUST_BE_REOPENED'; END IF;
 LOCK TABLE public.ledger_transactions IN SHARE ROW EXCLUSIVE MODE;
 LOCK TABLE public.ledger_movements IN SHARE ROW EXCLUSIVE MODE;
 LOCK TABLE public.ledger_payable_allocations IN SHARE MODE;
 SELECT * INTO v_run FROM baba_august_rebuild_private.runs WHERE run_id=p_run_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RUN_NOT_FOUND'; END IF;
 IF v_run.status='reversed' THEN RETURN jsonb_build_object('status','already_reversed','runId',p_run_id); END IF;
 IF v_run.status<>'applied' THEN RAISE EXCEPTION 'RUN_NOT_APPLIED'; END IF;
 IF baba_august_rebuild_private.payable_fingerprint()<>v_run.payable_fingerprint OR
   baba_august_rebuild_private.history_fingerprint()<>v_run.closure_history_fingerprint THEN
   RAISE EXCEPTION 'SOURCE_PROTECTION_DRIFT'; END IF;
 IF jsonb_build_object('2026-08',baba_august_rebuild_private.balances_at(DATE '2026-09-01'),
    '2026-09',baba_august_rebuild_private.balances_at(DATE '2026-10-01'),
    '2026-10',baba_august_rebuild_private.balances_at(DATE '2026-11-01')) IS DISTINCT FROM v_run.after_balance THEN
   RAISE EXCEPTION 'LATER_LEDGER_CHANGED'; END IF;
 FOR v_row IN SELECT * FROM baba_august_rebuild_private.events WHERE run_id=p_run_id ORDER BY id DESC LOOP
   SELECT * INTO v_orig FROM public.ledger_transactions WHERE id=v_row.created_transaction_id FOR UPDATE;
   IF v_orig.id IS NULL OR v_orig.status<>'confirmed' OR
      v_orig.source_key<>v_row.event_key OR v_row.reversed_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'APPLIED_SOURCE_DRIFT:%',v_row.event_key; END IF;
   v_snapshot:=jsonb_build_object('reverseOfTransactionId',v_orig.id,'runId',p_run_id,'reason',v_reason);
   INSERT INTO public.ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,
      amount,category_id,party_id,status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,
      correction_of_id,memo,created_by,confirmed_by,economic_effect_sign)
   VALUES(gen_random_uuid(),'correction',v_orig.occurred_at,v_orig.business_date,NULL,0,NULL,NULL,'confirmed',
      'ledger_correction','aug-rebuild-reverse:'||p_run_id::text||':'||v_row.id::text,
      v_snapshot,md5(v_snapshot::text),now(),v_orig.id,left(v_reason,2000),p_actor_user_id,p_actor_user_id,1)
   RETURNING id INTO v_new_tx;
   FOR v_orig_movement IN SELECT * FROM public.ledger_movements WHERE transaction_id=v_orig.id ORDER BY id LOOP
      INSERT INTO public.ledger_movements(transaction_id,fund_account_id,amount)
      VALUES(v_new_tx,v_orig_movement.fund_account_id,-v_orig_movement.amount);
   END LOOP;
   UPDATE baba_august_rebuild_private.events SET reversed_transaction_id=v_new_tx WHERE id=v_row.id;
   INSERT INTO public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
   VALUES(p_actor_user_id,'august_rebuild_reversed','transaction',v_new_tx,to_jsonb(v_orig),v_snapshot,v_reason);
   v_count:=v_count+1;
 END LOOP;
 IF jsonb_build_object('2026-08',baba_august_rebuild_private.balances_at(DATE '2026-09-01'),
   '2026-09',baba_august_rebuild_private.balances_at(DATE '2026-10-01'),
   '2026-10',baba_august_rebuild_private.balances_at(DATE '2026-11-01')) IS DISTINCT FROM v_run.before_balance THEN
   RAISE EXCEPTION 'REVERSAL_BALANCE_FAILED'; END IF;
 UPDATE baba_august_rebuild_private.runs SET status='reversed',reversed_at=now() WHERE run_id=p_run_id;
 RETURN jsonb_build_object('status','reversed','runId',p_run_id,'reversedCount',v_count);
END;
$reverse$;

REVOKE ALL ON FUNCTION baba_august_rebuild_private.apply_v1(jsonb,bigint,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION baba_august_rebuild_private.reverse_v1(uuid,bigint,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION baba_august_rebuild_private.balances_at(date) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION baba_august_rebuild_private.payable_fingerprint() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION baba_august_rebuild_private.history_fingerprint() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION baba_august_rebuild_private.pos_original_fingerprint() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION baba_august_rebuild_private.inventory_original_fingerprint() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION baba_august_rebuild_private.audit_prefix_fingerprint(bigint) FROM PUBLIC,anon,authenticated,service_role;
-- END OF ISOLATED PROPOSAL. No APPLY call, no data migration, no COMMIT.
