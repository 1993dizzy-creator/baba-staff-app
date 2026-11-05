-- BABA ledger close preflight: allow a confirmed manual expense backed by a valid payable.
-- Production migration version 20261104165206 is ALREADY APPLIED.
-- This file restores the migration to source control for fresh environments; DO NOT reapply to production.
-- Only the REQUIRED_MOVEMENT_MISSING predicate changes. No ledger transactions, payables or payments are edited.

BEGIN;

DO $baba_preflight_payable_migration$
DECLARE
  v_before_hash CONSTANT text := 'c49bca790cf0004758eb4fa530021732';
  v_after_hash CONSTANT text := '1c70d7bd98145c3abb5c4b20d4855da7';
  v_previous text;
  v_current text;
  v_old text := $original_predicate$if exists(select 1 from public.ledger_transactions t where((t.source_type='manual'and t.type in('expense','income'))or t.type in('payroll_payment','payable_payment','prepaid_expense_payment','card_settlement_deposit'))and(t.recognition_month=p_month or date_trunc('month',t.business_date)::date=p_month)and not exists(select 1 from public.ledger_movements m where m.transaction_id=t.id))then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','REQUIRED_MOVEMENT_MISSING'));end if;$original_predicate$;
  v_new text := $fixed_predicate$if exists(
  select 1 from public.ledger_transactions t
  where ((t.source_type='manual' and t.type in('expense','income'))
      or t.type in ('payroll_payment','payable_payment','prepaid_expense_payment','card_settlement_deposit'))
    and (t.recognition_month=p_month or date_trunc('month',t.business_date)::date=p_month)
    and not exists (select 1 from public.ledger_movements m where m.transaction_id=t.id)
    and not (
       t.status='confirmed' and t.source_type='manual' and t.type='expense'
       and exists (select 1 from public.ledger_payables p
          where p.expense_transaction_id=t.id
            and p.party_id=t.party_id
            and p.original_amount=t.amount
            and p.status in ('unpaid','partially_paid','paid'))
    )
) then
  v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','REQUIRED_MOVEMENT_MISSING'));
end if;$fixed_predicate$;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_previous
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname='ledger_close_preflight_v1'
     AND pg_get_function_identity_arguments(p.oid)='p_month date, p_actor_user_id bigint';

  IF v_previous IS NULL THEN
    RAISE EXCEPTION 'BABA preflight function not found';
  END IF;

  -- Fresh migration replay must start at the reviewed pre-patch function version.
  -- If someone already installed the fix manually, do not change the function again.
  IF md5(v_previous)=v_after_hash THEN
    RAISE NOTICE 'BABA preflight already fixed; no function change needed';
    RETURN;
  END IF;
  IF md5(v_previous)<>v_before_hash THEN
    RAISE EXCEPTION 'BABA preflight definition differs from reviewed baseline; abort';
  END IF;
  IF (length(v_previous)-length(replace(v_previous,v_old,'')))<>length(v_old) THEN
    RAISE EXCEPTION 'BABA preflight target predicate not found exactly once; abort';
  END IF;

  EXECUTE replace(v_previous,v_old,v_new);

  SELECT pg_get_functiondef(p.oid)
    INTO v_current
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname='ledger_close_preflight_v1'
     AND pg_get_function_identity_arguments(p.oid)='p_month date, p_actor_user_id bigint';

  IF md5(v_current)<>v_after_hash THEN
    RAISE EXCEPTION 'BABA preflight post-definition hash mismatch; abort';
  END IF;
END;
$baba_preflight_payable_migration$;

COMMIT;
