-- Supplier prepayments (선결제), additive only. NOT applied to production by this commit.
--
-- A prepayment is an ordinary confirmed payable_payment with one outflow movement and
-- source_snapshot {"prepayment": true} but no allocations yet: cash leaves once, no
-- expense is recognized (payable_payment never participates in P&L). Its unallocated
-- amount is the unused prepayment balance.
-- Applying it to a received purchase only inserts ledger_payable_allocations rows from
-- that payment transaction: no new transaction, no movement, so no second outflow.
-- Existing tables, constraints and ledger_pay_payables_v1/v2 are unchanged.
-- Idempotency reuses ledger_payable_payment_requests with a "kind" in the payload.
--
-- Allocation date of a prepayment application = greatest(prepayment business_date,
-- received purchase business_date). The payable only exists from its receipt date, so
-- every existing payment-date based reader (payables, month close, preflight) gives the
-- same result; the prepayment's own (possibly closed) month is never changed.
-- The allocation month guard is replaced with one exception: for a prepayment
-- payment it checks that application month instead of the prepayment month. Every
-- other allocation keeps the original check unchanged.

do $$
declare v_src text;
begin
 select prosrc into v_src from pg_proc where oid='public.ledger_payable_allocation_month_guard_v1()'::regprocedure;
 -- Only the exact production baseline (202608210008) or, on re-run, this migration's own
 -- exact version is accepted. Any other body, even one containing similar text, is refused.
 if md5(v_src) not in('ac92f7318abeeed1ddb591050a32f1a4','71ecabe117bbd2dd40ce191326eebd17') then
  raise exception 'ledger_payable_allocation_month_guard_v1 differs from the expected baseline; review before applying';
 end if;
end $$;

create or replace function public.ledger_payable_allocation_month_guard_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_tx public.ledger_transactions%rowtype;v_id bigint;v_payable_id bigint;v_date date;v_side int;
begin
 -- side 1: NEW (OLD on DELETE), as before. side 2 (UPDATE only): the OLD row, so a
 -- prepayment application cannot be moved out of a closed application month.
 for v_side in 1..case when tg_op='UPDATE' then 2 else 1 end loop
  if v_side=1 then
   v_id:=case when tg_op='DELETE' then old.payment_transaction_id else new.payment_transaction_id end;
   v_payable_id:=case when tg_op='DELETE' then old.payable_id else new.payable_id end;
  else
   v_id:=old.payment_transaction_id;v_payable_id:=old.payable_id;
  end if;
  select * into v_tx from public.ledger_transactions where id=v_id;
  v_date:=v_tx.business_date;
  -- supplier prepayment application: guard the application month (receipt side).
  if v_tx.type='payable_payment' and v_tx.source_snapshot->'prepayment'='true'::jsonb then
   select greatest(v_tx.business_date,e.business_date) into v_date
   from public.ledger_payables p join public.ledger_transactions e on e.id=p.expense_transaction_id where p.id=v_payable_id;
   v_date:=coalesce(v_date,v_tx.business_date);
  elsif v_side=2 then
   continue; -- ordinary payment OLD row: original guard (NEW only) unchanged
  end if;
  perform public.ledger_assert_month_open_v1(date_trunc('month',v_date)::date);
 end loop;
 return case when tg_op='DELETE' then old else new end;
end $$;
revoke all on function public.ledger_payable_allocation_month_guard_v1() from public,anon,authenticated,service_role;

