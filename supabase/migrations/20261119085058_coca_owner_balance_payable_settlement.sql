-- Installation only. Conversion of anchor #1 requires separate GPT/Owner
-- operational approval. Never changes the original anchor, payment or purchases.
begin;
set local lock_timeout='5s';

do $settlement_type$
declare v_check text;
begin
 select pg_get_expr(conbin,conrelid) into v_check from pg_constraint
 where conrelid='public.ledger_transactions'::regclass and conname='ledger_transactions_type_check';
 if v_check is null then raise exception 'OWNER_SETTLEMENT_TYPE_CONSTRAINT_MISSING';end if;
 alter table public.ledger_transactions drop constraint ledger_transactions_type_check;
 execute format('alter table public.ledger_transactions add constraint ledger_transactions_type_check check ((%s) or type=%L)',v_check,'owner_payable_settlement');
end $settlement_type$;
alter table public.ledger_transactions add constraint owner_payable_settlement_scope check(
 type<>'owner_payable_settlement' or (
  party_id=5 and business_date=date '2026-11-17' and amount=334048 and recognition_month is null
  and category_id is null and correction_of_id is null and economic_effect_sign=1
  and source_type='owner_payable_balance_settlement' and source_key='owner-payable-anchor:1:settlement'
  and source_snapshot @> '{"ownerBalanceAnchorId":1,"nonCash":true,"sourceUnverified":true}'::jsonb) is true);

create table public.ledger_payable_anchor_settlements(
 anchor_id bigint primary key references public.ledger_payable_balance_anchors(id) check(anchor_id=1),
 transaction_id bigint not null unique references public.ledger_transactions(id),
 payable_id bigint not null unique references public.ledger_payables(id),
 created_by bigint not null references public.users(id),
 created_at timestamptz not null default now(),
 reason text not null check(length(btrim(reason)) between 1 and 2000)
);
alter table public.ledger_payable_anchor_settlements enable row level security;
revoke all on public.ledger_payable_anchor_settlements from public,anon,authenticated,service_role;
grant select on public.ledger_payable_anchor_settlements to service_role;

