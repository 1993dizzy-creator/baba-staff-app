alter table public.payroll_contract_versions
  drop constraint payroll_contract_versions_calculation_basis_check;

alter table public.payroll_contract_versions
  add constraint payroll_contract_versions_calculation_basis_check
  check (calculation_basis in ('minute', 'hour', 'day', 'fixed_monthly'));

create or replace function public.payroll_create_contract_version_v3(
  p_user_id bigint, p_pay_type text, p_calculation_basis text,
  p_base_salary numeric, p_fixed_raise_amount numeric,
  p_standard_workdays numeric, p_standard_minutes_per_day integer,
  p_time_block_minutes integer, p_rounding_mode text,
  p_late_adjustment_mode text, p_early_leave_adjustment_mode text,
  p_overtime_mode text, p_paid_leave_mode text, p_effective_from date,
  p_actor_user_id bigint, p_note text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_position text;
begin
  select lower(coalesce(position, '')) into v_position
  from public.users
  where id = p_user_id and is_active = true and is_system_account = false;
  if not found then return jsonb_build_object('status', 'user_not_found'); end if;

  if v_position = 'owner' then
    if p_pay_type <> 'monthly' or p_calculation_basis <> 'fixed_monthly' then
      return jsonb_build_object('status', 'invalid_owner_pay_basis');
    end if;
  elsif p_calculation_basis = 'fixed_monthly' then
    return jsonb_build_object('status', 'fixed_monthly_owner_only');
  end if;

  return public.payroll_create_contract_version_v2(
    p_user_id, p_pay_type, p_calculation_basis,
    p_base_salary, p_fixed_raise_amount,
    p_standard_workdays, p_standard_minutes_per_day,
    p_time_block_minutes, p_rounding_mode,
    p_late_adjustment_mode, p_early_leave_adjustment_mode,
    p_overtime_mode, p_paid_leave_mode, p_effective_from,
    p_actor_user_id, p_note
  );
end $$;

revoke all on function public.payroll_create_contract_version_v3(bigint,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text) from public, anon, authenticated;
grant execute on function public.payroll_create_contract_version_v3(bigint,text,text,numeric,numeric,numeric,integer,integer,text,text,text,text,text,date,bigint,text) to service_role;
