create or replace function public.ledger_sync_recurring_expenses_v1(
  p_month date,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_role text;
  v_plan public.ledger_recurring_expense_plans%rowtype;
  v_existing public.ledger_transactions%rowtype;
  v_key text;
  v_fp text;
  v_snapshot jsonb;
  v_date date;
  v_id bigint;
  v_created int:=0;
  v_updated int:=0;
  v_unchanged int:=0;
  v_cancelled int:=0;
  v_total numeric:=0;
begin
  select lower(role::text) into v_role
  from public.users
  where id=p_actor_user_id and is_active=true and app_login_enabled=true;
  if coalesce(v_role,'') not in('owner','master') then return jsonb_build_object('status','forbidden'); end if;
  if p_month is null or p_month<>date_trunc('month',p_month)::date then return jsonb_build_object('status','invalid_month'); end if;

  for v_plan in
    select * from public.ledger_recurring_expense_plans
    where frequency='monthly'
      and effective_from<=p_month
      and(effective_to is null or effective_to>=p_month)
    order by id
  loop
    perform pg_advisory_xact_lock(hashtext('ledger_recurring:'||v_plan.source_key_prefix||':'||to_char(p_month,'YYYY-MM')));
    v_key:='recurring:'||v_plan.id||':'||to_char(p_month,'YYYY-MM');
    v_date:=least((p_month+(v_plan.recognition_day-1)*interval '1 day')::date,(p_month+interval '1 month'-interval '1 day')::date);
    v_snapshot:=jsonb_build_object('planId',v_plan.id,'planName',v_plan.name,'frequency',v_plan.frequency,'recognitionDay',v_plan.recognition_day,'effectiveFrom',v_plan.effective_from,'effectiveTo',v_plan.effective_to,'amount',v_plan.amount);
    v_fp:=md5(v_snapshot::text);
    select * into v_existing from public.ledger_transactions where source_type='recurring_expense'and source_key=v_key for update;

    if v_existing.id is null then
      insert into public.ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,party_id,status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,memo,created_by,confirmed_by)
      values(gen_random_uuid(),'expense_recognition',(v_date+time'03:00')at time zone'Asia/Ho_Chi_Minh',v_date,p_month,v_plan.amount,v_plan.category_id,v_plan.party_id,'confirmed','recurring_expense',v_key,v_snapshot,v_fp,now(),v_plan.name,p_actor_user_id,p_actor_user_id)
      returning id into v_id;
      insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason)
      values(p_actor_user_id,'recurring_expense_created','transaction',v_id,v_snapshot,'Recurring expense sync');
      v_created:=v_created+1;
      v_total:=v_total+v_plan.amount;
    elsif v_existing.status='cancelled' then
      v_cancelled:=v_cancelled+1;
    elsif v_existing.source_fingerprint=v_fp and v_existing.status='confirmed' then
      update public.ledger_transactions set source_synced_at=now(),updated_at=now()where id=v_existing.id;
      v_unchanged:=v_unchanged+1;
      v_total:=v_total+v_plan.amount;
    else
      update public.ledger_transactions
      set occurred_at=(v_date+time'03:00')at time zone'Asia/Ho_Chi_Minh',business_date=v_date,amount=v_plan.amount,category_id=v_plan.category_id,party_id=v_plan.party_id,status='confirmed',source_snapshot=v_snapshot,source_fingerprint=v_fp,source_synced_at=now(),updated_at=now(),confirmed_by=p_actor_user_id
      where id=v_existing.id;
      insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
      values(p_actor_user_id,'recurring_expense_drift_updated','transaction',v_existing.id,to_jsonb(v_existing),(select to_jsonb(t)from public.ledger_transactions t where id=v_existing.id),'Open-month recurring plan drift; future month closure uses correction');
      v_updated:=v_updated+1;
      v_total:=v_total+v_plan.amount;
    end if;
  end loop;

  return jsonb_build_object('status','ok','plansScanned',v_created+v_updated+v_unchanged+v_cancelled,'createdCount',v_created,'updatedCount',v_updated,'unchangedCount',v_unchanged,'cancelledCount',v_cancelled,'totalRecognizedExpense',v_total);
