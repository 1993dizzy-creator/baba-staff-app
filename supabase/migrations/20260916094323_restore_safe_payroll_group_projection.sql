create or replace function public.payroll_pay_employee_v3(
  p_month date,
  p_targets jsonb,
  p_user_id bigint,
  p_calculation_snapshot jsonb,
  p_calculation_hash text,
  p_calculated_net_amount bigint,
  p_actual_paid_amount bigint,
  p_difference_reason text,
  p_payment_date date,
  p_fund_account_id bigint,
  p_actor_user_id bigint,
  p_engine_version text,
  p_common_settings_snapshot jsonb,
  p_director_insurance_amount bigint
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_result jsonb;
  v_group jsonb;
  v_company_cost jsonb;
  v_payment_id bigint;
  v_status text;
  v_run_id bigint;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);

  perform 1
  from public.ledger_fund_accounts
  where id = p_fund_account_id and is_active = true and code <> 'card_clearing';
  if not found then
    raise exception 'PAYROLL_FUND_ACCOUNT_INVALID' using errcode = '22023';
  end if;

  v_result := public.payroll_pay_employee_v2(
    p_month, p_targets, p_user_id, p_calculation_snapshot, p_calculation_hash,
    p_calculated_net_amount, p_actual_paid_amount, p_difference_reason, p_payment_date,
    p_actor_user_id, p_engine_version, p_common_settings_snapshot, p_director_insurance_amount
  );

  v_payment_id := (v_result #>> '{employee,id}')::bigint;
  v_run_id := (v_result->>'runId')::bigint;
  update public.payroll_employee_payments
  set fund_account_id = p_fund_account_id, updated_at = now()
  where id = v_payment_id;

  v_group := public.ledger_project_payroll_payment_group_v1(
    p_month, p_payment_date, p_fund_account_id, p_actor_user_id
  );
  v_status := coalesce(v_group->>'status', '');
  if v_status not in ('created', 'rebooked', 'unchanged') then
    raise exception 'PAYROLL_LEDGER_PROJECTION_FAILED:%', v_status using errcode = '55000';
  end if;

  if v_result->>'status' = 'completed' then
    v_company_cost := public.ledger_sync_payroll_batch_company_cost_v1(v_run_id, p_actor_user_id);
    v_status := coalesce(v_company_cost->>'status', '');
    if v_status not in ('created', 'updated', 'unchanged', 'drift') then
      raise exception 'PAYROLL_COMPANY_COST_SYNC_FAILED:%', v_status using errcode = '55000';
    end if;
  end if;

  return v_result || jsonb_build_object(
    'ledgerPaymentGroup', v_group,
    'ledgerCompanyCost', v_company_cost
  );
end;
$function$;

create or replace function public.payroll_cancel_employee_payment_v3(
  p_run_id bigint,
  p_user_id bigint,
  p_reason text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_month date;
  v_payment_date date;
  v_fund_account_id bigint;
  v_result jsonb;
  v_group jsonb;
  v_status text;
begin
  perform public.payroll_assert_actor_v2(p_actor_user_id);

  select b.payroll_month, p.payment_date, p.fund_account_id
  into v_month, v_payment_date, v_fund_account_id
  from public.payroll_employee_payments p
  join public.payroll_payment_batches b on b.id = p.payroll_batch_id
  where p.payroll_batch_id = p_run_id
    and p.user_id = p_user_id
    and p.payment_status = 'paid'
  for update of p, b;

  if v_month is null then
    raise exception 'PAYROLL_EMPLOYEE_NOT_IN_BATCH' using errcode = '22023';
  end if;

  v_result := public.payroll_cancel_employee_payment_v2(
    p_run_id, p_user_id, p_reason, p_actor_user_id
  );

  update public.payroll_employee_payments
  set fund_account_id = null, updated_at = now()
  where payroll_batch_id = p_run_id and user_id = p_user_id and payment_status = 'unpaid';

  if v_fund_account_id is not null and v_payment_date is not null then
    v_group := public.ledger_project_payroll_payment_group_v1(
      v_month, v_payment_date, v_fund_account_id, p_actor_user_id
    );
    v_status := coalesce(v_group->>'status', '');
    if v_status not in ('created', 'rebooked', 'unchanged', 'cleared') then
      raise exception 'PAYROLL_LEDGER_PROJECTION_FAILED:%', v_status using errcode = '55000';
    end if;
  end if;

  return v_result || jsonb_build_object('ledgerPaymentGroup', v_group);
end;
$function$;

drop function if exists public.payroll_sync_ledger_payment_groups_v1(bigint,bigint);
drop function if exists public.payroll_sync_ledger_company_cost_from_batch_v1(bigint,bigint);

alter function public.payroll_pay_employee_v3(date,jsonb,bigint,jsonb,text,bigint,bigint,text,date,bigint,bigint,text,jsonb,bigint) owner to postgres;
alter function public.payroll_cancel_employee_payment_v3(bigint,bigint,text,bigint) owner to postgres;
revoke all on function public.payroll_pay_employee_v3(date,jsonb,bigint,jsonb,text,bigint,bigint,text,date,bigint,bigint,text,jsonb,bigint) from public, anon, authenticated;
revoke all on function public.payroll_cancel_employee_payment_v3(bigint,bigint,text,bigint) from public, anon, authenticated;
grant execute on function public.payroll_pay_employee_v3(date,jsonb,bigint,jsonb,text,bigint,bigint,text,date,bigint,bigint,text,jsonb,bigint) to service_role;
grant execute on function public.payroll_cancel_employee_payment_v3(bigint,bigint,text,bigint) to service_role;
