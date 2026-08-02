begin;

do $$
declare
  v_missing text[] := array[]::text[];
  v_type_mismatches text[] := array[]::text[];
  v_required record;
  v_actual_type text;
  v_function_oid oid;
  v_function_count integer;
  v_function_config text[];
  v_function_result text;
  v_function_security_definer boolean;
  v_audit_action_definition text;
begin
  if to_regclass('public.users') is null then v_missing := array_append(v_missing, 'public.users'); end if;
  if to_regclass('public.payroll_contract_versions') is null then v_missing := array_append(v_missing, 'public.payroll_contract_versions'); end if;
  if to_regclass('public.payroll_contract_audit_logs') is null then v_missing := array_append(v_missing, 'public.payroll_contract_audit_logs'); end if;
  if to_regclass('public.payroll_runs') is null then v_missing := array_append(v_missing, 'public.payroll_runs'); end if;
  if to_regclass('public.payroll_run_employees') is null then v_missing := array_append(v_missing, 'public.payroll_run_employees'); end if;
  if to_regclass('public.payroll_run_items') is null then v_missing := array_append(v_missing, 'public.payroll_run_items'); end if;
  if to_regclass('public.payroll_run_reviews') is null then v_missing := array_append(v_missing, 'public.payroll_run_reviews'); end if;
  if to_regprocedure('public.payroll_create_contract_version_v3(bigint,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text)') is null then
    v_missing := array_append(v_missing, 'public.payroll_create_contract_version_v3');
  end if;
  if array_length(v_missing, 1) is not null then
    raise exception 'PAYROLL_CONTRACT_CORRECTION_PREFLIGHT_MISSING_OBJECTS: %', array_to_string(v_missing, ', ');
  end if;
  for v_required in
    select * from (values
      ('users', 'id', 'bigint'),
      ('users', 'is_active', 'boolean'),
      ('users', 'is_system_account', 'boolean'),
      ('users', 'role', 'text'),
      ('users', 'position', 'text'),
      ('payroll_contract_versions', 'id', 'bigint'),
      ('payroll_contract_versions', 'user_id', 'bigint'),
      ('payroll_contract_versions', 'revision', 'bigint'),
      ('payroll_contract_versions', 'effective_from', 'date'),
      ('payroll_contract_versions', 'effective_to', 'date'),
      ('payroll_contract_versions', 'pay_type', 'text'),
      ('payroll_contract_versions', 'calculation_basis', 'text'),
      ('payroll_contract_versions', 'base_salary', 'numeric'),
      ('payroll_contract_versions', 'fixed_raise_amount', 'numeric'),
      ('payroll_contract_versions', 'standard_workdays', 'numeric'),
      ('payroll_contract_versions', 'standard_minutes_per_day', 'integer'),
      ('payroll_contract_versions', 'time_block_minutes', 'integer'),
      ('payroll_contract_versions', 'rounding_mode', 'text'),
      ('payroll_contract_versions', 'late_adjustment_mode', 'text'),
      ('payroll_contract_versions', 'early_leave_adjustment_mode', 'text'),
      ('payroll_contract_versions', 'overtime_mode', 'text'),
      ('payroll_contract_versions', 'paid_leave_mode', 'text'),
      ('payroll_contract_versions', 'note', 'text'),
      ('payroll_contract_audit_logs', 'id', 'bigint'),
      ('payroll_contract_audit_logs', 'contract_version_id', 'bigint'),
      ('payroll_contract_audit_logs', 'user_id', 'bigint'),
      ('payroll_contract_audit_logs', 'action', 'text'),
      ('payroll_contract_audit_logs', 'snapshot', 'jsonb'),
      ('payroll_contract_audit_logs', 'actor_user_id', 'bigint'),
      ('payroll_contract_audit_logs', 'reason', 'text'),
      ('payroll_contract_audit_logs', 'created_at', 'timestamp with time zone'),
      ('payroll_runs', 'id', 'bigint'),
      ('payroll_runs', 'payroll_month', 'date'),
      ('payroll_runs', 'status', 'text'),
      ('payroll_run_employees', 'id', 'bigint'),
      ('payroll_run_employees', 'payroll_run_id', 'bigint'),
      ('payroll_run_employees', 'user_id', 'bigint'),
      ('payroll_run_employees', 'contract_snapshot', 'jsonb'),
      ('payroll_run_employees', 'attendance_snapshot', 'jsonb'),
      ('payroll_run_items', 'payroll_run_employee_id', 'bigint'),
      ('payroll_run_items', 'source_snapshot', 'jsonb'),
      ('payroll_run_reviews', 'payroll_run_employee_id', 'bigint'),
      ('payroll_run_reviews', 'source_snapshot', 'jsonb')
    ) expected(table_name, column_name, data_type)
  loop
    select column_info.data_type into v_actual_type
    from information_schema.columns column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = v_required.table_name
      and column_info.column_name = v_required.column_name;
    if not found then
      v_type_mismatches := array_append(
        v_type_mismatches,
        format('%I.%I missing (expected %s)', v_required.table_name, v_required.column_name, v_required.data_type)
      );
    elsif v_actual_type <> v_required.data_type then
      v_type_mismatches := array_append(
        v_type_mismatches,
        format('%I.%I expected %s but found %s', v_required.table_name, v_required.column_name, v_required.data_type, v_actual_type)
      );
    end if;
  end loop;
  if array_length(v_type_mismatches, 1) is not null then
    raise exception 'PAYROLL_CONTRACT_CORRECTION_PREFLIGHT_COLUMN_TYPE_MISMATCH: %', array_to_string(v_type_mismatches, '; ');
  end if;

  select count(*)::integer into v_function_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'payroll_correct_latest_unused_contract_v1';
  v_function_oid := to_regprocedure('public.payroll_correct_latest_unused_contract_v1(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text)');
  if v_function_count > 0 and (v_function_oid is null or v_function_count <> 1) then
    raise exception 'PAYROLL_CONTRACT_CORRECTION_PREFLIGHT_FUNCTION_SIGNATURE_MISMATCH';
  end if;
  if v_function_oid is not null then
    select p.proconfig, pg_get_function_result(p.oid), p.prosecdef
      into v_function_config, v_function_result, v_function_security_definer
    from pg_proc p where p.oid = v_function_oid;
    if v_function_result <> 'jsonb'
       or not v_function_security_definer
       or v_function_config is distinct from array['search_path=public']::text[] then
      raise exception 'PAYROLL_CONTRACT_CORRECTION_PREFLIGHT_FUNCTION_DEFINITION_MISMATCH';
    end if;
  end if;

  select pg_get_constraintdef(c.oid) into v_audit_action_definition
  from pg_constraint c
  where c.conrelid = 'public.payroll_contract_audit_logs'::regclass
    and c.conname = 'payroll_contract_audit_logs_action_check'
    and c.contype = 'c';
  if v_audit_action_definition is null or v_audit_action_definition not in (
    'CHECK ((action = ''created''::text))',
    'CHECK ((action = ANY (ARRAY[''created''::text, ''corrected''::text])))'
  ) then
    raise exception 'PAYROLL_CONTRACT_CORRECTION_PREFLIGHT_INVALID_AUDIT_ACTION_CONSTRAINT: %', coalesce(v_audit_action_definition, 'missing');
  end if;
