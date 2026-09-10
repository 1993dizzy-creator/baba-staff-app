begin;

do $$
begin
  if to_regclass('public.payroll_payment_batches') is null
     or to_regclass('public.payroll_employee_payments') is null
     or to_regclass('public.payroll_payment_audit_logs') is null then
    raise exception 'current payroll payment tables are required';
  end if;
  if to_regprocedure('public.payroll_correct_latest_unused_contract_core_v2(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text)') is null then
    raise exception 'payroll_correct_latest_unused_contract_core_v2 is required';
  end if;
end $$;

create or replace function public.payroll_correct_latest_unused_contract_core_v2(
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

  perform 1 from public.users
  where id = p_user_id and is_active = true and is_system_account = false;
  if not found then return jsonb_build_object('status', 'user_not_found'); end if;

  if p_calculation_basis = 'fixed_monthly' and p_pay_type <> 'monthly' then
    return jsonb_build_object('status', 'invalid_contract');
  end if;
  if p_calculation_basis = 'fixed_monthly' and extract(day from p_effective_from) <> 1 then
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

  with used_snapshots as (
    select employee.calculation_snapshot as snapshot
    from public.payroll_employee_payments employee
    join public.payroll_payment_batches batch on batch.id = employee.payroll_batch_id
    where employee.user_id = p_user_id
      and employee.payment_status = 'paid'
      and employee.calculation_snapshot is not null
    union all
    select case audit.action
      when 'employee_paid' then audit.after_snapshot->'calculation_snapshot'
      when 'employee_payment_cancelled' then audit.before_snapshot->'calculation_snapshot'
      else null
    end as snapshot
    from public.payroll_payment_audit_logs audit
    join public.payroll_employee_payments employee on employee.id = audit.employee_payment_id
    join public.payroll_payment_batches batch on batch.id = audit.payroll_batch_id
    where employee.user_id = p_user_id
      and audit.action in ('employee_paid', 'employee_payment_cancelled')
  )
  select exists (
    select 1 from used_snapshots used
    where used.snapshot is not null
      and jsonb_path_exists(
        used.snapshot,
        '$.contractSnapshot[*] ? (@.id == $contractId && @.revision == $revision)',
        jsonb_build_object('contractId', p_contract_id, 'revision', p_expected_revision)
      )
  ) into v_used;
  if v_used then return jsonb_build_object('status', 'locked_payroll_contract'); end if;

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

revoke all on function public.payroll_correct_latest_unused_contract_core_v2(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text) from public, anon, authenticated;
grant execute on function public.payroll_correct_latest_unused_contract_core_v2(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text) to service_role;
alter function public.payroll_correct_latest_unused_contract_core_v2(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text) owner to postgres;

comment on function public.payroll_correct_latest_unused_contract_core_v2(bigint,bigint,bigint,bigint,date,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text,text)
  is 'Corrects only the latest unused contract. A contract referenced by a current or audited paid calculation snapshot is immutable.';

commit;
