-- Selected-employee payment safety. No table/data/amount/hash/ledger rewrite.
-- Keep v3 -> v2 -> v1, existing roster uniqueness, tax totals and ledger paths.
begin;

-- Every participating path acquires ALL payroll month gates (sorted), then ALL
-- ledger month gates (sorted), before employee/contract/row locks. Salary month
-- and actual payment-date month remain distinct; taking a lock never closes a month.
create function public.payroll_lock_months_v1(p_dates date[]) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare m date; months date[];
begin
  select array_agg(value order by value) into months from
    (select distinct date_trunc('month',d)::date value from unnest(p_dates) d where d is not null) q;
  foreach m in array coalesce(months,'{}'::date[]) loop
    perform pg_advisory_xact_lock(82118,extract(year from m)::integer*100+extract(month from m)::integer);
  end loop;
  foreach m in array coalesce(months,'{}'::date[]) loop
    perform pg_advisory_xact_lock(hashtext('ledger_month_close:'||to_char(m,'YYYY-MM')));
  end loop;
end $$;
revoke all on function public.payroll_lock_months_v1(date[]) from public,anon,authenticated,service_role;

do $safety$
declare v_definition text;v_old text;v_new text;
begin
  v_definition:=replace(pg_get_functiondef('public.payroll_pay_employee_v1(date,jsonb,bigint,jsonb,text,bigint,bigint,text,date,bigint,text,jsonb,bigint)'::regprocedure),E'\r\n',E'\n');
  v_old:=$old$  if p_month<>date_trunc('month',p_month)::date or jsonb_typeof(p_targets)<>'array' or jsonb_array_length(p_targets)=0 then raise exception 'PAYROLL_INVALID_PAYMENT_REQUEST' using errcode='22023';end if;$old$;
  v_new:=$new$  if p_month is null or p_month<>date_trunc('month',p_month)::date or p_user_id is null or p_user_id<=0
     or jsonb_typeof(p_targets) is distinct from 'array' then
    raise exception 'PAYROLL_INVALID_PAYMENT_REQUEST' using errcode='22023';
  end if;
  if jsonb_array_length(p_targets)=0 then raise exception 'PAYROLL_INVALID_PAYMENT_REQUEST' using errcode='22023';end if;
  for v_target in select value from jsonb_array_elements(p_targets) loop
    if jsonb_typeof(v_target) is distinct from 'object'
      or jsonb_typeof(v_target->'userId') is distinct from 'number'
      or coalesce(v_target->>'userId','')!~'^[1-9][0-9]{0,15}$'
      or jsonb_typeof(v_target->'employeeName') is distinct from 'string'
      or nullif(btrim(v_target->>'employeeName'),'') is null
      or jsonb_typeof(v_target->'isPayable') is distinct from 'boolean'
      or jsonb_typeof(v_target->'failureCodes') is distinct from 'array' then
      raise exception 'PAYROLL_INVALID_PAYMENT_REQUEST' using errcode='22023';
    end if;
    if (v_target->>'userId')::numeric>9007199254740991
      or exists(select 1 from jsonb_array_elements(v_target->'failureCodes') c where jsonb_typeof(c)<>'string') then
      raise exception 'PAYROLL_INVALID_PAYMENT_REQUEST' using errcode='22023';
    end if;
  end loop;
  if (select count(distinct (value->>'userId')::bigint) from jsonb_array_elements(p_targets))<>jsonb_array_length(p_targets)
    or not exists(select 1 from jsonb_array_elements(p_targets) where (value->>'userId')::bigint=p_user_id) then
    raise exception 'PAYROLL_INVALID_PAYMENT_REQUEST' using errcode='22023';
  end if;$new$;
  if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
    raise exception 'PAYROLL_SAFETY_CONTRACT_MISMATCH: public.payroll_pay_employee_v1';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  v_old:=$old$  if exists(select 1 from jsonb_array_elements(p_targets) as target(value) where coalesce((target.value->>'isPayable')::boolean,false)=false or jsonb_array_length(coalesce(target.value->'failureCodes','[]'::jsonb))>0) then raise exception 'PAYROLL_BATCH_PREFLIGHT_FAILED' using errcode='55000';end if;$old$;
  v_new:=$new$  -- Only the selected employee is assessed; every roster member is retained.$new$;
  if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
    raise exception 'PAYROLL_SAFETY_CONTRACT_MISMATCH: public.payroll_pay_employee_v1';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  v_old:=$old$  if p_actual_paid_amount<=0 or p_calculated_net_amount is null$old$;
  v_new:=$new$  if p_actual_paid_amount is null or p_actual_paid_amount<=0 or p_calculated_net_amount is null or p_calculated_net_amount<0$new$;
  if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
    raise exception 'PAYROLL_SAFETY_CONTRACT_MISMATCH: public.payroll_pay_employee_v1';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  v_old:=$old$  perform pg_advisory_xact_lock(82119,p_user_id::integer);$old$;
  v_new:=$new$  if (select count(*) from public.payroll_employee_payments where payroll_batch_id=v_run.id)<>jsonb_array_length(p_targets)
    or exists(select 1 from jsonb_array_elements(p_targets) t where not exists(
      select 1 from public.payroll_employee_payments p where p.payroll_batch_id=v_run.id and p.user_id=(t->>'userId')::bigint)) then
    raise exception 'PAYROLL_BATCH_TARGET_MISMATCH' using errcode='55000';
  end if;
  perform pg_advisory_xact_lock(82119,p_user_id::integer);$new$;
  if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
    raise exception 'PAYROLL_SAFETY_CONTRACT_MISMATCH: public.payroll_pay_employee_v1';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  v_old:=$old$  if v_employee.payment_status='paid' then raise exception 'PAYROLL_EMPLOYEE_ALREADY_PAID' using errcode='23505';end if;$old$;
  v_new:=$new$  if v_employee.payment_status='paid' then raise exception 'PAYROLL_EMPLOYEE_ALREADY_PAID' using errcode='23505';end if;
  select value into strict v_target from jsonb_array_elements(p_targets) where (value->>'userId')::bigint=p_user_id;
  if (v_target->>'isPayable')::boolean is not true or jsonb_array_length(v_target->'failureCodes')>0 then
    raise exception 'PAYROLL_BATCH_PREFLIGHT_FAILED' using errcode='55000';
  end if;$new$;
  if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
    raise exception 'PAYROLL_SAFETY_CONTRACT_MISMATCH: public.payroll_pay_employee_v1';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  execute v_definition;
