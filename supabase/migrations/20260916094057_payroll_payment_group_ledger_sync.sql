create or replace function public.payroll_sync_ledger_company_cost_from_batch_v1(
  p_batch_id bigint,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_batch public.payroll_payment_batches%rowtype;
  v_snapshot jsonb;
  v_fingerprint text;
begin
  select * into v_batch from public.payroll_payment_batches where id=p_batch_id;
  if not found then raise exception 'PAYROLL_RUN_NOT_FOUND' using errcode='22023'; end if;

  v_snapshot:=jsonb_build_object(
    'batch_id',v_batch.id,
    'batch_status',v_batch.status,
    'completed_at',v_batch.completed_at,
    'payroll_month',v_batch.payroll_month,
    'engine_version',v_batch.engine_version,
    'actual_paid_total',v_batch.actual_paid_total,
    'employee_insurance_total',v_batch.employee_insurance_total,
    'employer_insurance_total',v_batch.employer_insurance_total,
    'actual_company_cost_total',v_batch.actual_company_cost_total,
    'director_insurance_amount',v_batch.director_insurance_amount,
    'insurance_remittance_total',v_batch.insurance_remittance_total
  );
  v_fingerprint:=encode(digest(v_snapshot::text,'sha256'),'hex');

  return public.ledger_sync_payroll_company_cost_v2(
    jsonb_build_object(
      'batchId',v_batch.id,
      'payrollMonth',v_batch.payroll_month,
      'amount',v_batch.actual_company_cost_total,
      'completed',v_batch.status='completed',
      'snapshot',v_snapshot,
      'fingerprint',v_fingerprint
    ),
    p_actor_user_id
  );
end
$function$;

create or replace function public.payroll_sync_ledger_payment_groups_v1(
  p_batch_id bigint,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_role text;
  v_batch public.payroll_payment_batches%rowtype;
  v_group record;
  v_existing public.ledger_transactions%rowtype;
  v_snapshot jsonb;
  v_fingerprint text;
  v_source_key text;
  v_memo text;
  v_tx_id bigint;
  v_created int:=0;
  v_updated int:=0;
  v_unchanged int:=0;
  v_invalidated int:=0;
  v_now timestamptz:=now();
begin
  select lower(role::text) into v_role
  from public.users
  where id=p_actor_user_id and is_active=true and app_login_enabled=true;
  if coalesce(v_role,'') not in ('owner','master') then
    return jsonb_build_object('status','forbidden');
  end if;

  select * into v_batch from public.payroll_payment_batches where id=p_batch_id;
  if not found then raise exception 'PAYROLL_RUN_NOT_FOUND' using errcode='22023'; end if;

  perform pg_advisory_xact_lock(hashtext('ledger_payroll_payment_groups:'||p_batch_id));

  for v_group in
    select
      p.payment_date,
      p.fund_account_id,
      fa.code as fund_code,
      fa.display_name as fund_name,
      count(*)::int as employee_count,
      sum(p.actual_paid_amount)::bigint as total_amount,
      string_agg(p.employee_name, ', ' order by p.id) as employee_names,
      jsonb_agg(
        jsonb_build_object(
          'paymentId',p.id,
          'userId',p.user_id,
          'employeeName',p.employee_name,
          'actualPaidAmount',p.actual_paid_amount,
          'calculatedNetAmount',p.calculated_net_amount,
          'differenceAmount',p.difference_amount,
          'differenceReason',p.difference_reason
        ) order by p.id
      ) as payments
    from public.payroll_employee_payments p
    join public.ledger_fund_accounts fa on fa.id=p.fund_account_id
    where p.payroll_batch_id=p_batch_id
      and p.payment_status='paid'
      and p.fund_account_id is not null
    group by p.payment_date,p.fund_account_id,fa.code,fa.display_name
    order by p.payment_date,p.fund_account_id
  loop
    if public.ledger_month_is_closed_v1(date_trunc('month',v_group.payment_date)::date) then
      raise exception 'LEDGER_MONTH_CLOSED' using errcode='55000';
    end if;

    v_source_key:='payroll-group:'||p_batch_id||':'||v_group.payment_date::text||':'||v_group.fund_account_id;
    v_snapshot:=jsonb_build_object(
      'batchId',p_batch_id,
      'payrollMonth',v_batch.payroll_month,
      'paymentDate',v_group.payment_date,
      'fundAccountId',v_group.fund_account_id,
      'fundAccountCode',v_group.fund_code,
      'fundAccountName',v_group.fund_name,
      'employeeCount',v_group.employee_count,
      'employeeNames',v_group.employee_names,
      'payments',v_group.payments
    );
    v_fingerprint:=encode(digest(v_snapshot::text,'sha256'),'hex');
    v_memo:=to_char(v_batch.payroll_month,'YYYY-MM')||' 급여 · '||v_group.employee_names;

    select * into v_existing
    from public.ledger_transactions
    where source_type='payroll_payment_group' and source_key=v_source_key
    for update;

    if v_existing.id is null then
      insert into public.ledger_transactions(
        operation_id,type,occurred_at,business_date,amount,status,
        source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,
        memo,created_by,confirmed_by
      ) values(
        gen_random_uuid(),'payroll_payment',
        (v_group.payment_date::timestamp at time zone 'Asia/Ho_Chi_Minh'),
        v_group.payment_date,v_group.total_amount,'confirmed',
        'payroll_payment_group',v_source_key,v_snapshot,v_fingerprint,v_now,
        v_memo,p_actor_user_id,p_actor_user_id
      ) returning id into v_tx_id;
      insert into public.ledger_movements(transaction_id,fund_account_id,amount)
      values(v_tx_id,v_group.fund_account_id,-v_group.total_amount);
      insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason)
      values(p_actor_user_id,'payroll_payment_group_created','transaction',v_tx_id,
        (select to_jsonb(t) from public.ledger_transactions t where t.id=v_tx_id),
        'Payroll payments grouped by payroll month + payment date + fund account');
      v_created:=v_created+1;
    elsif v_existing.source_fingerprint=v_fingerprint and v_existing.status='confirmed' then
      update public.ledger_transactions set source_synced_at=v_now,updated_at=v_now where id=v_existing.id;
      v_unchanged:=v_unchanged+1;
    else
      update public.ledger_transactions
      set status='confirmed',business_date=v_group.payment_date,
          occurred_at=(v_group.payment_date::timestamp at time zone 'Asia/Ho_Chi_Minh'),
          amount=v_group.total_amount,source_snapshot=v_snapshot,source_fingerprint=v_fingerprint,
          source_synced_at=v_now,memo=v_memo,confirmed_by=p_actor_user_id,updated_at=v_now
      where id=v_existing.id;
      update public.ledger_movements
      set fund_account_id=v_group.fund_account_id,amount=-v_group.total_amount
      where transaction_id=v_existing.id;
      if not found then
        insert into public.ledger_movements(transaction_id,fund_account_id,amount)
        values(v_existing.id,v_group.fund_account_id,-v_group.total_amount);
      end if;
      insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
      values(p_actor_user_id,'payroll_payment_group_updated','transaction',v_existing.id,to_jsonb(v_existing),
        (select to_jsonb(t) from public.ledger_transactions t where t.id=v_existing.id),
        'Payroll payment group changed');
      v_updated:=v_updated+1;
    end if;
  end loop;

  for v_existing in
    select t.*
    from public.ledger_transactions t
    where t.source_type='payroll_payment_group'
      and (t.source_snapshot->>'batchId')::bigint=p_batch_id
      and t.status='confirmed'
      and not exists(
        select 1
        from public.payroll_employee_payments p
        where p.payroll_batch_id=p_batch_id
          and p.payment_status='paid'
          and p.fund_account_id is not null
          and p.payment_date=(t.source_snapshot->>'paymentDate')::date
          and p.fund_account_id=(t.source_snapshot->>'fundAccountId')::bigint
      )
    for update
  loop
    if public.ledger_month_is_closed_v1(date_trunc('month',v_existing.business_date)::date) then
      raise exception 'LEDGER_MONTH_CLOSED' using errcode='55000';
    end if;
    update public.ledger_transactions
    set status='corrected',source_synced_at=v_now,updated_at=v_now,confirmed_by=p_actor_user_id
    where id=v_existing.id;
    insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
    values(p_actor_user_id,'payroll_payment_group_invalidated','transaction',v_existing.id,to_jsonb(v_existing),
      (select to_jsonb(t) from public.ledger_transactions t where t.id=v_existing.id),
      'No paid employees remain in this payment-date/fund group');
    v_invalidated:=v_invalidated+1;
  end loop;

  return jsonb_build_object(
    'status','ok','createdCount',v_created,'updatedCount',v_updated,
    'unchangedCount',v_unchanged,'invalidatedCount',v_invalidated
  );
end
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
set search_path = pg_catalog, public
as $function$
declare
  v_result jsonb;
  v_run_id bigint;
  v_fund_code text;
begin
  select code into v_fund_code
  from public.ledger_fund_accounts
  where id=p_fund_account_id and is_active=true;
  if v_fund_code is null or v_fund_code='card_clearing' then
    raise exception 'PAYROLL_INVALID_FUND_ACCOUNT' using errcode='22023';
  end if;
  if public.ledger_month_is_closed_v1(date_trunc('month',p_payment_date)::date) then
    raise exception 'LEDGER_MONTH_CLOSED' using errcode='55000';
  end if;

  v_result:=public.payroll_pay_employee_v2(
    p_month,p_targets,p_user_id,p_calculation_snapshot,p_calculation_hash,
    p_calculated_net_amount,p_actual_paid_amount,p_difference_reason,p_payment_date,
    p_actor_user_id,p_engine_version,p_common_settings_snapshot,p_director_insurance_amount
  );
  v_run_id:=(v_result->>'runId')::bigint;

  update public.payroll_employee_payments
  set fund_account_id=p_fund_account_id,updated_at=now()
  where payroll_batch_id=v_run_id and user_id=p_user_id and payment_status='paid';

  insert into public.payroll_payment_audit_logs(payroll_batch_id,employee_payment_id,action,actor_user_id,after_snapshot,reason)
  select v_run_id,p.id,'employee_payment_fund_assigned',p_actor_user_id,to_jsonb(p),'Ledger payment account assigned'
  from public.payroll_employee_payments p
  where p.payroll_batch_id=v_run_id and p.user_id=p_user_id;

  perform public.payroll_sync_ledger_payment_groups_v1(v_run_id,p_actor_user_id);
  perform public.payroll_sync_ledger_company_cost_from_batch_v1(v_run_id,p_actor_user_id);

  return v_result || jsonb_build_object('fundAccountId',p_fund_account_id);
end
$function$;

create or replace function public.payroll_cancel_employee_payment_v3(
  p_run_id bigint,
  p_user_id bigint,
  p_reason text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_payment_date date;
  v_result jsonb;
begin
  select payment_date into v_payment_date
  from public.payroll_employee_payments
  where payroll_batch_id=p_run_id and user_id=p_user_id and payment_status='paid';
  if v_payment_date is not null and public.ledger_month_is_closed_v1(date_trunc('month',v_payment_date)::date) then
    raise exception 'LEDGER_MONTH_CLOSED' using errcode='55000';
  end if;

  v_result:=public.payroll_cancel_employee_payment_v2(p_run_id,p_user_id,p_reason,p_actor_user_id);
  update public.payroll_employee_payments
  set fund_account_id=null,updated_at=now()
  where payroll_batch_id=p_run_id and user_id=p_user_id and payment_status='unpaid';

  perform public.payroll_sync_ledger_payment_groups_v1(p_run_id,p_actor_user_id);
  perform public.payroll_sync_ledger_company_cost_from_batch_v1(p_run_id,p_actor_user_id);
  return v_result;
end
$function$;

revoke all on function public.payroll_sync_ledger_company_cost_from_batch_v1(bigint,bigint) from public,anon,authenticated;
revoke all on function public.payroll_sync_ledger_payment_groups_v1(bigint,bigint) from public,anon,authenticated;
revoke all on function public.payroll_pay_employee_v3(date,jsonb,bigint,jsonb,text,bigint,bigint,text,date,bigint,bigint,text,jsonb,bigint) from public,anon,authenticated;
revoke all on function public.payroll_cancel_employee_payment_v3(bigint,bigint,text,bigint) from public,anon,authenticated;
grant execute on function public.payroll_sync_ledger_company_cost_from_batch_v1(bigint,bigint) to service_role;
grant execute on function public.payroll_sync_ledger_payment_groups_v1(bigint,bigint) to service_role;
grant execute on function public.payroll_pay_employee_v3(date,jsonb,bigint,jsonb,text,bigint,bigint,text,date,bigint,bigint,text,jsonb,bigint) to service_role;
grant execute on function public.payroll_cancel_employee_payment_v3(bigint,bigint,text,bigint) to service_role;
