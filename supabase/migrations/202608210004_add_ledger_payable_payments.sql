alter table public.ledger_transactions drop constraint ledger_transactions_type_check;
alter table public.ledger_transactions add constraint ledger_transactions_type_check
  check(type in('expense','income','sales','transfer','opening','balance_adjustment','investment','owner_settlement','card_settlement','payable_payment'));

alter table public.ledger_parties add column default_payment_term_days integer null
  check(default_payment_term_days is null or default_payment_term_days between 0 and 3650);

create index ledger_payables_party_open_idx on public.ledger_payables(party_id,status,created_at,id)
  where status in('unpaid','partially_paid');

create or replace function public.ledger_create_party_v1(
  p_name text,p_default_category_id bigint,p_default_payment_term_days integer,p_memo text,p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_role text;v_id bigint;
begin
 select lower(role::text) into v_role from public.users where id=p_actor_user_id and is_active=true and app_login_enabled=true;
 if coalesce(v_role,'') not in('owner','master') then return jsonb_build_object('status','forbidden');end if;
 if nullif(btrim(p_name),'') is null or p_default_payment_term_days<0 or p_default_payment_term_days>3650 then return jsonb_build_object('status','invalid_input');end if;
 if p_default_category_id is not null and not exists(select 1 from public.ledger_categories where id=p_default_category_id and kind='expense' and is_active=true) then return jsonb_build_object('status','invalid_category');end if;
 insert into public.ledger_parties(name,type,default_category_id,default_payment_term_days,memo)
 values(btrim(p_name),'supplier',p_default_category_id,p_default_payment_term_days,nullif(btrim(p_memo),'')) returning id into v_id;
 insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason)
 values(p_actor_user_id,'party_created','party',v_id,(select to_jsonb(p) from public.ledger_parties p where p.id=v_id),'Ledger supplier creation');
 return jsonb_build_object('status','created','partyId',v_id);
exception when unique_violation then return jsonb_build_object('status','duplicate_name');
end $$;

