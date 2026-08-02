begin;

do $preflight$
declare
  v_expected record;
  v_actual record;
  v_count integer;
  v_oid oid;
  v_definition text;
begin
  for v_expected in
    select * from (values
      ('users','id','int8','NO'),('users','role','text','NO'),('users','position','text','YES'),('users','is_active','bool','NO'),('users','is_system_account','bool','NO'),
      ('employee_work_schedule_versions','id','int8','NO'),('employee_work_schedule_versions','user_id','int8','NO'),('employee_work_schedule_versions','start_time','time','NO'),('employee_work_schedule_versions','end_time','time','NO'),('employee_work_schedule_versions','unpaid_break_minutes','int4','NO'),('employee_work_schedule_versions','effective_from','date','NO'),('employee_work_schedule_versions','effective_to','date','YES'),('employee_work_schedule_versions','revision','int8','NO'),('employee_work_schedule_versions','created_by','int8','YES'),
      ('payroll_contract_versions','id','int8','NO'),('payroll_contract_versions','user_id','int8','NO'),('payroll_contract_versions','pay_type','text','NO'),('payroll_contract_versions','calculation_basis','text','NO'),('payroll_contract_versions','base_salary','numeric','NO'),('payroll_contract_versions','fixed_raise_amount','numeric','NO'),('payroll_contract_versions','standard_workdays','numeric','YES'),('payroll_contract_versions','standard_minutes_per_day','int4','NO'),('payroll_contract_versions','time_block_minutes','int4','NO'),('payroll_contract_versions','rounding_mode','text','NO'),('payroll_contract_versions','late_adjustment_mode','text','NO'),('payroll_contract_versions','early_leave_adjustment_mode','text','NO'),('payroll_contract_versions','overtime_mode','text','NO'),('payroll_contract_versions','paid_leave_mode','text','NO'),('payroll_contract_versions','effective_from','date','NO'),('payroll_contract_versions','effective_to','date','YES'),('payroll_contract_versions','revision','int8','NO'),('payroll_contract_versions','created_by','int8','NO'),('payroll_contract_versions','note','text','YES'),
      ('payroll_contract_audit_logs','id','int8','NO'),('payroll_contract_audit_logs','contract_version_id','int8','NO'),('payroll_contract_audit_logs','user_id','int8','NO'),('payroll_contract_audit_logs','action','text','NO'),('payroll_contract_audit_logs','actor_user_id','int8','NO'),('payroll_contract_audit_logs','snapshot','jsonb','NO'),('payroll_contract_audit_logs','reason','text','YES'),('payroll_contract_audit_logs','created_at','timestamptz','NO'),
      ('payroll_runs','id','int8','NO'),('payroll_runs','payroll_month','date','NO'),('payroll_runs','revision','int8','NO'),('payroll_runs','status','text','NO'),('payroll_runs','engine_version','text','NO'),('payroll_runs','source_snapshot','jsonb','NO'),('payroll_runs','created_by','int8','NO'),('payroll_runs','payment_schedule_snapshot','jsonb','NO'),('payroll_runs','insurance_settings_snapshot','jsonb','NO'),('payroll_runs','penalty_settings_snapshot','jsonb','NO'),
      ('payroll_run_employees','id','int8','NO'),('payroll_run_employees','payroll_run_id','int8','NO'),('payroll_run_employees','user_id','int8','NO'),('payroll_run_employees','contract_snapshot','jsonb','NO'),('payroll_run_employees','attendance_snapshot','jsonb','NO'),('payroll_run_employees','insurance_snapshot','jsonb','NO'),
      ('payroll_run_items','id','int8','NO'),('payroll_run_items','payroll_run_employee_id','int8','NO'),('payroll_run_items','amount','int8','NO'),('payroll_run_items','source_snapshot','jsonb','NO'),
      ('payroll_run_reviews','id','int8','NO'),('payroll_run_reviews','payroll_run_employee_id','int8','NO'),('payroll_run_reviews','status','text','NO'),('payroll_run_reviews','amount_delta','int8','NO'),('payroll_run_reviews','source_snapshot','jsonb','NO')
    ) as expected(table_name,column_name,udt_name,is_nullable)
  loop
    select c.udt_name,c.is_nullable into v_actual
    from information_schema.columns c
    where c.table_schema='public' and c.table_name=v_expected.table_name and c.column_name=v_expected.column_name;
    if not found or v_actual.udt_name is distinct from v_expected.udt_name or v_actual.is_nullable is distinct from v_expected.is_nullable then
      raise exception E'PAYROLL_V7_PREFLIGHT_COLUMN_MISMATCH:\npublic.%.%\nexpected=% nullable=%\nactual=% nullable=%',
        v_expected.table_name,v_expected.column_name,v_expected.udt_name,v_expected.is_nullable,
        coalesce(v_actual.udt_name,'MISSING'),coalesce(v_actual.is_nullable,'MISSING');
    end if;
  end loop;

  for v_expected in
    select * from (values
      ('payroll_create_run_v4','public.payroll_create_run_v4(date,timestamp with time zone,text,jsonb,jsonb,bigint)','bigint'),
      ('payroll_recalculate_run_v4','public.payroll_recalculate_run_v4(bigint,timestamp with time zone,text,jsonb,jsonb,bigint)','bigint'),
      ('payroll_resolve_review_v4','public.payroll_resolve_review_v4(bigint,bigint,bigint,text,integer,text,bigint)','void'),
      ('payroll_transition_run_v4','public.payroll_transition_run_v4(bigint,text,text,date,text,text,bigint)','void'),
      ('payroll_create_contract_version_v3','public.payroll_create_contract_version_v3(bigint,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text)','jsonb'),
      ('payroll_correct_latest_unused_contract_v1','public.payroll_correct_latest_unused_contract_v1(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text)','jsonb'),
      ('payroll_assert_actor_v2','public.payroll_assert_actor_v2(bigint)','void')
    ) as expected(function_name,signature,result_type)
  loop
    select count(*) into v_count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=v_expected.function_name;
    v_oid:=to_regprocedure(v_expected.signature);
    if v_count<>1 or v_oid is null then
      raise exception 'PAYROLL_V7_PREFLIGHT_FUNCTION_SIGNATURE_MISMATCH: public.% expected=% overload_count=%',v_expected.function_name,v_expected.signature,v_count;
    end if;
    select pg_get_function_result(p.oid),p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner)
      into v_actual from pg_proc p where p.oid=v_oid;
    if v_actual.pg_get_function_result is distinct from v_expected.result_type
       or v_actual.prosecdef is distinct from true
       or not coalesce(v_actual.proconfig @> array['search_path=public'],false)
       or v_actual.pg_get_userbyid is distinct from 'postgres'
    then raise exception 'PAYROLL_V7_PREFLIGHT_FUNCTION_PROPERTY_MISMATCH: % result=% security_definer=% search_path=% owner=%',
      v_expected.signature,v_actual.pg_get_function_result,v_actual.prosecdef,v_actual.proconfig,v_actual.pg_get_userbyid;
    end if;
  end loop;

  for v_expected in
    select * from (values
      ('payroll_create_contract_version_v4','public.payroll_create_contract_version_v4(bigint,text,numeric,numeric,numeric,date,bigint,text)'),
      ('payroll_correct_latest_unused_contract_v2','public.payroll_correct_latest_unused_contract_v2(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text)')
    ) as expected(function_name,signature)
  loop
    select count(*) into v_count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=v_expected.function_name;
    v_oid:=to_regprocedure(v_expected.signature);
    if v_count>1 or (v_count=1 and v_oid is null) then
      raise exception 'PAYROLL_V7_PREFLIGHT_NEW_FUNCTION_OVERLOAD: public.% expected=% overload_count=%',v_expected.function_name,v_expected.signature,v_count;
    end if;
    if v_oid is not null then
      select pg_get_function_result(p.oid),p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner)
        into v_actual from pg_proc p where p.oid=v_oid;
      if v_actual.pg_get_function_result<>'jsonb' or not v_actual.prosecdef
         or not coalesce(v_actual.proconfig @> array['search_path=public'],false)
         or v_actual.pg_get_userbyid<>'postgres'
      then raise exception 'PAYROLL_V7_PREFLIGHT_NEW_FUNCTION_PROPERTY_MISMATCH: %',v_expected.signature; end if;
    end if;
  end loop;

  for v_expected in
    select * from (values
      ('employee_work_schedule_versions','employee_schedule_no_overlap','EXCLUDE USING gist (user_id WITH =, daterange(effective_from, COALESCE(effective_to, ''infinity''::date), ''[)''::text) WITH &&)'),
      ('employee_work_schedule_versions','employee_schedule_revision_unique','UNIQUE (user_id, revision)'),
      ('payroll_contract_versions','payroll_contract_no_overlap','EXCLUDE USING gist (user_id WITH =, daterange(effective_from, COALESCE(effective_to, ''infinity''::date), ''[)''::text) WITH &&)'),
      ('payroll_contract_versions','payroll_contract_revision_unique','UNIQUE (user_id, revision)'),
      ('payroll_contract_versions','payroll_contract_versions_calculation_basis_check','CHECK ((calculation_basis = ANY (ARRAY[''minute''::text, ''hour''::text, ''day''::text, ''fixed_monthly''::text])))'),
      ('payroll_contract_versions','payroll_contract_versions_pay_type_check','CHECK ((pay_type = ANY (ARRAY[''monthly''::text, ''daily''::text, ''hourly''::text])))'),
      ('payroll_contract_audit_logs','payroll_contract_audit_logs_action_check','CHECK ((action = ANY (ARRAY[''created''::text, ''corrected''::text])))')
    ) as expected(table_name,constraint_name,definition)
  loop
    select pg_get_constraintdef(c.oid) into v_definition
    from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
    where n.nspname='public' and t.relname=v_expected.table_name and c.conname=v_expected.constraint_name;
    if not found or v_definition is distinct from v_expected.definition then
      raise exception E'PAYROLL_V7_PREFLIGHT_CONSTRAINT_MISMATCH:\npublic.% constraint=%\nexpected=%\nactual=%',
        v_expected.table_name,v_expected.constraint_name,v_expected.definition,coalesce(v_definition,'MISSING');
    end if;
  end loop;