end
$$;

create or replace function public.ledger_close_preflight_v1(p_month date,p_actor_user_id bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_role text;v_blockers jsonb:='[]';v_warnings jsonb:='[]';v_token text;v_count bigint;v_amount numeric;
begin
 select lower(role::text) into v_role from public.users where id=p_actor_user_id and is_active=true and app_login_enabled=true;
 if coalesce(v_role,'') not in('owner','master') then return jsonb_build_object('status','forbidden');end if;
 if p_month is null or p_month<>date_trunc('month',p_month)::date then return jsonb_build_object('status','invalid_month');end if;
 if p_month>=date_trunc('month',now() at time zone 'Asia/Ho_Chi_Minh')::date then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code',case when p_month=date_trunc('month',now() at time zone 'Asia/Ho_Chi_Minh')::date then'CURRENT_MONTH'else'FUTURE_MONTH'end));end if;
 if public.ledger_month_is_closed_v1(p_month) then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','ALREADY_CLOSED'));end if;
 select count(*) into v_count from public.ledger_candidates where proposed_recognition_month=p_month and status='pending'and candidate_type in('inventory_purchase','employee_meal');if v_count>0 then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','PENDING_CANDIDATES','count',v_count));end if;
 if exists(select 1 from public.payroll_payment_batches where payroll_month=p_month and status<>'completed')or((select min(payroll_month)from public.payroll_payment_batches)<=p_month and not exists(select 1 from public.payroll_payment_batches where payroll_month=p_month and status='completed')) then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','PAYROLL_NOT_COMPLETED'));end if;
 select count(*) into v_count from public.ledger_recurring_expense_plans p where p.effective_from<=p_month and(p.effective_to is null or p.effective_to>=p_month)and not exists(select 1 from public.ledger_transactions t where t.source_type='recurring_expense'and t.source_key='recurring:'||p.id||':'||to_char(p_month,'YYYY-MM')and t.status in('confirmed','cancelled'));if v_count>0 then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','RECURRING_NOT_SYNCED','count',v_count));end if;
 select count(*) into v_count from public.ledger_candidates where proposed_recognition_month=p_month and status='confirmed'and resolved_transaction_id is null;if v_count>0 then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','CANDIDATE_LINK_BROKEN','count',v_count));end if;
 if exists(select 1 from public.ledger_transactions t where t.type='transfer'and(t.recognition_month=p_month or date_trunc('month',t.business_date)::date=p_month)and coalesce((select sum(m.amount)from public.ledger_movements m where m.transaction_id=t.id),0)<>0) then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','TRANSFER_UNBALANCED'));end if;
 if exists(select 1 from public.ledger_transactions t where((t.source_type='manual'and t.type in('expense','income'))or t.type in('payroll_payment','payable_payment','prepaid_expense_payment','card_settlement_deposit'))and(t.recognition_month=p_month or date_trunc('month',t.business_date)::date=p_month)and not exists(select 1 from public.ledger_movements m where m.transaction_id=t.id))then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','REQUIRED_MOVEMENT_MISSING'));end if;
 if exists(select 1 from public.ledger_payables p where(select coalesce(sum(a.allocated_amount),0)from public.ledger_payable_allocations a where a.payable_id=p.id)>p.original_amount)then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','PAYABLE_OVERALLOCATED'));end if;
 if exists(select 1 from public.ledger_transactions t join public.ledger_card_reconciliation_lines l on l.pos_card_transaction_id=t.id join public.ledger_card_reconciliations r on r.id=l.reconciliation_id and r.status<>'cancelled' group by t.id,t.amount having sum(l.allocated_gross_amount)>t.amount)then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','CARD_OVERALLOCATED'));end if;
 if exists(select source_type,source_key from public.ledger_transactions where source_key is not null and status='confirmed' group by source_type,source_key having count(*)>1)then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','DUPLICATE_ACTIVE_SOURCE'));end if;
 select count(*),coalesce(sum(r.deposit_amount),0) into v_count,v_amount from public.ledger_card_reconciliations r where r.status in('unmatched','partial')and date_trunc('month',r.deposit_date)::date=p_month;if v_count>0 then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','CARD_UNMATCHED','count',v_count,'amount',v_amount));end if;
 select coalesce(sum(p.original_amount)-sum(coalesce((select sum(a.allocated_amount)from public.ledger_payable_allocations a join public.ledger_transactions pt on pt.id=a.payment_transaction_id where a.payable_id=p.id and pt.business_date<(p_month+interval'1 month')::date),0)),0) into v_amount from public.ledger_payables p join public.ledger_transactions t on t.id=p.expense_transaction_id where t.business_date<(p_month+interval'1 month')::date and p.status<>'cancelled';if v_amount>0 then v_warnings:=v_warnings||jsonb_build_array(jsonb_build_object('code','PAYABLE_OUTSTANDING','amount',v_amount));end if;
 select count(*) into v_count from public.ledger_transactions where type='balance_adjustment'and date_trunc('month',business_date)::date=p_month;if v_count>0 then v_warnings:=v_warnings||jsonb_build_array(jsonb_build_object('code','BALANCE_ADJUSTMENT','count',v_count));end if;
 select count(*) into v_count from public.ledger_reserve_plans p where p.is_active and coalesce((select sum(case e.entry_type when'allocate'then e.amount when'release'then-e.amount when'consume'then-e.amount else e.amount end)from public.ledger_reserve_entries e where e.reserve_plan_id=p.id and e.occurred_at<((p_month+interval'1 month')::date+time'03:00')at time zone'Asia/Ho_Chi_Minh'),0)<p.target_amount;if v_count>0 then v_warnings:=v_warnings||jsonb_build_array(jsonb_build_object('code','RESERVE_SHORTFALL','count',v_count));end if;
 select count(*) into v_count from public.ledger_candidates where candidate_type='source_drift'and status='pending'and(source_snapshot->>'affectedClosedMonth')::date=p_month;if v_count>0 then v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','CONFIRMED_SOURCE_DRIFT','count',v_count));end if;
 v_token:=md5((jsonb_build_object('month',p_month,'blockers',v_blockers,'warnings',v_warnings,'transactionState',(select coalesce(jsonb_agg(jsonb_build_array(id,updated_at,amount,status,source_fingerprint)order by id),'[]')from public.ledger_transactions where recognition_month=p_month or date_trunc('month',business_date)::date=p_month),'candidateState',(select coalesce(jsonb_agg(jsonb_build_array(id,updated_at,status,source_fingerprint)order by id),'[]')from public.ledger_candidates where proposed_recognition_month=p_month),'cardState',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'updatedAt',r.updated_at,'status',r.status,'matchedGrossAmount',r.matched_gross_amount,'differenceAmount',r.difference_amount,'lines',coalesce((select jsonb_agg(jsonb_build_array(l.pos_card_transaction_id,l.allocated_gross_amount)order by l.pos_card_transaction_id)from public.ledger_card_reconciliation_lines l where l.reconciliation_id=r.id),'[]'::jsonb))order by r.id),'[]'::jsonb)from public.ledger_card_reconciliations r where date_trunc('month',r.deposit_date)::date=p_month))::text)||md5('ledger-close-v1:'||jsonb_build_object('month',p_month,'blockers',v_blockers,'warnings',v_warnings)::text));
 return jsonb_build_object('status','ok','month',p_month,'canClose',jsonb_array_length(v_blockers)=0,'blockers',v_blockers,'warnings',v_warnings,'preflightHash',v_token);
end$$;

revoke all on function public.ledger_sync_recurring_expenses_v1(date,bigint) from public,anon,authenticated;
grant execute on function public.ledger_sync_recurring_expenses_v1(date,bigint) to postgres,service_role;
revoke all on function public.ledger_close_preflight_v1(date,bigint) from public,anon,authenticated;
grant execute on function public.ledger_close_preflight_v1(date,bigint) to postgres,service_role;
