create or replace function public.ledger_sync_payroll_batch_company_cost_v1(
  p_batch_id bigint,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_batch public.payroll_payment_batches%rowtype;
  v_snapshot jsonb;
  v_fingerprint text;
  v_row jsonb;
begin
  select * into v_batch
  from public.payroll_payment_batches
  where id = p_batch_id;
  if v_batch.id is null then
    return jsonb_build_object('status', 'batch_not_found');
  end if;

  v_snapshot := jsonb_build_object(
    'batch_id', v_batch.id,
    'payroll_month', v_batch.payroll_month,
    'batch_status', v_batch.status,
    'actual_paid_total', v_batch.actual_paid_total,
    'employee_insurance_total', v_batch.employee_insurance_total,
    'employer_insurance_total', v_batch.employer_insurance_total,
    'director_insurance_amount', v_batch.director_insurance_amount,
    'insurance_remittance_total', v_batch.insurance_remittance_total,
    'actual_company_cost_total', v_batch.actual_company_cost_total,
    'engine_version', v_batch.engine_version,
    'completed_at', v_batch.completed_at
  );

  v_fingerprint := encode(
    extensions.digest(
      concat_ws('|',
        'payroll-company-cost-v2',
        v_batch.id::text,
        v_batch.payroll_month::text,
        v_batch.status,
        v_batch.actual_paid_total::text,
        v_batch.employee_insurance_total::text,
        v_batch.employer_insurance_total::text,
        v_batch.director_insurance_amount::text,
        v_batch.insurance_remittance_total::text,
        v_batch.actual_company_cost_total::text,
        coalesce(v_batch.engine_version, '')
      ),
      'sha256'
    ),
    'hex'
  );

  v_row := jsonb_build_object(
    'batchId', v_batch.id,
    'payrollMonth', v_batch.payroll_month,
    'amount', v_batch.actual_company_cost_total,
    'completed', v_batch.status = 'completed',
    'snapshot', v_snapshot,
    'fingerprint', v_fingerprint
  );

  return public.ledger_sync_payroll_company_cost_v2(v_row, p_actor_user_id);
end;
$function$;

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
  where id = p_fund_account_id and is_active = true;
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

alter function public.ledger_sync_payroll_batch_company_cost_v1(bigint,bigint) owner to postgres;
alter function public.payroll_pay_employee_v3(date,jsonb,bigint,jsonb,text,bigint,bigint,text,date,bigint,bigint,text,jsonb,bigint) owner to postgres;

revoke all on function public.ledger_sync_payroll_batch_company_cost_v1(bigint,bigint) from public, anon, authenticated;
revoke all on function public.payroll_pay_employee_v3(date,jsonb,bigint,jsonb,text,bigint,bigint,text,date,bigint,bigint,text,jsonb,bigint) from public, anon, authenticated;

grant execute on function public.ledger_sync_payroll_batch_company_cost_v1(bigint,bigint) to service_role;
grant execute on function public.payroll_pay_employee_v3(date,jsonb,bigint,jsonb,text,bigint,bigint,text,date,bigint,bigint,text,jsonb,bigint) to service_role;
