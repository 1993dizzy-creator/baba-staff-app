-- Additive, no historical ledger updates. V1 signature and existing guards stay intact.
create table public.ledger_payable_payment_requests (
 request_id uuid primary key,
 actor_user_id bigint not null references public.users(id),
 request_payload jsonb not null,
 result jsonb,
 payment_transaction_id bigint unique references public.ledger_transactions(id),
 created_at timestamptz not null default now(),
 completed_at timestamptz
);
alter table public.ledger_payable_payment_requests enable row level security;
revoke all on public.ledger_payable_payment_requests from public,anon,authenticated,service_role;

create function public.ledger_pay_payables_v2(
 p_request_id uuid,p_party_id bigint,p_fund_account_id bigint,p_occurred_at timestamptz,
 p_amount numeric,p_allocations jsonb,p_memo text,p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_role text; v_payload jsonb; v_allocations jsonb; v_item jsonb; v_result jsonb; v_validation_status text;
 v_existing public.ledger_payable_payment_requests%rowtype;
begin
 select lower(role::text) into v_role from public.users
 where id=p_actor_user_id and is_active=true and app_login_enabled=true;
 if coalesce(v_role,'') not in ('owner','master') then return jsonb_build_object('status','forbidden');end if;
 if p_request_id is null then return jsonb_build_object('status','idempotency_key_required');end if;
 if p_amount is null or p_amount<=0 or p_amount::text in ('NaN','Infinity','-Infinity') or round(p_amount,3)<>p_amount then
  v_validation_status:='invalid_amount';
 end if;
 if p_allocations is not null then
  if jsonb_typeof(p_allocations)<>'array' then
   v_validation_status:='invalid_allocations';v_allocations:=p_allocations;
  else
  begin
   for v_item in select value from jsonb_array_elements(p_allocations) loop
    if jsonb_typeof(v_item)<>'object' or not(v_item ? 'payableId' and v_item ? 'allocatedAmount')
      or (v_item - 'payableId' - 'allocatedAmount')<>'{}'::jsonb
      or (v_item->>'payableId')::bigint is null
      or (v_item->>'allocatedAmount')::numeric is null
      or (v_item->>'allocatedAmount')::numeric<=0
      or (v_item->>'allocatedAmount') in ('NaN','Infinity','-Infinity')
      or round((v_item->>'allocatedAmount')::numeric,3)<>(v_item->>'allocatedAmount')::numeric then
     v_validation_status:='invalid_allocations';exit;
    end if;
   end loop;
   if v_validation_status='invalid_allocations' then v_allocations:=p_allocations;
   else
    select coalesce(jsonb_agg(jsonb_build_object('payableId',(value->>'payableId')::bigint,
    'allocatedAmount',(value->>'allocatedAmount')::numeric) order by (value->>'payableId')::bigint),'[]'::jsonb)
    into v_allocations from jsonb_array_elements(p_allocations);
   end if;
  exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then
   v_validation_status:='invalid_allocations';v_allocations:=p_allocations;
  end;
  end if;
 end if;
 v_payload:=jsonb_build_object('partyId',p_party_id,'fundAccountId',p_fund_account_id,
  'occurredAt',to_char(p_occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'),
  'amount',p_amount,'allocations',v_allocations,'memo',nullif(btrim(p_memo),''));
 -- Lock the key before reading balances. Hash collisions only serialize unrelated work.
 perform pg_advisory_xact_lock(hashtextextended('ledger-payable-request:'||p_request_id::text,0));
 select * into v_existing from public.ledger_payable_payment_requests where request_id=p_request_id;
 if found then
  if v_existing.actor_user_id<>p_actor_user_id or v_existing.request_payload<>v_payload then
   return jsonb_build_object('status','idempotency_conflict');
  end if;
  -- A committed but incomplete record is not proof of an unpaid request.
  -- Never delete it, fabricate success, or execute V1 again under the same key.
  if v_existing.result is null or v_existing.completed_at is null
    or jsonb_typeof(v_existing.result) is distinct from 'object'
    or nullif(v_existing.result->>'status','') is null then
   return jsonb_build_object('status','idempotency_state_invalid');
  end if;
  return v_existing.result;
 end if;
 if v_validation_status is not null then return jsonb_build_object('status',v_validation_status);end if;
 -- One lock order for all V2 allocation modes; V1 retains its payable row locks.
 perform pg_advisory_xact_lock(hashtextextended('ledger-payable-party:'||p_party_id::text,0));
 insert into public.ledger_payable_payment_requests(request_id,actor_user_id,request_payload)
 values(p_request_id,p_actor_user_id,v_payload);
 v_result:=public.ledger_pay_payables_v1(p_party_id,p_fund_account_id,p_occurred_at,p_amount,v_allocations,p_memo,p_actor_user_id);
 update public.ledger_payable_payment_requests set result=v_result,completed_at=now(),
  payment_transaction_id=case when v_result->>'status'='paid' then (v_result->>'paymentTransactionId')::bigint else null end
 where request_id=p_request_id;
 return v_result;
 -- No exception handler: a payment/allocation/audit error rolls back the request too.
end $$;
revoke all on function public.ledger_pay_payables_v2(uuid,bigint,bigint,timestamptz,numeric,jsonb,text,bigint) from public,anon,authenticated;
grant execute on function public.ledger_pay_payables_v2(uuid,bigint,bigint,timestamptz,numeric,jsonb,text,bigint) to service_role;
