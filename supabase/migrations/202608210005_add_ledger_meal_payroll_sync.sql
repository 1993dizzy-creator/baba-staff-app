alter table public.ledger_candidates drop constraint ledger_candidates_candidate_type_check;
alter table public.ledger_candidates add constraint ledger_candidates_candidate_type_check check(candidate_type in('inventory_purchase','employee_meal','payroll_employee_payment'));
alter table public.ledger_candidates drop constraint ledger_candidates_source_type_check;
alter table public.ledger_candidates add constraint ledger_candidates_source_type_check check(source_type in('inventory_purchase_log','attendance_meal_daily','payroll_employee_payment'));
alter table public.ledger_candidates add column source_drift_detected_at timestamptz null,add column source_drift_fingerprint text null,add column source_drift_snapshot jsonb null;
alter table public.ledger_candidates add constraint ledger_candidate_drift_metadata check((source_drift_detected_at is null and source_drift_fingerprint is null and source_drift_snapshot is null)or(source_drift_detected_at is not null and length(source_drift_fingerprint)=64 and jsonb_typeof(source_drift_snapshot)='object'));

alter table public.ledger_transactions drop constraint ledger_transactions_type_check;
alter table public.ledger_transactions add constraint ledger_transactions_type_check check(type in('expense','income','sales','transfer','opening','balance_adjustment','investment','owner_settlement','card_settlement','payable_payment','expense_recognition','payroll_payment'));
alter table public.ledger_transactions drop constraint ledger_transaction_recognition_policy;
alter table public.ledger_transactions add constraint ledger_transaction_recognition_policy check(
 (type in('income','expense','sales','expense_recognition') and recognition_month is not null and recognition_month=date_trunc('month',recognition_month)::date and category_id is not null)
 or(type not in('income','expense','sales','expense_recognition') and recognition_month is null and category_id is null));

insert into public.ledger_categories(name,kind,cost_behavior) values('직원 식대','expense','none'),('급여/인건비','expense','none') on conflict(kind,name) do nothing;

create or replace function public.ledger_sync_candidates_v2(p_candidate_type text,p_source_type text,p_rows jsonb,p_actor_user_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_role text;v_item jsonb;v_key text;v_fp text;v_snapshot jsonb;v_date date;v_amount numeric;v_active boolean;v_existing public.ledger_candidates%rowtype;v_category bigint;v_created int:=0;v_unchanged int:=0;v_superseded int:=0;v_drift int:=0;
begin
 select lower(role::text) into v_role from public.users where id=p_actor_user_id and is_active=true and app_login_enabled=true;
 if coalesce(v_role,'') not in('owner','master') then return jsonb_build_object('status','forbidden');end if;
 if (p_candidate_type,p_source_type) not in(('employee_meal','attendance_meal_daily'),('payroll_employee_payment','payroll_employee_payment')) or jsonb_typeof(p_rows)<>'array' then return jsonb_build_object('status','invalid_rows');end if;
 for v_item in select value from jsonb_array_elements(p_rows) loop
  begin v_key:=v_item->>'sourceKey';v_fp:=v_item->>'fingerprint';v_snapshot:=v_item->'snapshot';v_date:=(v_item->>'businessDate')::date;v_amount:=(v_item->>'amount')::numeric;v_active:=coalesce((v_item->>'active')::boolean,true);v_category:=nullif(v_item->>'categoryId','')::bigint;exception when others then return jsonb_build_object('status','invalid_rows');end;
  if nullif(btrim(v_key),'') is null or length(v_fp)<>64 or jsonb_typeof(v_snapshot)<>'object' or(v_active and v_amount<=0) then return jsonb_build_object('status','invalid_rows');end if;
  perform pg_advisory_xact_lock(hashtext('ledger_candidate_v2:'||p_source_type||':'||v_key));v_existing:=null;
  select * into v_existing from public.ledger_candidates where source_type=p_source_type and source_key=v_key order by id desc limit 1 for update;
  if v_existing.status='confirmed' then
   if v_existing.source_fingerprint<>v_fp then
    if v_existing.source_drift_fingerprint is distinct from v_fp then insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)values(p_actor_user_id,'candidate_confirmed_source_drift','candidate',v_existing.id,jsonb_build_object('fingerprint',v_existing.source_fingerprint,'snapshot',v_existing.source_snapshot),jsonb_build_object('fingerprint',v_fp,'snapshot',v_snapshot),'Confirmed source changed; correction required');end if;
    update public.ledger_candidates set source_drift_detected_at=now(),source_drift_fingerprint=v_fp,source_drift_snapshot=v_snapshot,updated_at=now() where id=v_existing.id;v_drift:=v_drift+1;
   else v_unchanged:=v_unchanged+1;end if;continue;
  end if;
  if v_existing.status='dismissed' then v_unchanged:=v_unchanged+1;continue;end if;
  if v_existing.status='pending' and v_existing.source_fingerprint=v_fp and v_active then v_unchanged:=v_unchanged+1;continue;end if;
  if v_existing.status='pending' then update public.ledger_candidates set status='superseded',resolved_at=now(),updated_at=now() where id=v_existing.id;v_superseded:=v_superseded+1;end if;
  if not v_active then continue;end if;
  insert into public.ledger_candidates(candidate_type,source_type,source_key,business_date,proposed_amount,proposed_category_id,proposed_recognition_month,source_snapshot,source_fingerprint)
  values(p_candidate_type,p_source_type,v_key,v_date,v_amount,v_category,date_trunc('month',v_date)::date,v_snapshot,v_fp);v_created:=v_created+1;
 end loop;
 return jsonb_build_object('status','ok','createdCount',v_created,'unchangedCount',v_unchanged,'supersededCount',v_superseded,'driftCount',v_drift);
