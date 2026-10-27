-- REVIEW ONLY. After the user confirms installation and GPT verifies approved/executed SQL.
-- No function DDL, accounting DML or unrelated history repair is performed here.
-- Run the WHOLE file. On error ROLLBACK. Repeating identical registration is a no-op.
-- Register only 20261027112354 and 20261027175537, never retired 20261027160650.
-- 20261027112354 aug_sep_reclose_corrections; normalized-LF SHA256 1afa18682ea2b407691ff9190e65b3aeaeace98ccfd8ab752e900d1fe1ed9b63
-- 20261027175537 reclose_patch_line_endings; normalized-LF SHA256 8de4012ac67dd7d7aedeca0fa755db6aef85d0b8006c1924de8422815cca282d
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(hashtext('baba_m_stage_install'));
select pg_advisory_xact_lock(hashtext('baba_migration_history:20261027112354'));
select pg_advisory_xact_lock(hashtext('baba_migration_history:20261027160650'));
select pg_advisory_xact_lock(hashtext('baba_migration_history:20261027175537'));

do $m_stage_retired_guard$
begin
  if exists(select 1 from supabase_migrations.schema_migrations where version in('20261027160650')) then
    raise exception 'M_STAGE_RETIRED_VERSION_PRESENT';
  end if;
end;
$m_stage_retired_guard$;
do $m_stage_verify$
declare v pg_catalog.pg_proc%rowtype;
begin
  select * into v from pg_catalog.pg_proc where oid=to_regprocedure('public.ledger_aug_sep_reclose_corrections_v1(date,bigint,bigint)');
  if v.oid is null or md5(regexp_replace(v.prosrc,'\s+','','g')) is distinct from 'beebd06ff35eb3eaf0a68dfde8494412'
    or pg_get_userbyid(v.proowner)<>'postgres' or not v.prosecdef
    or v.prorettype<>'jsonb'::regtype
    or v.proargnames is distinct from array['p_month','p_rent_plan_id','p_actor_user_id']::text[]
    or not coalesce(v.proconfig @> array['search_path=pg_catalog, public','lock_timeout=5s']::text[],false)
    or exists(select 1 from aclexplode(coalesce(v.proacl,acldefault('f',v.proowner))) a
      where a.privilege_type='EXECUTE' and a.grantee not in(v.proowner,(select oid from pg_roles where rolname='service_role')))
    or has_function_privilege('anon',v.oid,'EXECUTE')
    or has_function_privilege('authenticated',v.oid,'EXECUTE')
    or not has_function_privilege('service_role',v.oid,'EXECUTE') then
    raise exception 'M_STAGE_FINAL_FUNCTION_INVALID';
  end if;
end;
$m_stage_verify$;

