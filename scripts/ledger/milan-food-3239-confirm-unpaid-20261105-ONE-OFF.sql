-- ONE-OFF OPERATIONAL CORRECTION. Not a migration. NOT executed by Codex.
-- Operator: replace __ACTOR_USER_ID__ with your active owner/master users.id.
-- Run the whole file using a privileged SQL connection; do not run as fragments.
-- Scope: remove ONLY #3239.source_snapshot.paymentVerification='pending'.
-- Ordinary verified payables have no paymentVerification key. #1614 stays unpaid.
-- No payment, allocation, receipt, inventory, reserve, balance or close is written.
-- Baseline: evidence/20261105-milan-food-3239-before-READONLY.json.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL baba.audit_actor_user_id = '__ACTOR_USER_ID__';

DO $confirm_milan_unpaid$
DECLARE
  v_actor_text text := current_setting('baba.audit_actor_user_id', true);
  v_actor bigint;
  v_before public.ledger_transactions%ROWTYPE;
  v_after public.ledger_transactions%ROWTYPE;
  v_payable public.ledger_payables%ROWTYPE;
  v_inventory_log jsonb;
  v_prior_audit public.ledger_audit_logs%ROWTYPE;
  v_audit_count bigint;
  v_audit_id bigint;
  v_reason constant text := '20261105 Milan Food #3239 / payable #1614: user confirmed 1,410,000 VND remains unpaid; verification metadata only';