end $$;

create or replace function public.ledger_resolve_candidate_v2(p_candidate_id bigint,p_resolution text,p_category_id bigint,p_party_id bigint,p_fund_account_id bigint,p_due_date date,p_memo text,p_reason text,p_actor_user_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_role text;v_c public.ledger_candidates%rowtype;v_tx bigint;v_payable bigint;v_type text;v_source text;
begin
 select lower(role::text) into v_role from public.users where id=p_actor_user_id and is_active=true and app_login_enabled=true;if coalesce(v_role,'') not in('owner','master') then return jsonb_build_object('status','forbidden');end if;
 select * into v_c from public.ledger_candidates where id=p_candidate_id for update;if v_c.id is null then return jsonb_build_object('status','not_found');end if;if v_c.status<>'pending' then return jsonb_build_object('status','already_resolved');end if;
 if p_resolution='dismiss' then if nullif(btrim(p_reason),'') is null then return jsonb_build_object('status','reason_required');end if;update public.ledger_candidates set status='dismissed',resolved_by=p_actor_user_id,resolved_at=now(),dismissal_reason=btrim(p_reason),updated_at=now() where id=v_c.id;insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)values(p_actor_user_id,'candidate_dismissed','candidate',v_c.id,to_jsonb(v_c),(select to_jsonb(c) from public.ledger_candidates c where c.id=v_c.id),btrim(p_reason));return jsonb_build_object('status','dismissed');end if;
 if v_c.candidate_type='payroll_employee_payment' then
  if p_resolution<>'immediate' or not exists(select 1 from public.ledger_fund_accounts where id=p_fund_account_id and is_active=true) then return jsonb_build_object('status','invalid_resolution');end if;
  v_type:='payroll_payment';v_source:='payroll_employee_payment_candidate';
  insert into public.ledger_transactions(operation_id,type,occurred_at,business_date,amount,party_id,status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,memo,created_by,confirmed_by)
  values(gen_random_uuid(),v_type,(v_c.business_date+time '03:00') at time zone 'Asia/Ho_Chi_Minh',v_c.business_date,v_c.proposed_amount,p_party_id,'confirmed',v_source,'candidate:'||v_c.id,v_c.source_snapshot,v_c.source_fingerprint,now(),nullif(btrim(p_memo),''),p_actor_user_id,p_actor_user_id)returning id into v_tx;
  insert into public.ledger_movements(transaction_id,fund_account_id,amount)values(v_tx,p_fund_account_id,-v_c.proposed_amount);
 else
  if p_resolution not in('immediate','payable') then return jsonb_build_object('status','invalid_resolution');end if;
  if not exists(select 1 from public.ledger_categories where id=p_category_id and kind='expense' and is_active=true) then return jsonb_build_object('status','invalid_category');end if;
  if p_resolution='immediate' and not exists(select 1 from public.ledger_fund_accounts where id=p_fund_account_id and is_active=true) then return jsonb_build_object('status','invalid_account');end if;
  if p_resolution='payable' and(p_party_id is null or not exists(select 1 from public.ledger_parties where id=p_party_id and is_active=true)) then return jsonb_build_object('status','party_required');end if;
  insert into public.ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,party_id,status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,memo,created_by,confirmed_by)
  values(gen_random_uuid(),'expense',(v_c.business_date+time '03:00') at time zone 'Asia/Ho_Chi_Minh',v_c.business_date,v_c.proposed_recognition_month,v_c.proposed_amount,p_category_id,p_party_id,'confirmed',v_c.source_type||'_candidate','candidate:'||v_c.id,v_c.source_snapshot,v_c.source_fingerprint,now(),nullif(btrim(p_memo),''),p_actor_user_id,p_actor_user_id)returning id into v_tx;
  if p_resolution='immediate' then insert into public.ledger_movements(transaction_id,fund_account_id,amount)values(v_tx,p_fund_account_id,-v_c.proposed_amount);else insert into public.ledger_payables(expense_transaction_id,party_id,original_amount,due_date)values(v_tx,p_party_id,v_c.proposed_amount,p_due_date)returning id into v_payable;end if;
 end if;
 update public.ledger_candidates set status='confirmed',resolved_transaction_id=v_tx,resolved_by=p_actor_user_id,resolved_at=now(),updated_at=now() where id=v_c.id;
 insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)values(p_actor_user_id,'candidate_confirmed','candidate',v_c.id,to_jsonb(v_c),(select to_jsonb(c) from public.ledger_candidates c where c.id=v_c.id),nullif(btrim(p_memo),''));
 return jsonb_build_object('status','confirmed','transactionId',v_tx,'payableId',v_payable);