end
$preflight$;

do $$
declare
  v_name text;
  v_definition text;
begin
  foreach v_name in array array['payroll_create_run_v4','payroll_recalculate_run_v4','payroll_resolve_review_v4','payroll_transition_run_v4'] loop
    select pg_get_functiondef(p.oid) into v_definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=v_name;
    if v_definition is null then raise exception 'V7_PREFLIGHT_MISSING_FUNCTION: %',v_name; end if;
    if v_name in ('payroll_create_run_v4','payroll_recalculate_run_v4') then
      if position('p_engine_version<>''monthly-payroll-v6''' in v_definition)=0 and position('p_engine_version not in (''monthly-payroll-v6'',''monthly-payroll-v7'')' in v_definition)=0 then raise exception 'V7_PREFLIGHT_UNEXPECTED_FUNCTION: %',v_name; end if;
      v_definition:=replace(v_definition,'p_engine_version<>''monthly-payroll-v6''','p_engine_version not in (''monthly-payroll-v6'',''monthly-payroll-v7'')');
    elsif v_name='payroll_resolve_review_v4' then
      if position('v_run.engine_version<>''monthly-payroll-v6''' in v_definition)=0 and position('v_run.engine_version not in (''monthly-payroll-v6'',''monthly-payroll-v7'')' in v_definition)=0 then raise exception 'V7_PREFLIGHT_UNEXPECTED_FUNCTION: %',v_name; end if;
      v_definition:=replace(v_definition,'v_run.engine_version<>''monthly-payroll-v6''','v_run.engine_version not in (''monthly-payroll-v6'',''monthly-payroll-v7'')');
    else
      if position('v_run.engine_version=''monthly-payroll-v6''' in v_definition)=0 and position('v_run.engine_version in (''monthly-payroll-v6'',''monthly-payroll-v7'')' in v_definition)=0 then raise exception 'V7_PREFLIGHT_UNEXPECTED_FUNCTION: %',v_name; end if;
      v_definition:=replace(v_definition,'v_run.engine_version=''monthly-payroll-v6''','v_run.engine_version in (''monthly-payroll-v6'',''monthly-payroll-v7'')');
    end if;
    execute v_definition;
  end loop;