end;
$safety$;

do $safety$
declare v_definition text;v_old text;v_new text;
begin
  v_definition:=replace(pg_get_functiondef('public.payroll_pay_employee_v3(date,jsonb,bigint,jsonb,text,bigint,bigint,text,date,bigint,bigint,text,jsonb,bigint)'::regprocedure),E'\r\n',E'\n');
  v_old:=$old$  perform public.payroll_assert_actor_v2(p_actor_user_id);$old$;
  v_new:=$new$  perform public.payroll_assert_actor_v2(p_actor_user_id);
  perform public.payroll_lock_months_v1(array[p_month,p_payment_date]);$new$;
  if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
    raise exception 'PAYROLL_SAFETY_CONTRACT_MISMATCH: public.payroll_pay_employee_v3';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  execute v_definition;
end;
$safety$;

do $safety$
declare v_definition text;v_old text;v_new text;
begin
  v_definition:=replace(pg_get_functiondef('public.payroll_cancel_employee_payment_v3(bigint,bigint,text,bigint)'::regprocedure),E'\r\n',E'\n');
  v_old:=$old$  v_status text;$old$;
  v_new:=$new$  v_status text;
  v_lock_payment_month date;$new$;
  if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
    raise exception 'PAYROLL_SAFETY_CONTRACT_MISMATCH: public.payroll_cancel_employee_payment_v3';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  v_old:=$old$  perform public.payroll_assert_actor_v2(p_actor_user_id);$old$;
  v_new:=$new$  perform public.payroll_assert_actor_v2(p_actor_user_id);
  select b.payroll_month,date_trunc('month',p.payment_date)::date into v_month,v_lock_payment_month
    from public.payroll_employee_payments p join public.payroll_payment_batches b on b.id=p.payroll_batch_id
    where p.payroll_batch_id=p_run_id and p.user_id=p_user_id and p.payment_status='paid';
  perform public.payroll_lock_months_v1(array[v_month,v_lock_payment_month]);$new$;
  if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
    raise exception 'PAYROLL_SAFETY_CONTRACT_MISMATCH: public.payroll_cancel_employee_payment_v3';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  v_old:=$old$  v_result := public.payroll_cancel_employee_payment_v2($old$;
  v_new:=$new$  if date_trunc('month',v_payment_date)::date is distinct from v_lock_payment_month then
    raise exception 'PAYROLL_PAYMENT_STATE_STALE' using errcode='55000';
  end if;
  v_result := public.payroll_cancel_employee_payment_v2($new$;
  if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
    raise exception 'PAYROLL_SAFETY_CONTRACT_MISMATCH: public.payroll_cancel_employee_payment_v3';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  execute v_definition;
end;
$safety$;

do $safety$
declare v_definition text;v_old text;v_new text;
begin
  v_definition:=replace(pg_get_functiondef('public.ledger_close_month_v1(date,text,jsonb,jsonb,text,bigint)'::regprocedure),E'\r\n',E'\n');
  v_old:=$old$  perform pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));$old$;
  v_new:=$new$  perform public.payroll_lock_months_v1(array[v_month]);
  perform pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));$new$;
  if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
    raise exception 'PAYROLL_SAFETY_CONTRACT_MISMATCH: public.ledger_close_month_v1';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  execute v_definition;