create or replace function public.ledger_create_supplier_prepayment_v1(
 p_request_id uuid,p_party_id bigint,p_fund_account_id bigint,p_occurred_at timestamptz,
 p_amount numeric,p_memo text,p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_role text; v_payload jsonb; v_existing public.ledger_payable_payment_requests%rowtype;
 v_invalid text; v_business_date date; v_payment_id bigint; v_result jsonb;
begin
 select lower(role::text) into v_role from public.users
 where id=p_actor_user_id and is_active=true and app_login_enabled=true;
 if coalesce(v_role,'') not in ('owner','master') then return jsonb_build_object('status','forbidden');end if;
 if p_request_id is null then return jsonb_build_object('status','idempotency_key_required');end if;
 if p_occurred_at is null or p_amount is null or p_amount<=0 or p_amount::text in ('NaN','Infinity','-Infinity') or round(p_amount,3)<>p_amount then
  v_invalid:='invalid_amount';
 end if;
 v_payload:=jsonb_build_object('kind','supplier_prepayment','partyId',p_party_id,'fundAccountId',p_fund_account_id,
  'occurredAt',to_char(p_occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'),
  'amount',p_amount,'memo',nullif(btrim(p_memo),''));
 perform pg_advisory_xact_lock(hashtextextended('ledger-payable-request:'||p_request_id::text,0));
 select * into v_existing from public.ledger_payable_payment_requests where request_id=p_request_id;
 if found then
  if v_existing.actor_user_id<>p_actor_user_id or v_existing.request_payload<>v_payload then
   return jsonb_build_object('status','idempotency_conflict');
  end if;
  if v_existing.result is null or v_existing.completed_at is null or jsonb_typeof(v_existing.result) is distinct from 'object'
    or nullif(v_existing.result->>'status','') is null then
   return jsonb_build_object('status','idempotency_state_invalid');
  end if;
  return v_existing.result;
 end if;
 if v_invalid is not null then return jsonb_build_object('status',v_invalid);end if;
 if not exists(select 1 from public.ledger_parties where id=p_party_id and is_active=true) then return jsonb_build_object('status','invalid_party');end if;
 -- Same 03:00 business-day and account rules as ledger_pay_payables_v1, plus business
 -- funds only (excludes the active card_clearing account, is_business_fund=false).
 v_business_date:=((p_occurred_at at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date;
 if not exists(select 1 from public.ledger_fund_accounts where id=p_fund_account_id and is_active=true and is_business_fund=true and active_from<=v_business_date
   and(active_to is null or active_to>=v_business_date)) then return jsonb_build_object('status','invalid_account');end if;
 perform public.ledger_assert_month_open_v1(date_trunc('month',v_business_date)::date);
 perform pg_advisory_xact_lock(hashtextextended('ledger-payable-party:'||p_party_id::text,0));
 insert into public.ledger_payable_payment_requests(request_id,actor_user_id,request_payload) values(p_request_id,p_actor_user_id,v_payload);
 insert into public.ledger_transactions(operation_id,type,occurred_at,business_date,amount,party_id,status,source_type,source_snapshot,memo,created_by,confirmed_by)
 values(gen_random_uuid(),'payable_payment',p_occurred_at,v_business_date,p_amount,p_party_id,'confirmed','manual',
  jsonb_build_object('allocationMode','prepayment','prepayment',true),nullif(btrim(p_memo),''),p_actor_user_id,p_actor_user_id)
 returning id into v_payment_id;
 insert into public.ledger_movements(transaction_id,fund_account_id,amount) values(v_payment_id,p_fund_account_id,-p_amount);
 insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
 values(p_actor_user_id,'supplier_prepayment_created','transaction',v_payment_id,'{}'::jsonb,
  jsonb_build_object('paymentTransactionId',v_payment_id,'partyId',p_party_id,'amount',p_amount,'fundAccountId',p_fund_account_id,'businessDate',v_business_date),
  nullif(btrim(p_memo),''));
 v_result:=jsonb_build_object('status','created','prepaymentTransactionId',v_payment_id,'amount',p_amount,'businessDate',v_business_date);
 update public.ledger_payable_payment_requests set result=v_result,completed_at=now(),payment_transaction_id=v_payment_id where request_id=p_request_id;
 return v_result;
end $$;

-- p_allocations: [{"prepaymentTransactionId":…, "payableId":…, "allocatedAmount":…}]
create or replace function public.ledger_apply_supplier_prepayment_v1(
 p_request_id uuid,p_party_id bigint,p_allocations jsonb,p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_role text; v_payload jsonb; v_existing public.ledger_payable_payment_requests%rowtype; v_invalid text;
 v_allocations jsonb; v_item jsonb; v_row record; v_payable public.ledger_payables%rowtype;
 v_remaining numeric(16,3); v_outstanding numeric(16,3); v_sum numeric(16,3); v_status text;
 v_before jsonb:='[]'::jsonb; v_after jsonb:='[]'::jsonb; v_result jsonb;
begin
 select lower(role::text) into v_role from public.users
 where id=p_actor_user_id and is_active=true and app_login_enabled=true;
 if coalesce(v_role,'') not in ('owner','master') then return jsonb_build_object('status','forbidden');end if;
 if p_request_id is null then return jsonb_build_object('status','idempotency_key_required');end if;
 if p_allocations is null or jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations)=0 then
  v_invalid:='invalid_allocations';v_allocations:=p_allocations;
 else
  begin
   for v_item in select value from jsonb_array_elements(p_allocations) loop
    if jsonb_typeof(v_item)<>'object' or not(v_item ? 'prepaymentTransactionId' and v_item ? 'payableId' and v_item ? 'allocatedAmount')
      or (v_item - 'prepaymentTransactionId' - 'payableId' - 'allocatedAmount')<>'{}'::jsonb
      or (v_item->>'prepaymentTransactionId')::bigint is null or (v_item->>'payableId')::bigint is null
      or (v_item->>'allocatedAmount') in ('NaN','Infinity','-Infinity')
      or (v_item->>'allocatedAmount')::numeric is null or (v_item->>'allocatedAmount')::numeric<=0
      or round((v_item->>'allocatedAmount')::numeric,3)<>(v_item->>'allocatedAmount')::numeric then
     v_invalid:='invalid_allocations';exit;
    end if;
   end loop;
   if v_invalid is null then
    select coalesce(jsonb_agg(jsonb_build_object('prepaymentTransactionId',(value->>'prepaymentTransactionId')::bigint,
      'payableId',(value->>'payableId')::bigint,'allocatedAmount',(value->>'allocatedAmount')::numeric)
      order by (value->>'prepaymentTransactionId')::bigint,(value->>'payableId')::bigint),'[]'::jsonb)
    into v_allocations from jsonb_array_elements(p_allocations);
   else v_allocations:=p_allocations;
   end if;
  exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then
   v_invalid:='invalid_allocations';v_allocations:=p_allocations;
  end;
 end if;
 v_payload:=jsonb_build_object('kind','supplier_prepayment_application','partyId',p_party_id,'allocations',v_allocations);
 perform pg_advisory_xact_lock(hashtextextended('ledger-payable-request:'||p_request_id::text,0));
 select * into v_existing from public.ledger_payable_payment_requests where request_id=p_request_id;
 if found then
  if v_existing.actor_user_id<>p_actor_user_id or v_existing.request_payload<>v_payload then
   return jsonb_build_object('status','idempotency_conflict');
  end if;
  if v_existing.result is null or v_existing.completed_at is null or jsonb_typeof(v_existing.result) is distinct from 'object'
    or nullif(v_existing.result->>'status','') is null then
   return jsonb_build_object('status','idempotency_state_invalid');
  end if;
  return v_existing.result;
 end if;
 if v_invalid is not null then return jsonb_build_object('status',v_invalid);end if;
 if exists(select 1 from jsonb_array_elements(v_allocations) group by value->>'prepaymentTransactionId',value->>'payableId' having count(*)>1) then
  return jsonb_build_object('status','duplicate_allocation');
 end if;
 -- Same party lock as ledger_pay_payables_v2, then row locks in id order.
 perform pg_advisory_xact_lock(hashtextextended('ledger-payable-party:'||p_party_id::text,0));
 perform 1 from public.ledger_transactions where id in(select (value->>'prepaymentTransactionId')::bigint from jsonb_array_elements(v_allocations)) order by id for update;
 perform 1 from public.ledger_payables where id in(select (value->>'payableId')::bigint from jsonb_array_elements(v_allocations)) order by id for update;
 -- Each prepayment: confirmed prepayment payable_payment of this party with its full outflow
 -- movement, and enough unused balance for everything requested from it.
 for v_row in select (value->>'prepaymentTransactionId')::bigint as id,sum((value->>'allocatedAmount')::numeric) as requested
   from jsonb_array_elements(v_allocations) group by 1 order by 1 loop
  if not exists(select 1 from public.ledger_transactions t where t.id=v_row.id and t.type='payable_payment' and t.status='confirmed'
     and t.party_id=p_party_id and t.source_snapshot->'prepayment'='true'::jsonb
     and coalesce((select sum(m.amount) from public.ledger_movements m where m.transaction_id=t.id),0)=-t.amount) then
   return jsonb_build_object('status','invalid_prepayment','prepaymentTransactionId',v_row.id);
  end if;
  select t.amount-coalesce((select sum(a.allocated_amount) from public.ledger_payable_allocations a where a.payment_transaction_id=t.id),0)
  into v_remaining from public.ledger_transactions t where t.id=v_row.id;
  if v_row.requested>v_remaining then
   return jsonb_build_object('status','prepayment_insufficient','prepaymentTransactionId',v_row.id,'remaining',v_remaining);
  end if;
 end loop;
 -- Each payable: this party, not cancelled, not already linked to the same prepayment,
 -- and requested total within its outstanding amount.
 for v_row in select (value->>'payableId')::bigint as id,sum((value->>'allocatedAmount')::numeric) as requested
   from jsonb_array_elements(v_allocations) group by 1 order by 1 loop
  select * into v_payable from public.ledger_payables where id=v_row.id;
  if v_payable.id is null or v_payable.party_id<>p_party_id or v_payable.status='cancelled' then
   return jsonb_build_object('status','payable_party_mismatch','payableId',v_row.id);
  end if;
  select v_payable.original_amount-coalesce(sum(a.allocated_amount),0) into v_outstanding from public.ledger_payable_allocations a where a.payable_id=v_payable.id;
  if v_row.requested>v_outstanding then
   return jsonb_build_object('status','amount_exceeds_outstanding','payableId',v_row.id,'outstanding',v_outstanding);
  end if;
  v_before:=v_before||jsonb_build_array(jsonb_build_object('payableId',v_payable.id,'outstanding',v_outstanding));
 end loop;
 if exists(select 1 from jsonb_array_elements(v_allocations) e join public.ledger_payable_allocations a
   on a.payable_id=(e.value->>'payableId')::bigint and a.payment_transaction_id=(e.value->>'prepaymentTransactionId')::bigint) then
  return jsonb_build_object('status','duplicate_allocation');
 end if;
 insert into public.ledger_payable_payment_requests(request_id,actor_user_id,request_payload) values(p_request_id,p_actor_user_id,v_payload);
 -- Each application month = greatest(prepayment date, receipt date) must be open. A
 -- closed earlier-month prepayment can be applied to an open later-month receipt; a
 -- receipt in a closed month cannot be changed (also enforced by the allocation guard).
 for v_row in select distinct greatest(t.business_date,e.business_date) as applied_on
   from jsonb_array_elements(v_allocations) x
   join public.ledger_transactions t on t.id=(x.value->>'prepaymentTransactionId')::bigint
   join public.ledger_payables p on p.id=(x.value->>'payableId')::bigint
   join public.ledger_transactions e on e.id=p.expense_transaction_id loop
  perform public.ledger_assert_month_open_v1(date_trunc('month',v_row.applied_on)::date);
 end loop;
 for v_item in select value from jsonb_array_elements(v_allocations) loop
  insert into public.ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount)
  values((v_item->>'payableId')::bigint,(v_item->>'prepaymentTransactionId')::bigint,(v_item->>'allocatedAmount')::numeric);
 end loop;
 for v_row in select distinct (value->>'payableId')::bigint as id from jsonb_array_elements(v_allocations) order by 1 loop
  select p.original_amount-coalesce(sum(a.allocated_amount),0),coalesce(sum(a.allocated_amount),0) into v_outstanding,v_sum
  from public.ledger_payables p left join public.ledger_payable_allocations a on a.payable_id=p.id where p.id=v_row.id group by p.id,p.original_amount;
  v_status:=case when v_sum=0 then 'unpaid' when v_outstanding=0 then 'paid' else 'partially_paid' end;
  update public.ledger_payables set status=v_status,updated_at=now() where id=v_row.id;
  v_after:=v_after||jsonb_build_array(jsonb_build_object('payableId',v_row.id,'outstanding',v_outstanding,'status',v_status));
 end loop;
 insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
 values(p_actor_user_id,'supplier_prepayment_applied','party',p_party_id,jsonb_build_object('payables',v_before),
  jsonb_build_object('partyId',p_party_id,'allocations',v_allocations,'payables',v_after),null);
 v_result:=jsonb_build_object('status','applied','allocations',v_allocations,'payables',v_after);
 update public.ledger_payable_payment_requests set result=v_result,completed_at=now() where request_id=p_request_id;
 return v_result;
end $$;

revoke all on function public.ledger_create_supplier_prepayment_v1(uuid,bigint,bigint,timestamptz,numeric,text,bigint) from public,anon,authenticated;
grant execute on function public.ledger_create_supplier_prepayment_v1(uuid,bigint,bigint,timestamptz,numeric,text,bigint) to service_role;
revoke all on function public.ledger_apply_supplier_prepayment_v1(uuid,bigint,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.ledger_apply_supplier_prepayment_v1(uuid,bigint,jsonb,bigint) to service_role;
