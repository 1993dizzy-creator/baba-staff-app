-- ONE-OFF OPERATIONAL RECORD. Not a migration. NOT executed by Claude.
-- October 2026 card fee: "estimate-basis exception closing" (추정 기준 예외 마감).
--
-- The actual card-company fee for October 2026 could not be confirmed. The provisional manual
-- expense #4119 (5,699,112₫ = 2.9663% of card sales 192,125,640₫) is kept exactly as booked and the
-- month is recorded as closed on that estimate. This file writes ONE append-only audit row and
-- nothing else:
--   * no expense, closure, allocation line, movement or reconciliation is created or changed;
--   * card_clearing, the November deposits/allocations and the October month close stay untouched;
--   * the record says officialFeeConfirmed=false; the app shows "예외 마감 · 추정 기준" and keeps
--     October out of the historical average (lib/ledger/card-fee-exception.ts).
-- The P0 guards stay in force: deposits never repay October and October can never be settled again.
--
-- Operator, before running (only after the owner's separate written approval):
--   1. Replace __ACTOR_USER_ID__ with your active owner/master users.id.
--   2. Replace __OWNER_APPROVAL__ with APPROVED:card-fee-october-estimate-exception-20261108.
--   3. Run this WHOLE file in one privileged SQL session; never run fragments.
-- Re-run with the identical record present: verified, no change. Anything different: RAISE, nothing written.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL baba.audit_actor_user_id = '__ACTOR_USER_ID__';
SET LOCAL baba.card_fee_october_exception_approval = '__OWNER_APPROVAL__';

DO $october_exception$
DECLARE
  c_month constant date := date '2026-10-01';
  c_provisional_tx constant bigint := 4119;
  c_amount constant numeric := 5699112;
  c_gross constant numeric := 192125640;
  c_action constant text := 'card_fee_month_estimate_exception';
  c_entity constant text := 'card_fee_month';
  c_approval constant text := 'APPROVED:card-fee-october-estimate-exception-20261108';
  c_script constant text := 'scripts/ledger/card-fee-october-estimate-exception-20261108-ONE-OFF.sql';
  c_reason constant text := '2026년 10월 카드수수료 추정 기준 예외 마감: 카드사 실제 수수료 미확인. 기존 임시 비용 5,699,112₫(카드매출 192,125,640₫ 대비 2.9663%) 유지, 공식 확인 수수료 아님, 평균 수수료율 제외.';
  v_actor_text text := current_setting('baba.audit_actor_user_id', true);
  v_approval text := current_setting('baba.card_fee_october_exception_approval', true);
  v_actor bigint;
  v_tx public.ledger_transactions%ROWTYPE;
  v_gross numeric; v_outstanding numeric; v_count integer;
  v_snapshot jsonb; v_existing public.ledger_audit_logs%ROWTYPE;
  v_protected_before jsonb; v_protected_after jsonb;
BEGIN
  -- 0. Operator and owner approval.
  IF v_actor_text IS NULL OR v_actor_text !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'OCT_EXCEPTION_ACTOR_REQUIRED: set __ACTOR_USER_ID__ to the operator users.id';
  END IF;
  v_actor := v_actor_text::bigint;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=v_actor AND is_active AND app_login_enabled AND lower(role::text) IN ('owner','master')) THEN
    RAISE EXCEPTION 'OCT_EXCEPTION_ACTOR_FORBIDDEN: active owner/master users.id required';
  END IF;
  IF v_approval IS DISTINCT FROM c_approval THEN
    RAISE EXCEPTION 'OCT_EXCEPTION_APPROVAL_REQUIRED: owner approval token missing or wrong';
  END IF;

  -- 1. The provisional voucher is exactly as booked: one card_clearing outflow, nothing else.
  SELECT * INTO v_tx FROM public.ledger_transactions WHERE id=c_provisional_tx FOR SHARE;
  IF v_tx.id IS NULL OR v_tx.status<>'confirmed' OR v_tx.type<>'expense' OR v_tx.source_type<>'manual'
     OR v_tx.amount<>c_amount OR v_tx.recognition_month IS DISTINCT FROM c_month OR v_tx.economic_effect_sign<>1
     OR NOT EXISTS (SELECT 1 FROM public.ledger_categories WHERE id=v_tx.category_id AND kind='expense' AND name='카드 정산 차액')
     OR (SELECT count(*) FROM public.ledger_movements WHERE transaction_id=v_tx.id)<>1
     OR NOT EXISTS (SELECT 1 FROM public.ledger_movements m JOIN public.ledger_fund_accounts f ON f.id=m.fund_account_id
                    WHERE m.transaction_id=v_tx.id AND f.code='card_clearing' AND m.amount=-c_amount) THEN
    RAISE EXCEPTION 'OCT_EXCEPTION_PROVISIONAL_MISMATCH: voucher % is not the expected provisional card fee', c_provisional_tx;
  END IF;
  IF ledger_card_fee_private.provisional_fee(c_month) IS DISTINCT FROM c_amount THEN
    RAISE EXCEPTION 'OCT_EXCEPTION_PROVISIONAL_TOTAL_MISMATCH';
  END IF;

  -- 2. October is closed, has no official fee closure, and its remainder equals the provisional fee.
  IF NOT public.ledger_month_is_closed_v1(c_month) THEN RAISE EXCEPTION 'OCT_EXCEPTION_MONTH_NOT_CLOSED'; END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_card_fee_closures WHERE fee_month=c_month AND status='confirmed') THEN
    RAISE EXCEPTION 'OCT_EXCEPTION_OFFICIAL_CLOSURE_EXISTS';
  END IF;
  SELECT coalesce(sum(t.amount),0), coalesce(sum(t.amount-public.ledger_card_sale_consumed_v1(t.id)),0) INTO v_gross, v_outstanding
  FROM public.ledger_transactions t WHERE t.status='confirmed' AND t.source_type='pos_sales_daily_payment' AND t.source_key LIKE 'pos:%:card'
    AND date_trunc('month',t.business_date)::date=c_month;
  IF v_gross<>c_gross OR v_outstanding<>c_amount THEN
    RAISE EXCEPTION 'OCT_EXCEPTION_CARD_STATE_CHANGED: gross % / outstanding %', v_gross, v_outstanding;
  END IF;

  v_snapshot := jsonb_build_object(
    'feeMonth', c_month, 'basis', 'provisional_estimate', 'provisionalTransactionId', c_provisional_tx,
    'provisionalAmount', c_amount, 'cardGross', c_gross, 'outstandingGross', v_outstanding,
    'provisionalRate', round(c_amount/c_gross, 6), 'officialFeeConfirmed', false, 'excludedFromAverage', true,
    'approval', c_approval, 'script', c_script);

  -- 3. Idempotent: an identical record means done; anything else stops.
  SELECT count(*) INTO v_count FROM public.ledger_audit_logs WHERE action=c_action;
  IF v_count>1 THEN RAISE EXCEPTION 'OCT_EXCEPTION_DUPLICATE_RECORDS'; END IF;
  IF v_count=1 THEN
    SELECT * INTO v_existing FROM public.ledger_audit_logs WHERE action=c_action;
    IF v_existing.entity_type=c_entity AND v_existing.entity_id=c_provisional_tx AND v_existing.after_snapshot=v_snapshot AND v_existing.reason=c_reason THEN
      RAISE NOTICE 'OCT_EXCEPTION_ALREADY_RECORDED: audit log % (no change)', v_existing.id;
      RETURN;
    END IF;
    RAISE EXCEPTION 'OCT_EXCEPTION_DIFFERENT_RECORD_EXISTS: audit log %', v_existing.id;
  END IF;

  -- 4. Everything financial is compared before/after; any difference rolls back.
  v_protected_before := jsonb_build_object(
    'voucher', (SELECT to_jsonb(t) FROM public.ledger_transactions t WHERE t.id=c_provisional_tx),
    'clearing', (SELECT coalesce(sum(m.amount),0) FROM public.ledger_movements m JOIN public.ledger_transactions t ON t.id=m.transaction_id
                 JOIN public.ledger_fund_accounts f ON f.id=m.fund_account_id WHERE f.code='card_clearing' AND t.status='confirmed'),
    'closures', (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]') FROM public.ledger_card_fee_closures c),
    'monthClose', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.month),'[]') FROM public.ledger_month_closures m WHERE m.month=c_month),
    'lines', (SELECT count(*) FROM public.ledger_card_reconciliation_lines),
    'transactions', (SELECT count(*) FROM public.ledger_transactions),
    'movements', (SELECT count(*) FROM public.ledger_movements));

  INSERT INTO public.ledger_audit_logs(actor_user_id, action, entity_type, entity_id, after_snapshot, reason)
  VALUES (v_actor, c_action, c_entity, c_provisional_tx, v_snapshot, c_reason);

  v_protected_after := jsonb_build_object(
    'voucher', (SELECT to_jsonb(t) FROM public.ledger_transactions t WHERE t.id=c_provisional_tx),
    'clearing', (SELECT coalesce(sum(m.amount),0) FROM public.ledger_movements m JOIN public.ledger_transactions t ON t.id=m.transaction_id
                 JOIN public.ledger_fund_accounts f ON f.id=m.fund_account_id WHERE f.code='card_clearing' AND t.status='confirmed'),
    'closures', (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]') FROM public.ledger_card_fee_closures c),
    'monthClose', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.month),'[]') FROM public.ledger_month_closures m WHERE m.month=c_month),
    'lines', (SELECT count(*) FROM public.ledger_card_reconciliation_lines),
    'transactions', (SELECT count(*) FROM public.ledger_transactions),
    'movements', (SELECT count(*) FROM public.ledger_movements));
  IF v_protected_after IS DISTINCT FROM v_protected_before THEN
    RAISE EXCEPTION 'OCT_EXCEPTION_PROTECTED_STATE_CHANGED';
  END IF;
  IF (SELECT count(*) FROM public.ledger_audit_logs WHERE action=c_action)<>1 THEN
    RAISE EXCEPTION 'OCT_EXCEPTION_RECORD_NOT_WRITTEN';
  END IF;
END
$october_exception$;

COMMIT;