create or replace function public.ledger_upsert_supplier_party_mapping_v1(
  p_supplier_name text,p_party_id bigint,p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_role text;v_id bigint;v_before jsonb;
begin
 select lower(role::text) into v_role from public.users where id=p_actor_user_id and is_active=true and app_login_enabled=true;
 if coalesce(v_role,'') not in('owner','master') then return jsonb_build_object('status','forbidden');end if;
 if nullif(btrim(p_supplier_name),'') is null or not exists(select 1 from public.ledger_parties where id=p_party_id and is_active=true) then return jsonb_build_object('status','invalid_input');end if;
 select to_jsonb(m) into v_before from public.ledger_supplier_party_mappings m where lower(btrim(m.supplier_name))=lower(btrim(p_supplier_name)) for update;
 insert into public.ledger_supplier_party_mappings(supplier_name,party_id,is_active) values(btrim(p_supplier_name),p_party_id,true)
 on conflict(supplier_name) do update set party_id=excluded.party_id,is_active=true returning id into v_id;
 insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
 values(p_actor_user_id,'supplier_party_mapping_saved','supplier_party_mapping',v_id,v_before,(select to_jsonb(m) from public.ledger_supplier_party_mappings m where m.id=v_id),'Inventory supplier default party');
 return jsonb_build_object('status','saved','mappingId',v_id);
end $$;

create or replace function public.ledger_pay_payables_v1(
  p_party_id bigint,p_fund_account_id bigint,p_occurred_at timestamptz,p_amount numeric,p_allocations jsonb,p_memo text,p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_role text;v_business_date date;v_payment_id bigint;v_item jsonb;v_payable public.ledger_payables%rowtype;
 v_outstanding numeric(16,3);v_allocate numeric(16,3);v_remaining numeric(16,3);v_sum numeric(16,3):=0;
 v_plan jsonb:='[]'::jsonb;v_before jsonb:='[]'::jsonb;v_after jsonb:='[]'::jsonb;v_status text;
begin
 select lower(role::text) into v_role from public.users where id=p_actor_user_id and is_active=true and app_login_enabled=true;
 if coalesce(v_role,'') not in('owner','master') then return jsonb_build_object('status','forbidden');end if;
 if p_occurred_at is null or p_amount is null or p_amount<=0 or round(p_amount,3)<>p_amount then return jsonb_build_object('status','invalid_amount');end if;
 if not exists(select 1 from public.ledger_parties where id=p_party_id and is_active=true) then return jsonb_build_object('status','invalid_party');end if;
 v_business_date:=((p_occurred_at at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date;
 if not exists(select 1 from public.ledger_fund_accounts where id=p_fund_account_id and is_active=true and active_from<=v_business_date and(active_to is null or active_to>=v_business_date)) then return jsonb_build_object('status','invalid_account');end if;

 if p_allocations is null then
  v_remaining:=p_amount;
  for v_payable in
   select p.* from public.ledger_payables p join public.ledger_transactions t on t.id=p.expense_transaction_id
   where p.party_id=p_party_id and p.status<>'cancelled' order by t.business_date,p.id for update of p
  loop
   select v_payable.original_amount-coalesce(sum(a.allocated_amount),0) into v_outstanding from public.ledger_payable_allocations a where a.payable_id=v_payable.id;
   if v_outstanding<=0 then continue;end if;
   v_allocate:=least(v_remaining,v_outstanding);
   v_plan:=v_plan||jsonb_build_array(jsonb_build_object('payableId',v_payable.id,'allocatedAmount',v_allocate));
   v_before:=v_before||jsonb_build_array(jsonb_build_object('payableId',v_payable.id,'outstanding',v_outstanding));
   v_remaining:=v_remaining-v_allocate;
   exit when v_remaining=0;
  end loop;
  if v_remaining<>0 then return jsonb_build_object('status','amount_exceeds_outstanding');end if;
 else
  if jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations)=0 then return jsonb_build_object('status','invalid_allocations');end if;
  begin
   if (select count(*) from jsonb_array_elements(p_allocations))<>(select count(distinct(value->>'payableId')) from jsonb_array_elements(p_allocations)) then return jsonb_build_object('status','duplicate_payable');end if;
   for v_payable in select p.* from public.ledger_payables p where p.id in(select(value->>'payableId')::bigint from jsonb_array_elements(p_allocations)) order by p.id for update loop null;end loop;
   for v_item in select value from jsonb_array_elements(p_allocations) loop
    select * into v_payable from public.ledger_payables where id=(v_item->>'payableId')::bigint;
    v_allocate:=(v_item->>'allocatedAmount')::numeric;
    if v_payable.id is null or v_payable.party_id<>p_party_id or v_payable.status='cancelled' then return jsonb_build_object('status','payable_party_mismatch');end if;
    select v_payable.original_amount-coalesce(sum(a.allocated_amount),0) into v_outstanding from public.ledger_payable_allocations a where a.payable_id=v_payable.id;
    if v_allocate<=0 or round(v_allocate,3)<>v_allocate or v_allocate>v_outstanding then return jsonb_build_object('status','invalid_allocation');end if;
    v_sum:=v_sum+v_allocate;v_plan:=v_plan||jsonb_build_array(jsonb_build_object('payableId',v_payable.id,'allocatedAmount',v_allocate));
    v_before:=v_before||jsonb_build_array(jsonb_build_object('payableId',v_payable.id,'outstanding',v_outstanding));
   end loop;
  exception when others then return jsonb_build_object('status','invalid_allocations');end;
  if v_sum<>p_amount then return jsonb_build_object('status','allocation_sum_mismatch');end if;
 end if;

 insert into public.ledger_transactions(operation_id,type,occurred_at,business_date,amount,party_id,status,source_type,source_snapshot,memo,created_by,confirmed_by)
 values(gen_random_uuid(),'payable_payment',p_occurred_at,v_business_date,p_amount,p_party_id,'confirmed','manual',jsonb_build_object('allocationMode',case when p_allocations is null then 'oldest_first' else 'custom' end),nullif(btrim(p_memo),''),p_actor_user_id,p_actor_user_id) returning id into v_payment_id;
 insert into public.ledger_movements(transaction_id,fund_account_id,amount) values(v_payment_id,p_fund_account_id,-p_amount);
 for v_item in select value from jsonb_array_elements(v_plan) loop
  insert into public.ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) values((v_item->>'payableId')::bigint,v_payment_id,(v_item->>'allocatedAmount')::numeric);
  select p.original_amount-coalesce(sum(a.allocated_amount),0),coalesce(sum(a.allocated_amount),0) into v_outstanding,v_sum from public.ledger_payables p left join public.ledger_payable_allocations a on a.payable_id=p.id where p.id=(v_item->>'payableId')::bigint group by p.id,p.original_amount;
  v_status:=case when v_sum=0 then 'unpaid' when v_outstanding=0 then 'paid' else 'partially_paid' end;
  update public.ledger_payables set status=v_status,updated_at=now() where id=(v_item->>'payableId')::bigint;
  v_after:=v_after||jsonb_build_array(jsonb_build_object('payableId',(v_item->>'payableId')::bigint,'outstanding',v_outstanding,'status',v_status));
 end loop;
 insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
 values(p_actor_user_id,'payable_payment_created','transaction',v_payment_id,jsonb_build_object('partyId',p_party_id,'payables',v_before),jsonb_build_object('paymentTransactionId',v_payment_id,'partyId',p_party_id,'amount',p_amount,'fundAccountId',p_fund_account_id,'allocations',v_plan,'payables',v_after),nullif(btrim(p_memo),''));
 return jsonb_build_object('status','paid','paymentTransactionId',v_payment_id,'amount',p_amount,'allocations',v_plan);
end $$;

revoke all on function public.ledger_create_party_v1(text,bigint,integer,text,bigint) from public,anon,authenticated;
revoke all on function public.ledger_upsert_supplier_party_mapping_v1(text,bigint,bigint) from public,anon,authenticated;
revoke all on function public.ledger_pay_payables_v1(bigint,bigint,timestamptz,numeric,jsonb,text,bigint) from public,anon,authenticated;
grant execute on function public.ledger_create_party_v1(text,bigint,integer,text,bigint) to service_role;
grant execute on function public.ledger_upsert_supplier_party_mapping_v1(text,bigint,bigint) to service_role;
grant execute on function public.ledger_pay_payables_v1(bigint,bigint,timestamptz,numeric,jsonb,text,bigint) to service_role;