end $$;

do $$ begin
  if to_regprocedure('public.payroll_create_contract_version_v3(bigint,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text)') is null
     or to_regprocedure('public.payroll_correct_latest_unused_contract_v1(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text)') is null
  then raise exception 'V7_PREFLIGHT_CONTRACT_RPC_SIGNATURE_MISMATCH'; end if;
end $$;

create or replace function public.payroll_create_contract_version_v4(
  p_user_id bigint,p_pay_type text,p_base_salary numeric,p_fixed_raise_amount numeric,
  p_standard_workdays numeric,p_effective_from date,p_actor_user_id bigint,p_note text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_position text;v_schedule public.employee_work_schedule_versions%rowtype;v_minutes integer;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);
  perform pg_advisory_xact_lock(p_user_id);
  select lower(coalesce(position,'')) into v_position from public.users where id=p_user_id and is_active and not is_system_account;
  if not found then return jsonb_build_object('status','user_not_found');end if;
  if v_position='owner' then
    return public.payroll_create_contract_version_v3(p_user_id,'monthly','fixed_monthly',p_base_salary,p_fixed_raise_amount,p_standard_workdays,540,1,'none','ignore','ignore','ignore','unpaid',p_effective_from,p_actor_user_id,p_note);
  end if;
  if (select count(*) from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from))=0 then return jsonb_build_object('status','work_schedule_not_found');end if;
  if (select count(*) from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from))>1 then return jsonb_build_object('status','work_schedule_overlap');end if;
  select * into strict v_schedule from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from);
  v_minutes:=((extract(hour from v_schedule.end_time)::integer*60+extract(minute from v_schedule.end_time)::integer)-(extract(hour from v_schedule.start_time)::integer*60+extract(minute from v_schedule.start_time)::integer)+1440)%1440-v_schedule.unpaid_break_minutes;
  if v_minutes<=0 then return jsonb_build_object('status','invalid_work_schedule');end if;
  return public.payroll_create_contract_version_v3(p_user_id,p_pay_type,'minute',p_base_salary,p_fixed_raise_amount,p_standard_workdays,v_minutes,1,'none','ignore','ignore','requires_approval','unpaid',p_effective_from,p_actor_user_id,p_note);