do $m_stage_history$
declare v record;v_actual record;
begin
  for v in select * from (values ('20261027112354','aug_sep_reclose_corrections',array[replace(replace($source_20261027112354$-- Installation only. No ledger data is changed until this function is invoked.
-- Invoke only after separate operational approval, with a short lock_timeout.
-- Each month combines C1/C2/C3 and R1 in one atomic statement.
create function public.ledger_aug_sep_reclose_corrections_v1(
  p_month date, p_rent_plan_id bigint, p_actor_user_id bigint
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public
set lock_timeout='5s' as $$
declare
  v_original public.ledger_transactions%rowtype;
  v_existing public.ledger_transactions%rowtype;
  v_plan public.ledger_recurring_expense_plans%rowtype;
  v_batch public.payroll_payment_batches%rowtype;
  v_spec record;
  v_snapshot jsonb;
  v_id bigint;
  v_created integer := 0;
  v_sync jsonb;
  v_reason text;
begin
  if not exists(select 1 from public.users where id=p_actor_user_id
    and lower(role::text) in ('owner','master') and is_active and app_login_enabled) then
    return jsonb_build_object('status','forbidden');
  end if;
  if p_month is null or p_month not in (date '2026-08-01', date '2026-09-01') then
    raise exception 'RECLOSE_INVALID_MONTH';
  end if;
  -- Match close/reopen lock order. All calls, including retries, respect closure.
  perform pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));
  perform pg_advisory_xact_lock(hashtext('ledger_month_close'),hashtext(p_month::text));
  perform 1 from public.ledger_month_closures where month=p_month for update;
  perform public.ledger_assert_month_open_v1(p_month);
  -- Deliberately conservative for this one-time maintenance operation. Prevent
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
  select * into v_batch from public.payroll_payment_batches where id=3;
  if v_batch.id is null or v_batch.status is distinct from 'completed'
    or v_batch.payroll_month is distinct from date '2026-09-01'
    or v_batch.insurance_remittance_total is distinct from 12428000
    or v_batch.employee_insurance_total is distinct from 3192000
    or v_batch.employer_insurance_total is distinct from 6536000
    or v_batch.director_insurance_amount is distinct from 2700000
    or v_batch.actual_company_cost_total is distinct from 176185794
    or not exists(select 1 from public.ledger_transactions where id=2752
      and status='confirmed' and type='expense_recognition' and economic_effect_sign=1
      and recognition_month=date '2026-09-01' and amount=v_batch.actual_company_cost_total
      and source_type='payroll_completed_batch' and source_key='payroll-batch:3:company-cost'
      and source_snapshot @> '{"batch_id":3,"insurance_remittance_total":12428000}'::jsonb) then
    raise exception 'RECLOSE_PAYROLL_DRIFT';
  end if;

  -- Validate every source before writing, even when applying August alone.
  for v_spec in select * from (values
    (1055::bigint,date '2026-08-01',196211473.5::numeric,4::bigint,60000000::numeric,
      'legacy_sheet_expense_detail_offset:2026-08:rent'),
    (2191,date '2026-09-01',9728000,75,9728000,
      'payroll_insurance_duplicate_offset:2026-09:2191'),
    (2192,date '2026-09-01',2700000,75,2700000,
      'payroll_insurance_duplicate_offset:2026-09:2192')
  ) s(original_id,month,original_amount,category_id,offset_amount,source_key) loop
    select * into v_original from public.ledger_transactions where id=v_spec.original_id;
    if v_original.id is null or v_original.status is distinct from 'confirmed'
      or v_original.type is distinct from 'expense' or v_original.economic_effect_sign is distinct from 1
      or v_original.amount is distinct from v_spec.original_amount
      or v_original.category_id is distinct from v_spec.category_id
      or v_original.recognition_month is distinct from v_spec.month then
      raise exception 'RECLOSE_SOURCE_DRIFT: %',v_spec.original_id;
    end if;
    if v_spec.original_id=1055 then
      if (v_original.source_snapshot @> '{"sheetCashOutflow":778924465,"annualRentPrepaymentPaidInAugust":300000000,"augustRentExpenseRecognition":60000000,"sheetAccountingExpense":538924465}'::jsonb) is not true
        or exists(select 1 from public.ledger_movements where transaction_id=1055) then
        raise exception 'RECLOSE_LEGACY_RENT_DRIFT';
      end if;
    elsif (select count(*) from public.ledger_movements where transaction_id=v_spec.original_id) <> 1
      or not exists(select 1 from public.ledger_movements m join public.ledger_fund_accounts f on f.id=m.fund_account_id
        where m.transaction_id=v_spec.original_id and f.code='baba_corporate_bank'
          and m.amount=-v_spec.original_amount) then
      raise exception 'RECLOSE_INSURANCE_PAYMENT_DRIFT: %',v_spec.original_id;
    end if;
  end loop;

  for v_spec in select * from (values
    (1055::bigint,date '2026-08-01',4::bigint,60000000::numeric,'legacy_sheet_expense_detail_offset:2026-08:rent'),
    (2191,date '2026-09-01',75,9728000,'payroll_insurance_duplicate_offset:2026-09:2191'),
    (2192,date '2026-09-01',75,2700000,'payroll_insurance_duplicate_offset:2026-09:2192')
  ) s(original_id,month,category_id,offset_amount,source_key) where month=p_month loop
    select * into v_original from public.ledger_transactions where id=v_spec.original_id;
    v_reason := case when v_spec.original_id=1055
      then 'C1: offset legacy August rent 60M; recognize contract rent 50M through R1; preserve prepaid and reserves'
      else 'C2/C3: offset insurance already included in payroll batch 3; preserve original bank payment' end;
    v_snapshot := jsonb_build_object('correctionSet','aug-sep-reclose-v1',
      'originalTransactionId',v_original.id,'economicDelta',-v_spec.offset_amount,
      'recognitionMonth',p_month,'movementAdjustments','[]'::jsonb);
    select * into v_existing from public.ledger_transactions
      where source_type='ledger_correction' and source_key=v_spec.source_key;
    if v_existing.id is not null then
      if v_existing.type is distinct from 'expense' or v_existing.status is distinct from 'confirmed'
        or v_existing.amount is distinct from v_spec.offset_amount
        or v_existing.category_id is distinct from v_spec.category_id
        or v_existing.economic_effect_sign is distinct from -1
        or v_existing.correction_of_id is distinct from v_original.id
        or v_existing.party_id is distinct from v_original.party_id
        or v_existing.recognition_month is distinct from p_month
        or v_existing.business_date is distinct from (p_month+interval '1 month - 1 day')::date
        or v_existing.source_snapshot is distinct from v_snapshot
        or v_existing.source_fingerprint is distinct from md5(v_snapshot::text)
        or v_existing.source_synced_at is null
        or exists(select 1 from public.ledger_movements where transaction_id=v_existing.id)
        or (select count(*) from public.ledger_audit_logs where action='correction_created'
          and entity_type='transaction' and entity_id=v_existing.id
          and before_snapshot=to_jsonb(v_original)
          and after_snapshot @> jsonb_build_object('economicDelta',-v_spec.offset_amount,
            'correctionTransactionId',v_existing.id)) <> 1 then
        raise exception 'RECLOSE_EXISTING_CORRECTION_DRIFT: %',v_spec.source_key;
      end if;
    else
      insert into public.ledger_transactions(operation_id,type,occurred_at,business_date,
        recognition_month,amount,category_id,party_id,status,source_type,source_key,source_snapshot,
        source_fingerprint,source_synced_at,correction_of_id,memo,created_by,confirmed_by,economic_effect_sign)
      values(gen_random_uuid(),'expense',((p_month+interval '1 month - 1 day')::date+time '03:00') at time zone 'Asia/Ho_Chi_Minh',
        (p_month+interval '1 month - 1 day')::date,p_month,v_spec.offset_amount,v_spec.category_id,
        v_original.party_id,'confirmed','ledger_correction',v_spec.source_key,v_snapshot,
        md5(v_snapshot::text),now(),v_original.id,v_reason,p_actor_user_id,p_actor_user_id,-1)
      returning id into v_id;
      insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
      values(p_actor_user_id,'correction_created','transaction',v_id,to_jsonb(v_original),
        v_snapshot||jsonb_build_object('correctionTransactionId',v_id),v_reason);
      v_created:=v_created+1;
    end if;
  end loop;

  v_sync:=public.ledger_sync_recurring_expenses_v2(p_month,p_actor_user_id);
  if v_sync->>'status' is distinct from 'ok' or coalesce((v_sync->>'closedMonth')::boolean,false)
    or (v_sync->>'totalRecognizedExpense')::numeric is distinct from 50000000
    or coalesce((v_sync->>'cancelledCount')::integer,0)<>0 then
    raise exception 'RECLOSE_RENT_SYNC_FAILED: %',v_sync;
  end if;
  -- Verify actual row values as well: legacy sync trusts matching fingerprints.
  if not exists(select 1 from public.ledger_transactions where source_type='recurring_expense'
    and source_key='recurring:'||p_rent_plan_id||':'||to_char(p_month,'YYYY-MM')
    and type='expense_recognition' and status='confirmed' and amount=50000000
    and category_id=3 and economic_effect_sign=1 and recognition_month=p_month and business_date=p_month
    and not exists(select 1 from public.ledger_movements m where m.transaction_id=ledger_transactions.id)) then
    raise exception 'RECLOSE_RENT_ROW_DRIFT';
  end if;
  return jsonb_build_object('status','ok','month',p_month,'correctionsCreated',v_created,'recurring',v_sync);
end$$;
alter function public.ledger_aug_sep_reclose_corrections_v1(date,bigint,bigint) owner to postgres;
revoke all on function public.ledger_aug_sep_reclose_corrections_v1(date,bigint,bigint) from public,anon,authenticated;
grant execute on function public.ledger_aug_sep_reclose_corrections_v1(date,bigint,bigint) to service_role;
$source_20261027112354$,E'\r\n',E'\n'),E'\r',E'\n')]::text[]),
('20261027175537','reclose_patch_line_endings',array[replace(replace($source_20261027175537$-- Replacement for the failed, UNAPPLIED 20261027160650 patch. Preserve that file
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
$source_20261027175537$,E'\r\n',E'\n'),E'\r',E'\n')]::text[])) expected(version,name,statements) loop
    select name,statements into v_actual from supabase_migrations.schema_migrations where version=v.version for update;
    if found and (v_actual.name is distinct from v.name or v_actual.statements is distinct from v.statements) then
      raise exception 'M_STAGE_HISTORY_CONTENT_MISMATCH: %',v.version;
    end if;
    insert into supabase_migrations.schema_migrations(version,name,statements)
    values(v.version,v.name,v.statements) on conflict(version) do nothing;
    select name,statements into v_actual from supabase_migrations.schema_migrations where version=v.version;
    if v_actual.name is distinct from v.name or v_actual.statements is distinct from v.statements then
      raise exception 'M_STAGE_HISTORY_CONTENT_MISMATCH: %',v.version;
    end if;
  end loop;
end;
$m_stage_history$;
commit;