end $$;

do $$
declare
  v_audit_action_definition text;
begin
  select pg_get_constraintdef(c.oid) into strict v_audit_action_definition
  from pg_constraint c
  where c.conrelid = 'public.payroll_contract_audit_logs'::regclass
    and c.conname = 'payroll_contract_audit_logs_action_check'
    and c.contype = 'c';
  if v_audit_action_definition = 'CHECK ((action = ''created''::text))' then
    alter table public.payroll_contract_audit_logs
      drop constraint payroll_contract_audit_logs_action_check;
    alter table public.payroll_contract_audit_logs
      add constraint payroll_contract_audit_logs_action_check
      check (action in ('created', 'corrected'));
  end if;
end $$;

create or replace function public.payroll_correct_latest_unused_contract_v1(
  p_contract_id bigint,
  p_user_id bigint,
  p_expected_revision bigint,
  p_expected_audit_log_id bigint,
  p_expected_effective_from date,
  p_pay_type text,
  p_calculation_basis text,
  p_base_salary numeric,
  p_fixed_raise_amount numeric,
  p_standard_workdays numeric,
  p_standard_minutes_per_day integer,
  p_time_block_minutes integer,
  p_rounding_mode text,
  p_late_adjustment_mode text,
  p_early_leave_adjustment_mode text,
  p_overtime_mode text,
  p_paid_leave_mode text,
  p_effective_from date,
  p_actor_user_id bigint,
  p_note text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract public.payroll_contract_versions%rowtype;
  v_corrected public.payroll_contract_versions%rowtype;
  v_latest_id bigint;
  v_latest_audit_log_id bigint;
  v_position text;
  v_before jsonb;
  v_used boolean := false;
begin
  if nullif(btrim(p_reason), '') is null then return jsonb_build_object('status', 'correction_reason_required'); end if;
  if p_contract_id is null or p_user_id is null or p_expected_revision is null or p_expected_audit_log_id is null
     or p_expected_effective_from is null or p_effective_from is null or p_pay_type is null
     or p_calculation_basis is null or p_base_salary is null or p_fixed_raise_amount is null
     or p_standard_minutes_per_day is null or p_time_block_minutes is null or p_rounding_mode is null
     or p_late_adjustment_mode is null or p_early_leave_adjustment_mode is null
     or p_overtime_mode is null or p_paid_leave_mode is null or p_actor_user_id is null
  then return jsonb_build_object('status', 'invalid_contract'); end if;
  if p_base_salary < 0 or p_base_salary <> trunc(p_base_salary) then return jsonb_build_object('status', 'invalid_contract'); end if;
  if p_fixed_raise_amount < 0 or p_fixed_raise_amount <> trunc(p_fixed_raise_amount) then return jsonb_build_object('status', 'invalid_contract'); end if;
  if p_pay_type not in ('monthly', 'daily', 'hourly')
     or p_calculation_basis not in ('minute', 'hour', 'day', 'fixed_monthly')
     or p_rounding_mode not in ('none', 'floor', 'ceil', 'nearest')
     or p_late_adjustment_mode not in ('separate', 'deduct_minutes', 'ignore')
     or p_early_leave_adjustment_mode not in ('separate', 'deduct_minutes', 'ignore')
     or p_overtime_mode not in ('requires_approval', 'ignore')
     or p_paid_leave_mode not in ('manual_review', 'paid', 'unpaid')
     or p_standard_minutes_per_day not between 1 and 1440
     or p_time_block_minutes not between 1 and 1440
     or (p_pay_type = 'hourly' and p_calculation_basis = 'day')
     or (p_pay_type <> 'monthly' and p_fixed_raise_amount <> 0)
     or (p_pay_type = 'monthly' and (p_standard_workdays is null or p_standard_workdays <= 0))
     or (p_pay_type <> 'monthly' and p_standard_workdays is not null)
  then return jsonb_build_object('status', 'invalid_contract'); end if;

  perform 1 from public.users
  where id = p_actor_user_id and is_active = true and role in ('owner', 'master');
  if not found then return jsonb_build_object('status', 'forbidden'); end if;

  select lower(coalesce(position, '')) into v_position
  from public.users
  where id = p_user_id and is_active = true and is_system_account = false;
  if not found then return jsonb_build_object('status', 'user_not_found'); end if;
  if (v_position = 'owner' and (p_pay_type <> 'monthly' or p_calculation_basis <> 'fixed_monthly'))
     or (v_position <> 'owner' and p_calculation_basis = 'fixed_monthly')
  then return jsonb_build_object('status', 'invalid_contract'); end if;
  if v_position = 'owner' and extract(day from p_effective_from) <> 1 then
    return jsonb_build_object('status', 'invalid_fixed_monthly_effective_date');
  end if;

  perform pg_advisory_xact_lock(p_user_id);
  select * into v_contract
  from public.payroll_contract_versions
  where id = p_contract_id and user_id = p_user_id
  for update;
  if not found then return jsonb_build_object('status', 'contract_not_found'); end if;
  if v_contract.revision <> p_expected_revision then return jsonb_build_object('status', 'revision_conflict'); end if;
  select max(id) into v_latest_audit_log_id
  from public.payroll_contract_audit_logs
  where contract_version_id = v_contract.id;
  if v_latest_audit_log_id is distinct from p_expected_audit_log_id then
    return jsonb_build_object('status', 'revision_conflict');
  end if;
  if p_fixed_raise_amount <> v_contract.fixed_raise_amount and nullif(btrim(p_note), '') is null then
    return jsonb_build_object('status', 'fixed_raise_reason_required');
  end if;
  if v_contract.effective_from <> p_expected_effective_from or p_effective_from <> v_contract.effective_from then
    return jsonb_build_object('status', 'effective_from_change_forbidden');
  end if;

  select id into v_latest_id
  from public.payroll_contract_versions
  where user_id = p_user_id
  order by revision desc, effective_from desc, id desc
  limit 1;
  if v_latest_id <> v_contract.id then return jsonb_build_object('status', 'not_latest_contract'); end if;

  if exists (
    select 1 from public.payroll_contract_versions other
    where other.user_id = p_user_id and other.id <> v_contract.id
      and daterange(other.effective_from, coalesce(other.effective_to, 'infinity'::date), '[)')
          && daterange(v_contract.effective_from, coalesce(v_contract.effective_to, 'infinity'::date), '[)')
  ) then return jsonb_build_object('status', 'period_conflict'); end if;

  select exists (
    select 1
    from public.payroll_run_employees employee
    join public.payroll_runs run on run.id = employee.payroll_run_id
    where employee.user_id = p_user_id
      and run.status in ('finalized', 'paid')
      and (
        jsonb_path_exists(employee.contract_snapshot, '$[*] ? (@.id == $contractId || @.revision == $revision)', jsonb_build_object('contractId', p_contract_id, 'revision', p_expected_revision))
        or jsonb_path_exists(employee.attendance_snapshot, '$.** ? (@.contractRevision == $revision)', jsonb_build_object('revision', p_expected_revision))
      )
  ) into v_used;
  if v_used then return jsonb_build_object('status', 'locked_payroll_contract'); end if;

  select exists (
    select 1
    from public.payroll_run_employees employee
    where employee.user_id = p_user_id
      and (
        jsonb_path_exists(employee.contract_snapshot, '$[*] ? (@.id == $contractId || @.revision == $revision)', jsonb_build_object('contractId', p_contract_id, 'revision', p_expected_revision))
        or jsonb_path_exists(employee.attendance_snapshot, '$.** ? (@.contractRevision == $revision)', jsonb_build_object('revision', p_expected_revision))
        or exists (
          select 1 from public.payroll_run_items item
          where item.payroll_run_employee_id = employee.id
            and jsonb_path_exists(item.source_snapshot, '$.** ? (@.contractId == $contractId || @.contractRevision == $revision)', jsonb_build_object('contractId', p_contract_id, 'revision', p_expected_revision))
        )
        or exists (
          select 1 from public.payroll_run_reviews review
          where review.payroll_run_employee_id = employee.id
            and jsonb_path_exists(review.source_snapshot, '$.** ? (@.contractId == $contractId || @.contractRevision == $revision)', jsonb_build_object('contractId', p_contract_id, 'revision', p_expected_revision))
        )
      )
  ) into v_used;
  if v_used then return jsonb_build_object('status', 'contract_already_used'); end if;

  v_before := to_jsonb(v_contract);
  update public.payroll_contract_versions set
    pay_type = p_pay_type,
    calculation_basis = p_calculation_basis,
    base_salary = p_base_salary,
    fixed_raise_amount = p_fixed_raise_amount,
    standard_workdays = p_standard_workdays,
    standard_minutes_per_day = p_standard_minutes_per_day,
    time_block_minutes = p_time_block_minutes,
    rounding_mode = p_rounding_mode,
    late_adjustment_mode = p_late_adjustment_mode,
    early_leave_adjustment_mode = p_early_leave_adjustment_mode,
    overtime_mode = p_overtime_mode,
    paid_leave_mode = p_paid_leave_mode,
    note = nullif(btrim(p_note), '')
  where id = v_contract.id and revision = p_expected_revision
  returning * into v_corrected;
  if not found then return jsonb_build_object('status', 'revision_conflict'); end if;

  insert into public.payroll_contract_audit_logs(
    contract_version_id, user_id, action, actor_user_id, snapshot, reason
  ) values (
    v_corrected.id, v_corrected.user_id, 'corrected', p_actor_user_id,
    jsonb_build_object(
      'contractId', v_corrected.id,
      'userId', v_corrected.user_id,
      'revision', v_corrected.revision,
      'effectiveFrom', v_corrected.effective_from,
      'before', v_before,
      'after', to_jsonb(v_corrected),
      'actorUserId', p_actor_user_id,
      'correctedAt', now(),
      'reason', btrim(p_reason)
    ),
    btrim(p_reason)
  );
  return jsonb_build_object('status', 'corrected', 'contract', to_jsonb(v_corrected));
exception
  when exclusion_violation then return jsonb_build_object('status', 'period_conflict');
end $$;

revoke all on function public.payroll_correct_latest_unused_contract_v1(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text) from public, anon, authenticated;
grant execute on function public.payroll_correct_latest_unused_contract_v1(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text) to service_role;

comment on function public.payroll_correct_latest_unused_contract_v1(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text)
  is 'Atomically corrects only the latest unused payroll contract row while preserving before/after audit history.';

commit;