end $$;

revoke all on function public.payroll_create_contract_version_v4(bigint,text,numeric,numeric,numeric,date,bigint,text) from public,anon,authenticated;
grant execute on function public.payroll_create_contract_version_v4(bigint,text,numeric,numeric,numeric,date,bigint,text) to service_role;

comment on function public.payroll_create_contract_version_v4(bigint,text,numeric,numeric,numeric,date,bigint,text) is 'Creates unified-engine contracts and snapshots the effective employee schedule. monthly-payroll-v7.';

create or replace function public.payroll_correct_latest_unused_contract_v2(
  p_contract_id bigint,p_user_id bigint,p_expected_revision bigint,p_expected_audit_log_id bigint,p_expected_effective_from date,
  p_pay_type text,p_base_salary numeric,p_fixed_raise_amount numeric,p_standard_workdays numeric,
  p_effective_from date,p_actor_user_id bigint,p_note text,p_reason text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_position text;v_schedule public.employee_work_schedule_versions%rowtype;v_minutes integer;v_basis text;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);
  perform pg_advisory_xact_lock(p_user_id);
  select lower(coalesce(position,'')) into v_position from public.users where id=p_user_id and is_active and not is_system_account;
  if not found then return jsonb_build_object('status','user_not_found');end if;
  if v_position='owner' then v_minutes:=540;v_basis:='fixed_monthly';
  else
    v_basis:='minute';
    if (select count(*) from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from))=0 then return jsonb_build_object('status','work_schedule_not_found');end if;
    if (select count(*) from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from))>1 then return jsonb_build_object('status','work_schedule_overlap');end if;
    select * into strict v_schedule from public.employee_work_schedule_versions where user_id=p_user_id and effective_from<=p_effective_from and (effective_to is null or effective_to>p_effective_from);
    v_minutes:=((extract(hour from v_schedule.end_time)::integer*60+extract(minute from v_schedule.end_time)::integer)-(extract(hour from v_schedule.start_time)::integer*60+extract(minute from v_schedule.start_time)::integer)+1440)%1440-v_schedule.unpaid_break_minutes;
    if v_minutes<=0 then return jsonb_build_object('status','invalid_work_schedule');end if;
  end if;
  return public.payroll_correct_latest_unused_contract_v1(p_contract_id,p_user_id,p_expected_revision,p_expected_audit_log_id,p_expected_effective_from,p_pay_type,v_basis,p_base_salary,p_fixed_raise_amount,p_standard_workdays,v_minutes,1,'none','ignore','ignore',case when v_position='owner' then 'ignore' else 'requires_approval' end,'unpaid',p_effective_from,p_actor_user_id,p_note,p_reason);
end $$;

revoke all on function public.payroll_correct_latest_unused_contract_v2(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) from public,anon,authenticated;
grant execute on function public.payroll_correct_latest_unused_contract_v2(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) to service_role;
comment on function public.payroll_correct_latest_unused_contract_v2(bigint,bigint,bigint,bigint,date,text,numeric,numeric,numeric,date,bigint,text,text) is 'Corrects the latest unused contract and re-snapshots the effective employee schedule atomically.';

commit;