end;
$safety$;

-- Reopening keeps the same global-close serialization and per-month/row locks.
-- Joining the common gates first also keeps an explicit, audited recovery path
-- ordered consistently with close, payment and policy mutations.
do $safety$
declare v_definition text;v_old text;v_new text;
begin
  v_definition:=replace(pg_get_functiondef('public.ledger_reopen_month_v1(date,text,bigint)'::regprocedure),E'\r\n',E'\n');
  v_old:=$old$  perform pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));$old$;
  v_new:=$new$  perform public.payroll_lock_months_v1(array[v_month]);
  perform pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));$new$;
  if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
    raise exception 'PAYROLL_SAFETY_CONTRACT_MISMATCH: public.ledger_reopen_month_v1';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  execute v_definition;
end;
$safety$;

do $safety$
declare v_definition text;v_old text;v_new text;
begin
  v_definition:=replace(pg_get_functiondef('public.employee_create_with_proration_v1(jsonb,boolean,text,date,boolean,text,bigint,text)'::regprocedure),E'\r\n',E'\n');
  v_old:=$old$  if v_date is null or v_date < date '2026-08-01'$old$;
  v_new:=$new$  perform public.payroll_lock_months_v1(array[v_date]);
  if v_date is null or v_date < date '2026-08-01'$new$;
  if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
    raise exception 'PAYROLL_SAFETY_CONTRACT_MISMATCH: public.employee_create_with_proration_v1';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  execute v_definition;
end;
$safety$;

do $safety$
declare v_definition text;v_old text;v_new text;
begin
  v_definition:=replace(pg_get_functiondef('public.payroll_link_first_month_contract_v1(bigint,numeric,numeric,numeric,date,bigint)'::regprocedure),E'\r\n',E'\n');
  v_old:=$old$  perform pg_advisory_xact_lock(p_user_id);$old$;
  v_new:=$new$  perform public.payroll_lock_months_v1(array[(select hire_date from public.payroll_first_month_policies where user_id=p_user_id)]);
  perform pg_advisory_xact_lock(p_user_id);$new$;
  if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
    raise exception 'PAYROLL_SAFETY_CONTRACT_MISMATCH: public.payroll_link_first_month_contract_v1';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  execute v_definition;
end;
$safety$;

do $safety$
declare v_definition text;v_old text;v_new text;
begin
  v_definition:=replace(pg_get_functiondef('public.payroll_correct_first_month_hire_date_v1(bigint,date,date,text,bigint)'::regprocedure),E'\r\n',E'\n');
  v_old:=$old$  perform pg_advisory_xact_lock(p_user_id);$old$;
  v_new:=$new$  perform public.payroll_lock_months_v1(array[(select hire_date from public.payroll_first_month_policies where user_id=p_user_id)]);
  perform pg_advisory_xact_lock(p_user_id);$new$;
  if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
    raise exception 'PAYROLL_SAFETY_CONTRACT_MISMATCH: public.payroll_correct_first_month_hire_date_v1';
  end if;
  v_definition:=replace(v_definition,v_old,v_new);
  execute v_definition;
end;
$safety$;

commit;
