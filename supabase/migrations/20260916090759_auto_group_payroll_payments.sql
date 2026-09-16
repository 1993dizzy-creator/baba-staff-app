alter table public.payroll_employee_payments
  add column if not exists fund_account_id bigint references public.ledger_fund_accounts(id);

create index if not exists payroll_employee_payments_paid_group_idx
  on public.payroll_employee_payments(payroll_batch_id, payment_date, fund_account_id, id)
  where payment_status = 'paid' and fund_account_id is not null;

create or replace function public.ledger_project_payroll_payment_group_v1(
  p_payroll_month date,
  p_payment_date date,
  p_fund_account_id bigint,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_role text;
  v_account public.ledger_fund_accounts%rowtype;
  v_batch public.payroll_payment_batches%rowtype;
  v_existing public.ledger_transactions%rowtype;
  v_existing_id bigint;
  v_reversal_id bigint;
  v_new_id bigint;
  v_total numeric := 0;
  v_count integer := 0;
  v_employees jsonb := '[]'::jsonb;
  v_fingerprint text;
  v_group_key text;
  v_version integer := 0;
  v_names text;
  v_memo text;
  v_operation uuid := gen_random_uuid();
  v_before jsonb;
  v_after jsonb;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if p_payroll_month is null
     or p_payroll_month <> date_trunc('month', p_payroll_month)::date
     or p_payment_date is null
     or p_fund_account_id is null then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  select * into v_account
  from public.ledger_fund_accounts
  where id = p_fund_account_id and is_active = true;
  if v_account.id is null then
    return jsonb_build_object('status', 'fund_account_not_found');
  end if;

  select * into v_batch
  from public.payroll_payment_batches
  where payroll_month = p_payroll_month;
  if v_batch.id is null then
    return jsonb_build_object('status', 'batch_not_found');
  end if;

  perform pg_advisory_xact_lock(
    hashtext('ledger_month_close:' || to_char(date_trunc('month', p_payment_date)::date, 'YYYY-MM'))
  );
  if public.ledger_month_is_closed_v1(date_trunc('month', p_payment_date)::date) then
    return jsonb_build_object('status', 'month_closed');
  end if;

  v_group_key := 'payroll-payment-group:' || to_char(p_payroll_month, 'YYYY-MM') || ':' || p_payment_date::text || ':' || p_fund_account_id;
  perform pg_advisory_xact_lock(hashtext(v_group_key));

  select
    coalesce(sum(p.actual_paid_amount), 0),
    count(*)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'paymentId', p.id,
          'userId', p.user_id,
          'employeeName', p.employee_name,
          'amount', p.actual_paid_amount,
          'calculatedNetAmount', p.calculated_net_amount,
          'differenceAmount', p.difference_amount,
          'differenceReason', p.difference_reason,
          'paidAt', p.paid_at
        ) order by p.id
      ),
      '[]'::jsonb
    )
  into v_total, v_count, v_employees
  from public.payroll_employee_payments p
  where p.payroll_batch_id = v_batch.id
    and p.payment_status = 'paid'
    and p.payment_date = p_payment_date
    and p.fund_account_id = p_fund_account_id
    and coalesce(p.actual_paid_amount, 0) > 0;

  v_fingerprint := md5(v_employees::text || '|' || v_total::text || '|' || v_count::text);

  select t.id into v_existing_id
  from public.ledger_transactions t
  where t.source_type = 'payroll_payment_group'
    and t.source_snapshot->>'groupKey' = v_group_key
    and t.status = 'confirmed'
    and not exists (
      select 1
      from public.ledger_transactions r
      where r.correction_of_id = t.id
        and r.source_type = 'payroll_payment_group_reversal'
    )
  order by t.id desc
  limit 1;

  if v_existing_id is not null then
    select * into v_existing
    from public.ledger_transactions
    where id = v_existing_id
    for update;
  end if;

  if v_existing.id is not null
     and v_existing.source_fingerprint = v_fingerprint
     and v_existing.amount = v_total then
    update public.ledger_transactions
    set source_synced_at = now(), updated_at = now()
    where id = v_existing.id;
    return jsonb_build_object(
      'status', 'unchanged',
      'transactionId', v_existing.id,
      'amount', v_total,
      'employeeCount', v_count,
      'groupKey', v_group_key
    );
  end if;

  if v_existing.id is not null then
    if (select count(*) from public.ledger_movements where transaction_id = v_existing.id) <> 1
       or coalesce((select sum(amount) from public.ledger_movements where transaction_id = v_existing.id and fund_account_id = p_fund_account_id), 0) <> -v_existing.amount then
      return jsonb_build_object('status', 'invalid_state');
    end if;

    v_before := jsonb_build_object(
      'transaction', to_jsonb(v_existing),
      'movements', coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from public.ledger_movements m where m.transaction_id = v_existing.id), '[]'::jsonb)
    );

    insert into public.ledger_transactions(
      operation_id, type, occurred_at, business_date, recognition_month, amount,
      category_id, party_id, status, source_type, source_key, source_snapshot,
      source_fingerprint, source_synced_at, correction_of_id, memo,
      created_by, confirmed_by, economic_effect_sign
    ) values (
      v_operation, 'payroll_payment', v_existing.occurred_at, v_existing.business_date, null,
      v_existing.amount, null, null, 'confirmed', 'payroll_payment_group_reversal',
      v_existing.source_key || ':reversal',
      jsonb_build_object(
        'groupKey', v_group_key,
        'originalTransactionId', v_existing.id,
        'reason', 'Payroll payment group recalculated'
      ),
      md5(v_existing.source_key || ':reversal'), now(), v_existing.id,
      '급여 지급 묶음 재계산 역분개', p_actor_user_id, p_actor_user_id, -1
    ) returning id into v_reversal_id;

    insert into public.ledger_movements(transaction_id, fund_account_id, amount)
    values(v_reversal_id, p_fund_account_id, v_existing.amount);
  end if;

  select coalesce(max((t.source_snapshot->>'version')::integer), 0)
  into v_version
  from public.ledger_transactions t
  where t.source_type = 'payroll_payment_group'
    and t.source_snapshot->>'groupKey' = v_group_key;
  v_version := v_version + 1;

  if v_total > 0 and v_count > 0 then
    select string_agg(x.employee_name, ', ' order by x.id)
    into v_names
    from (
      select id, employee_name
      from public.payroll_employee_payments
      where payroll_batch_id = v_batch.id
        and payment_status = 'paid'
        and payment_date = p_payment_date
        and fund_account_id = p_fund_account_id
        and coalesce(actual_paid_amount, 0) > 0
      order by id
      limit 8
    ) x;

    v_memo := extract(month from p_payroll_month)::integer || '월 급여 · ' || coalesce(v_names, '직원');
    if v_count > 8 then
      v_memo := v_memo || ' 외 ' || (v_count - 8) || '명';
    end if;

    insert into public.ledger_transactions(
      operation_id, type, occurred_at, business_date, recognition_month, amount,
      category_id, party_id, status, source_type, source_key, source_snapshot,
      source_fingerprint, source_synced_at, memo,
      created_by, confirmed_by, economic_effect_sign
    ) values (
      v_operation, 'payroll_payment', (p_payment_date::timestamp at time zone 'Asia/Ho_Chi_Minh'),
      p_payment_date, null, v_total, null, null, 'confirmed', 'payroll_payment_group',
      v_group_key || ':v' || v_version,
      jsonb_build_object(
        'groupKey', v_group_key,
        'version', v_version,
        'batchId', v_batch.id,
        'payrollMonth', p_payroll_month,
        'paymentDate', p_payment_date,
        'fundAccountId', p_fund_account_id,
        'fundAccountCode', v_account.code,
        'fundAccountName', v_account.display_name,
        'employeeCount', v_count,
        'employees', v_employees,
        'totalAmount', v_total
      ),
      v_fingerprint, now(), v_memo, p_actor_user_id, p_actor_user_id, 1
    ) returning id into v_new_id;

    insert into public.ledger_movements(transaction_id, fund_account_id, amount)
    values(v_new_id, p_fund_account_id, -v_total);
  end if;

  v_after := jsonb_build_object(
    'groupKey', v_group_key,
    'newTransactionId', v_new_id,
    'reversalTransactionId', v_reversal_id,
    'amount', v_total,
    'employeeCount', v_count,
    'employees', v_employees
  );

  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id, before_snapshot, after_snapshot, reason
  ) values (
    p_actor_user_id,
    case when v_new_id is null then 'payroll_payment_group_cleared' else 'payroll_payment_group_projected' end,
    'payroll_payment_group',
    coalesce(v_new_id, v_existing.id),
    v_before,
    v_after,
    'Payroll payment group recalculated'
  );

  return jsonb_build_object(
    'status', case when v_new_id is null then 'cleared' when v_existing.id is null then 'created' else 'rebooked' end,
    'transactionId', v_new_id,
    'reversalTransactionId', v_reversal_id,
    'amount', v_total,
    'employeeCount', v_count,
    'groupKey', v_group_key
  );
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
  v_payment_id bigint;
  v_status text;
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

  return v_result || jsonb_build_object('ledgerPaymentGroup', v_group);
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

alter function public.ledger_project_payroll_payment_group_v1(date,date,bigint,bigint) owner to postgres;
alter function public.payroll_pay_employee_v3(date,jsonb,bigint,jsonb,text,bigint,bigint,text,date,bigint,bigint,text,jsonb,bigint) owner to postgres;
alter function public.payroll_cancel_employee_payment_v3(bigint,bigint,text,bigint) owner to postgres;

revoke all on function public.ledger_project_payroll_payment_group_v1(date,date,bigint,bigint) from public, anon, authenticated;
revoke all on function public.payroll_pay_employee_v3(date,jsonb,bigint,jsonb,text,bigint,bigint,text,date,bigint,bigint,text,jsonb,bigint) from public, anon, authenticated;
revoke all on function public.payroll_cancel_employee_payment_v3(bigint,bigint,text,bigint) from public, anon, authenticated;

grant execute on function public.ledger_project_payroll_payment_group_v1(date,date,bigint,bigint) to service_role;
grant execute on function public.payroll_pay_employee_v3(date,jsonb,bigint,jsonb,text,bigint,bigint,text,date,bigint,bigint,text,jsonb,bigint) to service_role;
grant execute on function public.payroll_cancel_employee_payment_v3(bigint,bigint,text,bigint) to service_role;