exception when unique_violation then return jsonb_build_object('status','already_resolved');
end $$;

create or replace function public.ledger_sync_payroll_company_cost_v1(p_row jsonb,p_actor_user_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_role text;v_id bigint;v_month date;v_amount numeric;v_fp text;v_snapshot jsonb;v_completed boolean;v_category bigint;v_existing public.ledger_transactions%rowtype;
begin
 select lower(role::text) into v_role from public.users where id=p_actor_user_id and is_active=true and app_login_enabled=true;if coalesce(v_role,'') not in('owner','master') then return jsonb_build_object('status','forbidden');end if;
 begin v_id:=(p_row->>'batchId')::bigint;v_month:=(p_row->>'payrollMonth')::date;v_amount:=(p_row->>'amount')::numeric;v_fp:=p_row->>'fingerprint';v_snapshot:=p_row->'snapshot';v_completed:=(p_row->>'completed')::boolean;exception when others then return jsonb_build_object('status','invalid_row');end;
 if length(v_fp)<>64 or jsonb_typeof(v_snapshot)<>'object' then return jsonb_build_object('status','invalid_row');end if;
 perform pg_advisory_xact_lock(hashtext('ledger_payroll_batch:'||v_id));select id into v_category from public.ledger_categories where name='급여/인건비' and kind='expense' and is_active=true;select * into v_existing from public.ledger_transactions where source_type='payroll_completed_batch' and source_key='payroll-batch:'||v_id||':company-cost' for update;
 if not v_completed or v_amount<=0 then if v_existing.id is not null and v_existing.status='confirmed' then update public.ledger_transactions set status='corrected',source_snapshot=v_snapshot,source_fingerprint=v_fp,source_synced_at=now(),updated_at=now() where id=v_existing.id;insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)values(p_actor_user_id,'payroll_company_cost_invalidated','transaction',v_existing.id,to_jsonb(v_existing),(select to_jsonb(t) from public.ledger_transactions t where t.id=v_existing.id),'Payroll batch no longer completed');return jsonb_build_object('status','invalidated','driftCount',1);end if;return jsonb_build_object('status','ignored','driftCount',0);end if;
 if v_category is null then return jsonb_build_object('status','category_missing');end if;
 if v_existing.id is null then insert into public.ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,memo,created_by,confirmed_by)values(gen_random_uuid(),'expense_recognition',coalesce((v_snapshot->>'completed_at')::timestamptz,(v_month+interval '1 month')::timestamptz),coalesce((v_snapshot->>'completed_at')::timestamptz::date,(v_month+interval '1 month'-interval '1 day')::date),v_month,v_amount,v_category,'confirmed','payroll_completed_batch','payroll-batch:'||v_id||':company-cost',v_snapshot,v_fp,now(),'Payroll company cost',p_actor_user_id,p_actor_user_id)returning id into v_id;return jsonb_build_object('status','created','transactionId',v_id,'createdCount',1);end if;
 if v_existing.source_fingerprint=v_fp and v_existing.status='confirmed' then update public.ledger_transactions set source_synced_at=now(),updated_at=now() where id=v_existing.id;return jsonb_build_object('status','unchanged','transactionId',v_existing.id,'unchangedCount',1);end if;
 update public.ledger_transactions set status='confirmed',amount=v_amount,recognition_month=v_month,source_snapshot=v_snapshot,source_fingerprint=v_fp,source_synced_at=now(),updated_at=now(),confirmed_by=p_actor_user_id where id=v_existing.id;insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)values(p_actor_user_id,'payroll_company_cost_drift_updated','transaction',v_existing.id,to_jsonb(v_existing),(select to_jsonb(t) from public.ledger_transactions t where t.id=v_existing.id),'Open-month Payroll drift');return jsonb_build_object('status','updated','transactionId',v_existing.id,'updatedCount',1,'driftCount',1);
end $$;

revoke all on function public.ledger_sync_candidates_v2(text,text,jsonb,bigint) from public,anon,authenticated;
revoke all on function public.ledger_resolve_candidate_v2(bigint,text,bigint,bigint,bigint,date,text,text,bigint) from public,anon,authenticated;
revoke all on function public.ledger_sync_payroll_company_cost_v1(jsonb,bigint) from public,anon,authenticated;
grant execute on function public.ledger_sync_candidates_v2(text,text,jsonb,bigint) to service_role;
grant execute on function public.ledger_resolve_candidate_v2(bigint,text,bigint,bigint,bigint,date,text,text,bigint) to service_role;
grant execute on function public.ledger_sync_payroll_company_cost_v1(jsonb,bigint) to service_role;