BEGIN
  IF v_actor_text IS NULL OR v_actor_text !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'Set __ACTOR_USER_ID__ to the actual operator users.id before running';
  END IF;
  v_actor := v_actor_text::bigint;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=v_actor AND is_active
                 AND app_login_enabled AND lower(role::text) IN ('owner','master')) THEN
    RAISE EXCEPTION 'Active owner/master audit actor required';
  END IF;

  -- Serialize concurrent runs on the existing transaction; never disable guards.
  SELECT * INTO STRICT v_before FROM public.ledger_transactions WHERE id=3239 FOR UPDATE;
  SELECT count(*) INTO v_audit_count FROM public.ledger_audit_logs
   WHERE entity_type='transaction' AND entity_id=3239
     AND action='payment_verification_confirmed_unpaid' AND reason=v_reason;
  IF v_audit_count > 1 THEN RAISE EXCEPTION 'Duplicate correction audit; investigate'; END IF;
  IF v_audit_count = 1 THEN
    SELECT * INTO STRICT v_prior_audit FROM public.ledger_audit_logs
     WHERE entity_type='transaction' AND entity_id=3239
       AND action='payment_verification_confirmed_unpaid' AND reason=v_reason;
    IF v_before.source_snapshot ? 'paymentVerification'
       OR v_prior_audit.before_snapshot#>>'{transaction,source_snapshot,paymentVerification}' IS DISTINCT FROM 'pending'
       OR (v_prior_audit.after_snapshot#>'{transaction,source_snapshot}') IS DISTINCT FROM
          ((v_prior_audit.before_snapshot#>'{transaction,source_snapshot}')-'paymentVerification') THEN
      RAISE EXCEPTION 'Existing correction audit/current marker mismatch; no repeat correction';
    END IF;
    RAISE NOTICE 'Already applied (audit %); no transaction update or new audit', v_prior_audit.id;
    RETURN;
  END IF;

  SELECT * INTO STRICT v_payable FROM public.ledger_payables WHERE id=1614 FOR UPDATE;
  IF v_before.type IS DISTINCT FROM 'expense' OR v_before.status IS DISTINCT FROM 'confirmed'
     OR v_before.business_date IS DISTINCT FROM date '2026-10-27'
     OR v_before.recognition_month IS DISTINCT FROM date '2026-10-01'
     OR v_before.amount IS DISTINCT FROM 1410000 OR v_before.economic_effect_sign IS DISTINCT FROM 1
     OR v_before.party_id IS DISTINCT FROM 4
     OR v_before.source_type IS DISTINCT FROM 'inventory_purchase_candidate'
     OR v_before.source_key IS DISTINCT FROM 'candidate:2122'
     OR v_before.source_fingerprint IS DISTINCT FROM '0078320ef4906bc8701d9d8d998d2b920e3c2976e3bebc683830f32f341f6800'
     OR v_before.source_snapshot->>'paymentVerification' IS DISTINCT FROM 'pending'
     OR v_before.source_snapshot->>'supplier' IS DISTINCT FROM 'Milan Food'
     OR v_before.source_snapshot->>'inventory_log_id' IS DISTINCT FROM '14240'
     OR v_payable.expense_transaction_id IS DISTINCT FROM 3239
     OR v_payable.party_id IS DISTINCT FROM 4 OR v_payable.original_amount IS DISTINCT FROM 1410000
     OR v_payable.status IS DISTINCT FROM 'unpaid' THEN
    RAISE EXCEPTION 'Milan Food baseline mismatch; no correction applied';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_movements WHERE transaction_id=3239)
     OR EXISTS (SELECT 1 FROM public.ledger_payable_allocations WHERE payable_id=1614) THEN
    RAISE EXCEPTION 'Unexpected payment/movement/allocation; no correction applied';
  END IF;
  PERFORM public.ledger_assert_month_open_v1(date '2026-10-01');
  SELECT to_jsonb(l) INTO STRICT v_inventory_log FROM public.inventory_logs l WHERE id=14240 FOR SHARE;

  UPDATE public.ledger_transactions
     SET source_snapshot=source_snapshot-'paymentVerification'
   WHERE id=3239 AND source_snapshot->>'paymentVerification'='pending'
   RETURNING * INTO STRICT v_after;

  IF (to_jsonb(v_after)-'source_snapshot'-'updated_at') IS DISTINCT FROM
     (to_jsonb(v_before)-'source_snapshot'-'updated_at')
     OR v_after.source_snapshot IS DISTINCT FROM (v_before.source_snapshot-'paymentVerification')
     OR (SELECT to_jsonb(p) FROM public.ledger_payables p WHERE id=1614) IS DISTINCT FROM to_jsonb(v_payable)
     OR (SELECT to_jsonb(l) FROM public.inventory_logs l WHERE id=14240) IS DISTINCT FROM v_inventory_log
     OR EXISTS (SELECT 1 FROM public.ledger_movements WHERE transaction_id=3239)
     OR EXISTS (SELECT 1 FROM public.ledger_payable_allocations WHERE payable_id=1614) THEN
    RAISE EXCEPTION 'Protected state changed; rolling back the correction';
  END IF;

  INSERT INTO public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
  VALUES (v_actor,'payment_verification_confirmed_unpaid','transaction',3239,
    jsonb_build_object('transaction',to_jsonb(v_before),'payable',to_jsonb(v_payable),
                       'movements','[]'::jsonb,'allocations','[]'::jsonb,'inventoryLog',v_inventory_log),
    jsonb_build_object('transaction',to_jsonb(v_after),'payable',to_jsonb(v_payable),
                       'movements','[]'::jsonb,'allocations','[]'::jsonb,'inventoryLog',v_inventory_log),v_reason)
  RETURNING id INTO v_audit_id;
  RAISE NOTICE 'Verified unpaid metadata only; transaction 3239, payable 1614 unchanged, audit %', v_audit_id;
END;
$confirm_milan_unpaid$;

-- Read-only verification. EARLIER_MONTH_REOPENED is added by the API GET and
-- enforced by the close RPC; do not interpret the preflight RPC alone as approval.
SELECT public.ledger_close_preflight_v1(date '2026-10-01',current_setting('baba.audit_actor_user_id')::bigint) AS preflight,
       (SELECT jsonb_agg(month ORDER BY month) FROM public.ledger_month_closures
         WHERE month<date '2026-10-01' AND status='reopened') AS earlier_reopened_months;
SELECT t.id,t.amount,t.source_snapshot->>'paymentVerification' AS payment_verification,
       p.id AS payable_id,p.original_amount,p.status AS payable_status
  FROM public.ledger_transactions t JOIN public.ledger_payables p ON p.expense_transaction_id=t.id
 WHERE t.id=3239 AND p.id=1614;
COMMIT;
