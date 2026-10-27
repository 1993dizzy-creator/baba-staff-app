-- Replacement for the failed, UNAPPLIED 20261027160650 patch. Preserve that file
-- as historical evidence; execute this after 20261027112354 INSTEAD of it.
-- Normalize the definition and both dollar-quoted blocks identically. No DML.
do $fix_reclose_lock_order$
declare
  v_oid regprocedure := to_regprocedure('public.ledger_aug_sep_reclose_corrections_v1(date,bigint,bigint)');
  v_hash text;
  v_definition text;
  v_old_normalized text;
  v_new_normalized text;
  v_old constant text := $old$  -- Deliberately conservative for this one-time maintenance operation. Prevent
  -- non-cooperating writers changing source rows or adding phantom movements.
  -- Stop other ledger writers first; lock_timeout/deadlocks must roll back.
  lock table public.ledger_transactions in share row exclusive mode;
  lock table public.ledger_movements in share mode;
  lock table public.payroll_payment_batches in share mode;
  lock table public.ledger_recurring_expense_plans in share mode;

  select * into v_plan from public.ledger_recurring_expense_plans where id=p_rent_plan_id;
  if v_plan.id is null or v_plan.category_id is distinct from 3
    or v_plan.amount is distinct from 50000000 or v_plan.recognition_day is distinct from 1
    or v_plan.effective_from is distinct from date '2026-08-01'
    or v_plan.effective_to is not null or v_plan.frequency is distinct from 'monthly'
    or v_plan.source_key_prefix is distinct from 'store-rent' or v_plan.is_active is distinct from true
    or (select count(*) from public.ledger_recurring_expense_plans
      where is_active and frequency='monthly' and effective_from<=p_month
      and (effective_to is null or effective_to>=p_month)) <> 1 then
    raise exception 'RECLOSE_RENT_PLAN_DRIFT';
  end if;
$old$;
  v_new constant text := $new$  -- Plan writers take this prefix lock before updating plan rows. Freeze the
  -- plan set before validating it, so sync can never discover another prefix
  -- only after the transaction table has been locked.
  perform pg_advisory_xact_lock(hashtext('ledger_recurring_plan:store-rent'));
  lock table public.ledger_recurring_expense_plans in share mode;

  select * into v_plan from public.ledger_recurring_expense_plans where id=p_rent_plan_id;
  if v_plan.id is null or v_plan.category_id is distinct from 3
    or v_plan.amount is distinct from 50000000 or v_plan.recognition_day is distinct from 1
    or v_plan.effective_from is distinct from date '2026-08-01'
    or v_plan.effective_to is not null or v_plan.frequency is distinct from 'monthly'
    or v_plan.source_key_prefix is distinct from 'store-rent' or v_plan.is_active is distinct from true
    or (select count(*) from public.ledger_recurring_expense_plans
      where is_active and frequency='monthly' and effective_from<=p_month
      and (effective_to is null or effective_to>=p_month)) <> 1 then
    raise exception 'RECLOSE_RENT_PLAN_DRIFT';
  end if;
  -- R1 takes its per-prefix/month advisory lock before touching transactions.
  -- Match that order; nested R1 sync re-enters the same transaction-owned lock.
  perform pg_advisory_xact_lock(hashtext('ledger_recurring:store-rent:'||to_char(p_month,'YYYY-MM')));
  lock table public.ledger_transactions in share row exclusive mode;
  lock table public.ledger_movements in share mode;
  lock table public.payroll_payment_batches in share mode;

$new$;
begin
  if v_oid is null then raise exception 'RECLOSE_LOCK_ORDER_ORIGINAL_FUNCTION_MISSING'; end if;
  select md5(regexp_replace(prosrc,'\s+','','g')) into v_hash from pg_proc where oid=v_oid;
  if v_hash='beebd06ff35eb3eaf0a68dfde8494412' then return; end if;
  if v_hash is distinct from '5429554141424f2fa75aa3492350eb2c' then
    raise exception 'RECLOSE_LOCK_ORDER_FUNCTION_DRIFT';
  end if;
  v_definition := replace(replace(pg_get_functiondef(v_oid),E'\r\n',E'\n'),E'\r',E'\n');
  v_old_normalized := replace(replace(v_old,E'\r\n',E'\n'),E'\r',E'\n');
  v_new_normalized := replace(replace(v_new,E'\r\n',E'\n'),E'\r',E'\n');
  if strpos(v_definition,v_old_normalized)=0 then raise exception 'RECLOSE_LOCK_ORDER_PATCH_NOT_FOUND'; end if;
  execute replace(v_definition,v_old_normalized,v_new_normalized);
  if (select md5(regexp_replace(prosrc,'\s+','','g')) from pg_proc where oid=v_oid)
    is distinct from 'beebd06ff35eb3eaf0a68dfde8494412' then
    raise exception 'RECLOSE_LOCK_ORDER_PATCH_FAILED';
  end if;
end;
$fix_reclose_lock_order$;