-- Keep the original anchor's raw basis independent of the new settlement row.
create or replace function public.ledger_coca_payable_balance_v1(p_through_date date) returns numeric
language sql stable security invoker set search_path=pg_catalog,public as $$
 select coalesce(sum(greatest(p.original_amount-coalesce((select sum(a.allocated_amount)
   from public.ledger_payable_allocations a join public.ledger_transactions t on t.id=a.payment_transaction_id
   where a.payable_id=p.id and t.status='confirmed' and
     (case when t.source_snapshot->'prepayment'='true'::jsonb and t.business_date<=date '2026-11-17'
       and e.business_date<=date '2026-11-17'
       and a.created_at>(select created_at from public.ledger_payable_balance_anchors limit 1)
       then ((a.created_at at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date
       else t.business_date end)<=p_through_date),0),0)),0)
 from public.ledger_payables p join public.ledger_transactions e on e.id=p.expense_transaction_id
 where p.party_id=5 and p.status<>'cancelled' and e.status='confirmed'
   and e.type<>'owner_payable_settlement' and e.business_date<=p_through_date
   and coalesce(e.source_snapshot->>'paymentVerification','')<>'pending'
$$;

create function public.ledger_coca_owner_settlement_outstanding_v1(p_through_date date) returns numeric
language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_link public.ledger_payable_anchor_settlements%rowtype;v_anchor public.ledger_payable_balance_anchors%rowtype;v_paid numeric;
begin
 if p_through_date<date '2026-11-17' then return 0;end if;
 select * into v_link from public.ledger_payable_anchor_settlements where anchor_id=1;
 if not found then return 0;end if;
 select * into v_anchor from public.ledger_payable_balance_anchors where id=1;
 if not exists(select 1 from public.ledger_payables p join public.ledger_transactions e on e.id=p.expense_transaction_id
   where p.id=v_link.payable_id and e.id=v_link.transaction_id and p.party_id=5 and p.original_amount=334048
     and p.status<>'cancelled' and e.status='confirmed' and e.type='owner_payable_settlement'
     and e.business_date=date '2026-11-17' and e.amount=334048
     and e.source_type='owner_payable_balance_settlement' and e.source_key='owner-payable-anchor:1:settlement'
     and e.source_snapshot @> '{"ownerBalanceAnchorId":1,"nonCash":true,"sourceUnverified":true}'::jsonb)
   or exists(select 1 from public.ledger_movements where transaction_id=v_link.transaction_id) then
   raise exception 'OWNER_PAYABLE_SETTLEMENT_INVALID';end if;
 select coalesce(sum(a.allocated_amount),0) into v_paid
 from public.ledger_payable_allocations a join public.ledger_transactions t on t.id=a.payment_transaction_id
 where a.payable_id=v_link.payable_id and t.status='confirmed' and
   (case when t.source_snapshot->'prepayment'='true'::jsonb and t.business_date<=v_anchor.business_date and a.created_at>v_anchor.created_at
     then ((a.created_at at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date else t.business_date end)<=p_through_date;
 if v_paid>334048 then raise exception 'OWNER_PAYABLE_SETTLEMENT_OVERALLOCATED';end if;
 return 334048-v_paid;
end $$;
revoke all on function public.ledger_coca_owner_settlement_outstanding_v1(date) from public,anon,authenticated,service_role;

create or replace function public.ledger_owner_payable_anchor_adjustment_v1(p_through_date date) returns numeric
language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_anchor public.ledger_payable_balance_anchors%rowtype;v_legacy numeric;v_adjustment numeric;
begin
 select * into v_anchor from public.ledger_payable_balance_anchors where business_date<=p_through_date;
 if not found then return 0;end if;
 if public.ledger_coca_payable_balance_v1(v_anchor.business_date)<>v_anchor.app_balance then
   raise exception 'PAYABLE_BALANCE_ANCHOR_BASELINE_DRIFT';end if;
 v_adjustment:=case when exists(select 1 from public.ledger_payable_anchor_settlements where anchor_id=v_anchor.id) then 0 else v_anchor.adjustment_amount end;
 select coalesce(sum(p.original_amount-coalesce((select sum(a.allocated_amount)
   from public.ledger_payable_allocations a join public.ledger_transactions t on t.id=a.payment_transaction_id
   where a.payable_id=p.id and t.business_date<=p_through_date),0)),0) into v_legacy
 from public.ledger_payables p join public.ledger_transactions e on e.id=p.expense_transaction_id
 where p.party_id=5 and p.status<>'cancelled' and e.business_date<=p_through_date
   and coalesce(e.source_snapshot->>'paymentVerification','')<>'pending';
 return v_adjustment+public.ledger_coca_payable_balance_v1(p_through_date)
   +public.ledger_coca_owner_settlement_outstanding_v1(p_through_date)-v_legacy;
end $$;

create function public.ledger_convert_coca_owner_balance_anchor_v1(p_reason text,p_actor_user_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public set lock_timeout='5s' as $$
declare v_anchor public.ledger_payable_balance_anchors%rowtype;v_link public.ledger_payable_anchor_settlements%rowtype;v_tx bigint;v_payable bigint;
begin
 if not exists(select 1 from public.users where id=p_actor_user_id and lower(role::text) in('owner','master') and is_active and app_login_enabled) then
   return jsonb_build_object('status','forbidden');end if;
 if nullif(btrim(p_reason),'') is null or length(p_reason)>2000 then return jsonb_build_object('status','invalid_input');end if;
 perform pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));
 perform pg_advisory_xact_lock(hashtext('ledger_month_close'),hashtext('2026-11-01'));
 perform pg_advisory_xact_lock(hashtext('ledger_month_close:2026-11'));
 perform pg_advisory_xact_lock(hashtextextended('ledger-payable-party:5',0));
 select * into v_link from public.ledger_payable_anchor_settlements where anchor_id=1;
 if found then
   perform public.ledger_coca_owner_settlement_outstanding_v1(current_date);
   return jsonb_build_object('status','already_converted','transactionId',v_link.transaction_id,'payableId',v_link.payable_id);end if;
 perform public.ledger_assert_month_open_v1(date '2026-11-01');
 lock table public.ledger_transactions,public.ledger_payables,public.ledger_payable_allocations,public.ledger_movements in share row exclusive mode;
 select * into v_anchor from public.ledger_payable_balance_anchors where id=1 for update;
 if v_anchor.id is null or v_anchor.party_id<>5 or v_anchor.business_date<>date '2026-11-17'
   or v_anchor.owner_balance<>4982000 or v_anchor.app_balance<>4647952 or v_anchor.adjustment_amount<>334048
   or v_anchor.evidence_kind<>'owner_confirmation' or v_anchor.source_unverified<>true then
   raise exception 'COCA_OWNER_SETTLEMENT_ANCHOR_MISMATCH';end if;
 if public.ledger_coca_payable_balance_v1(date '2026-11-17')<>4647952 then raise exception 'PAYABLE_BALANCE_ANCHOR_BASELINE_DRIFT';end if;
 if not exists(select 1 from public.ledger_transactions where id=5097 and type='payable_payment' and party_id=5 and status='confirmed' and amount=6215888)
   or (select count(*) from public.ledger_payable_allocations where payment_transaction_id=5097)<>9
   or (select sum(allocated_amount) from public.ledger_payable_allocations where payment_transaction_id=5097)<>6215888
   or (select count(*) from public.ledger_movements where transaction_id=5097)<>1
   or not exists(select 1 from public.ledger_movements where id=2854 and transaction_id=5097 and fund_account_id=2 and amount=-6215888) then
   raise exception 'COCA_OWNER_SETTLEMENT_PAYMENT_DRIFT';end if;
 insert into public.ledger_transactions(operation_id,type,occurred_at,business_date,amount,party_id,status,source_type,source_key,source_snapshot,memo,created_by,confirmed_by)
 values(gen_random_uuid(),'owner_payable_settlement','2026-11-17T12:00:00+07',date '2026-11-17',334048,5,'confirmed',
   'owner_payable_balance_settlement','owner-payable-anchor:1:settlement',
   jsonb_build_object('ownerBalanceAnchorId',1,'nonCash',true,'sourceUnverified',true,'supplierStatementAvailable',false,
     'item_name','기준잔액 정산분','item_name_vi','Điều chỉnh số dư công nợ','unresolvedPaymentDifference',366112),
   btrim(p_reason),p_actor_user_id,p_actor_user_id) returning id into v_tx;
 insert into public.ledger_payables(expense_transaction_id,party_id,original_amount,status) values(v_tx,5,334048,'unpaid') returning id into v_payable;
 insert into public.ledger_payable_anchor_settlements(anchor_id,transaction_id,payable_id,created_by,reason)
 values(1,v_tx,v_payable,p_actor_user_id,btrim(p_reason));
 insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
 values(p_actor_user_id,'owner_payable_balance_anchor_converted','payable_balance_anchor',1,to_jsonb(v_anchor),
   jsonb_build_object('anchorId',1,'transactionId',v_tx,'payableId',v_payable,'amount',334048,'nonCash',true,'sourceUnverified',true,'legacyAdjustmentStillAdded',false),btrim(p_reason));
 return jsonb_build_object('status','converted','transactionId',v_tx,'payableId',v_payable,'amount',334048);
end $$;
revoke all on function public.ledger_convert_coca_owner_balance_anchor_v1(text,bigint) from public,anon,authenticated;
grant execute on function public.ledger_convert_coca_owner_balance_anchor_v1(text,bigint) to service_role;

commit;
