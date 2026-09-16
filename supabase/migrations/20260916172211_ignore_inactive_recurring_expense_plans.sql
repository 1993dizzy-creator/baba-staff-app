-- Repository copy of the already applied Production inactive-plan filter.
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
      and is_active = true
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

create or replace function public.ledger_sync_recurring_expenses_v2(p_month date,p_actor_user_id bigint)returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_role text;v_plan public.ledger_recurring_expense_plans%rowtype;v_tx public.ledger_transactions%rowtype;v_snapshot jsonb;v_fp text;v_result jsonb;v_drift int:=0;v_unchanged int:=0;
begin
 select lower(role::text) into v_role from public.users where id=p_actor_user_id and is_active=true and app_login_enabled=true;if coalesce(v_role,'')not in('owner','master')then return jsonb_build_object('status','forbidden');end if;
 if not public.ledger_month_is_closed_v1(p_month)then return public.ledger_sync_recurring_expenses_v1(p_month,p_actor_user_id);end if;
 for v_plan in select*from public.ledger_recurring_expense_plans where frequency='monthly'and is_active=true and effective_from<=p_month and(effective_to is null or effective_to>=p_month)order by id loop v_snapshot:=jsonb_build_object('planId',v_plan.id,'planName',v_plan.name,'frequency',v_plan.frequency,'recognitionDay',v_plan.recognition_day,'effectiveFrom',v_plan.effective_from,'effectiveTo',v_plan.effective_to,'amount',v_plan.amount);v_fp:=md5(v_snapshot::text);select*into v_tx from public.ledger_transactions where source_type='recurring_expense'and source_key='recurring:'||v_plan.id||':'||to_char(p_month,'YYYY-MM');if v_tx.id is not null and v_tx.source_fingerprint<>v_fp then v_result:=public.ledger_record_source_drift_v1(v_tx.id,v_fp||v_fp,v_plan.amount,v_snapshot,p_actor_user_id);if v_result->>'status'='created'then v_drift:=v_drift+1;end if;else v_unchanged:=v_unchanged+1;end if;end loop;return jsonb_build_object('status','ok','createdCount',0,'updatedCount',0,'unchangedCount',v_unchanged,'driftCount',v_drift,'closedMonth',true);
end$$;

alter function public.ledger_sync_recurring_expenses_v1(date,bigint) owner to postgres;
alter function public.ledger_sync_recurring_expenses_v2(date,bigint) owner to postgres;
revoke all on function public.ledger_sync_recurring_expenses_v1(date,bigint), public.ledger_sync_recurring_expenses_v2(date,bigint) from public,anon,authenticated;
grant execute on function public.ledger_sync_recurring_expenses_v1(date,bigint), public.ledger_sync_recurring_expenses_v2(date,bigint) to service_role,postgres;
