-- Post-close automatic fees and append-only cancellation. No existing data/backfill.
begin;
alter table public.ledger_card_fee_closures add column finalization_business_date date null
 check(finalization_business_date is null or fee_month<date_trunc('month',finalization_business_date)::date);
create schema ledger_card_fee_private;
revoke all on schema ledger_card_fee_private from public, anon, authenticated, service_role;

-- Database policy has one definition; TS preview parity is checked in isolated tests.
create function ledger_card_fee_private.policy() returns jsonb
language sql immutable as $$
 select '{"targetRate":0.0215,"minRate":0.018,"maxRate":0.025}'::jsonb
$$;

-- Transaction-scoped capability, matching the POS projection permission pattern.
-- Only the private finalizer can issue it. It is deleted before successful return.
create table ledger_card_fee_private.finalization_permissions(
 xact_id bigint primary key, fee_month date not null, closure_id bigint not null,
 expense_id bigint not null, deposit_id bigint not null, actor_id bigint not null,
 fee_amount numeric(16,3) not null check(fee_amount>0), business_date date not null
);
revoke all on table ledger_card_fee_private.finalization_permissions from public, anon, authenticated, service_role;

create function ledger_card_fee_private.allowed_transaction(p_tx public.ledger_transactions) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(
  select 1 from ledger_card_fee_private.finalization_permissions p
  join public.ledger_card_reconciliations r on r.id=p.deposit_id and r.status='auto_allocated'
  join public.ledger_transactions deposit on deposit.id=r.deposit_transaction_id and deposit.status='confirmed'
  join public.ledger_categories category on category.id=p_tx.category_id and category.kind='expense' and category.name='카드 정산 차액'
  where p.xact_id=txid_current() and p.expense_id=p_tx.id and p.fee_month=p_tx.recognition_month
   and p.business_date=p_tx.business_date and p.fee_amount=p_tx.amount
   and p_tx.type='expense_recognition' and p_tx.status='confirmed' and p_tx.economic_effect_sign=1
   and p_tx.source_type='card_fee_month_close' and p_tx.source_key='card-fee-closure:'||p.closure_id
   and p_tx.created_by=p.actor_id and p_tx.confirmed_by=p.actor_id and deposit.created_by=p.actor_id
   and p_tx.source_snapshot->>'autoConfirmed'='true'
   and (p_tx.source_snapshot->>'triggerDepositReconciliationId')::bigint=p.deposit_id
   and public.ledger_month_is_closed_v1(p.fee_month)
   and p.fee_month<date_trunc('month',p.business_date)::date
 )
$$;

create function ledger_card_fee_private.finalize_month(p_month date,p_deposit bigint,p_actor bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_policy jsonb:=ledger_card_fee_private.policy(); v_gross numeric; v_fee numeric; v_category bigint;
 v_closure bigint; v_tx bigint; v_clearing bigint; v_date date:=((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date;
 v_sale record; v_meta jsonb; v_lines jsonb:='[]';
begin
 if not public.ledger_month_is_closed_v1(p_month) or p_month>=date_trunc('month',v_date)::date
    or not exists(select 1 from public.ledger_card_reconciliations r join public.ledger_transactions t on t.id=r.deposit_transaction_id
      where r.id=p_deposit and r.status='auto_allocated' and t.status='confirmed' and t.created_by=p_actor and r.deposit_date>=(p_month+interval '1 month')::date)
 then raise exception 'CARD_FEE_AUTO_CONTEXT_INVALID'; end if;
 if exists(select 1 from public.ledger_card_fee_closures where fee_month=p_month and status='confirmed') then
  raise exception 'CARD_FEE_ALREADY_CONFIRMED';
 end if;
 select sum(t.amount),sum(t.amount-public.ledger_card_sale_consumed_v1(t.id)) into v_gross,v_fee
 from public.ledger_transactions t where t.status='confirmed' and t.source_type='pos_sales_daily_payment'
 and t.source_key like 'pos:%:card' and date_trunc('month',t.business_date)::date=p_month;
 if v_gross<=0 or v_fee<=0 or v_fee/v_gross<(v_policy->>'minRate')::numeric or v_fee/v_gross>(v_policy->>'maxRate')::numeric then
  raise exception 'CARD_FEE_REVIEW_REQUIRED';
 end if;
 perform public.ledger_assert_month_open_v1(date_trunc('month',v_date)::date);
 select id into v_category from public.ledger_categories where kind='expense' and name='카드 정산 차액' and is_active;
 select id into v_clearing from public.ledger_fund_accounts where code='card_clearing' and is_active;
 if v_category is null or v_clearing is null then raise exception 'CARD_FEE_ACCOUNT_OR_CATEGORY_MISSING'; end if;
 if (select coalesce(sum(m.amount),0) from public.ledger_movements m join public.ledger_transactions t on t.id=m.transaction_id
     where m.fund_account_id=v_clearing and t.status='confirmed')<v_fee then raise exception 'CARD_FEE_INSUFFICIENT_CLEARING'; end if;
 v_closure:=nextval(pg_get_serial_sequence('public.ledger_card_fee_closures','id'));
 v_tx:=nextval(pg_get_serial_sequence('public.ledger_transactions','id'));
 v_meta:=jsonb_build_object('closureId',v_closure,'feeMonth',p_month,'feeAmount',v_fee,'autoConfirmed',true,
  'triggerDepositReconciliationId',p_deposit,'policyTargetRate',v_policy->'targetRate','policyMinRate',v_policy->'minRate','policyMaxRate',v_policy->'maxRate');
 insert into ledger_card_fee_private.finalization_permissions values(txid_current(),p_month,v_closure,v_tx,p_deposit,p_actor,v_fee,v_date);
 -- Movement/business date is the actual finalization day. Only P&L recognition is historical.
 insert into public.ledger_transactions(id,operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,
  status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,memo,created_by,confirmed_by)
 values(v_tx,gen_random_uuid(),'expense_recognition',now(),v_date,p_month,v_fee,v_category,'confirmed','card_fee_month_close',
  'card-fee-closure:'||v_closure,v_meta,md5(v_meta::text),now(),'Card fee auto-finalization',p_actor,p_actor);
 insert into public.ledger_movements(transaction_id,fund_account_id,amount) values(v_tx,v_clearing,-v_fee);
 insert into public.ledger_card_fee_closures(id,fee_month,fee_amount,expense_transaction_id,status,confirmed_at,confirmed_by,memo,finalization_business_date)
 values(v_closure,p_month,v_fee,v_tx,'confirmed',now(),p_actor,'autoConfirmed: deposit '||p_deposit,v_date);
 for v_sale in select t.id,t.amount-public.ledger_card_sale_consumed_v1(t.id) outstanding
  from public.ledger_transactions t where t.status='confirmed' and t.source_type='pos_sales_daily_payment' and t.source_key like 'pos:%:card'
  and date_trunc('month',t.business_date)::date=p_month and t.amount-public.ledger_card_sale_consumed_v1(t.id)>0 order by t.business_date,t.id
 loop
  insert into public.ledger_card_fee_allocation_lines(closure_id,pos_card_transaction_id,allocated_fee_amount) values(v_closure,v_sale.id,v_sale.outstanding);
  v_lines:=v_lines||jsonb_build_array(jsonb_build_object('transactionId',v_sale.id,'allocatedFeeAmount',v_sale.outstanding));
 end loop;
 if (select coalesce(sum(allocated_fee_amount),0) from public.ledger_card_fee_allocation_lines where closure_id=v_closure)<>v_fee then
  raise exception 'CARD_FEE_ALLOCATION_MISMATCH';
 end if;
 insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,after_snapshot,reason)
 values(p_actor,'card_fee_month_confirmed','card_fee_closure',v_closure,v_meta||jsonb_build_object('cardGross',v_gross,'expenseTransactionId',v_tx,'lines',v_lines),'Automatic post-close finalization');
 delete from ledger_card_fee_private.finalization_permissions where xact_id=txid_current();
 return v_meta||jsonb_build_object('status','confirmed','expenseTransactionId',v_tx);
end $$;

-- Reversal authority is separate from confirmation authority and cannot be issued
-- by a caller. It authorizes one exact reversal and one closure state transition.
create table ledger_card_fee_private.cancellation_permissions(
 xact_id bigint primary key, closure_id bigint not null, original_id bigint not null,
 reversal_id bigint not null, actor_id bigint not null, fee_month date not null,
 fee_amount numeric(16,3) not null check(fee_amount>0), business_date date not null,
 cancelled_at timestamptz not null, reason text not null check(btrim(reason)<>'')
);
revoke all on table ledger_card_fee_private.cancellation_permissions from public,anon,authenticated,service_role;
alter table ledger_card_fee_private.cancellation_permissions enable row level security;

create function ledger_card_fee_private.allowed_reversal(p_tx public.ledger_transactions) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(
  select 1 from ledger_card_fee_private.cancellation_permissions p
  join public.ledger_card_fee_closures c on c.id=p.closure_id and c.status='confirmed'
  join public.ledger_transactions original on original.id=p.original_id and original.status='confirmed'
  where p.xact_id=txid_current() and p.reversal_id=p_tx.id
   and c.expense_transaction_id=original.id and c.fee_month=p.fee_month and c.fee_amount=p.fee_amount
   and c.finalization_business_date=original.business_date and c.finalization_business_date>c.fee_month
   and original.source_type='card_fee_month_close' and original.source_snapshot->>'autoConfirmed'='true'
   and original.source_key='card-fee-closure:'||c.id and original.recognition_month=c.fee_month
   and original.amount=c.fee_amount and original.economic_effect_sign=1
   and p_tx.type='expense_recognition' and p_tx.status='confirmed' and p_tx.economic_effect_sign=-1
   and p_tx.source_type='card_fee_month_close_reversal' and p_tx.source_key='card-fee-closure:'||c.id||':reversal'
   and p_tx.correction_of_id=original.id and p_tx.category_id=original.category_id
   and p_tx.party_id is not distinct from original.party_id
   and p_tx.amount=p.fee_amount and p_tx.recognition_month=p.fee_month and p_tx.business_date=p.business_date
   and p_tx.occurred_at=p.cancelled_at and p_tx.created_by=p.actor_id and p_tx.confirmed_by=p.actor_id
   and p_tx.source_snapshot->>'autoConfirmed'='true' and p_tx.source_snapshot->>'autoCancellation'='true'
   and p_tx.source_snapshot->>'cancelReason'=p.reason
   and p_tx.source_snapshot->>'closureId'=p.closure_id::text
   and p_tx.source_snapshot->>'originalTransactionId'=p.original_id::text
   and p.fee_month<date_trunc('month',p.business_date)::date
 )
$$;

create function ledger_card_fee_private.cancel_auto_month(p_closure bigint,p_reason text,p_actor bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_closure public.ledger_card_fee_closures%rowtype; v_original public.ledger_transactions%rowtype;
 v_month date;v_lock_month date;v_date date:=((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date;
 v_clearing bigint;v_reversal bigint;v_meta jsonb;v_before jsonb;
begin
 if not exists(select 1 from public.users where id=p_actor and is_active and app_login_enabled and lower(role::text) in('owner','master')) then
  return jsonb_build_object('status','forbidden');end if;
 if nullif(btrim(p_reason),'') is null then return jsonb_build_object('status','reason_required');end if;
 select fee_month into v_month from public.ledger_card_fee_closures where id=p_closure;
 if v_month is null then return jsonb_build_object('status','not_found');end if;
 perform pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));
 for v_lock_month in select distinct m from (values(v_month),(date_trunc('month',v_date)::date)) months(m) order by m loop
  perform pg_advisory_xact_lock(hashtext('ledger_month_close'),hashtext(v_lock_month::text));
  perform pg_advisory_xact_lock(hashtext('ledger_month_close:'||to_char(v_lock_month,'YYYY-MM')));
 end loop;
 perform pg_advisory_xact_lock(hashtext('ledger_card_clearing_balance'));
 select * into v_closure from public.ledger_card_fee_closures where id=p_closure for update;
 if v_closure.status='cancelled' then return jsonb_build_object('status','already_cancelled','cancelledAt',v_closure.cancelled_at,'cancelledBy',v_closure.cancelled_by);end if;
 if public.ledger_month_is_closed_v1(date_trunc('month',v_date)::date) then return jsonb_build_object('status','month_closed');end if;
 select * into v_original from public.ledger_transactions where id=v_closure.expense_transaction_id for update;
 select id into v_clearing from public.ledger_fund_accounts where code='card_clearing' for update;
 if v_original.id is null or v_clearing is null or v_closure.fee_amount<=0
  or v_closure.finalization_business_date is null or v_closure.fee_month>=date_trunc('month',v_date)::date
  or v_original.business_date is distinct from v_closure.finalization_business_date
  or v_original.source_snapshot->>'autoConfirmed' is distinct from 'true'
  or v_original.status<>'confirmed' or v_original.type<>'expense_recognition'
  or v_original.source_type<>'card_fee_month_close' or v_original.source_key is distinct from 'card-fee-closure:'||v_closure.id
  or v_original.amount<>v_closure.fee_amount or v_original.recognition_month is distinct from v_closure.fee_month
  or v_original.economic_effect_sign<>1
  or (select count(*) from public.ledger_movements where transaction_id=v_original.id)<>1
  or (select coalesce(sum(amount),0) from public.ledger_movements where transaction_id=v_original.id and fund_account_id=v_clearing)<>-v_closure.fee_amount
  or (select coalesce(sum(allocated_fee_amount),0) from public.ledger_card_fee_allocation_lines where closure_id=p_closure)<>v_closure.fee_amount
 then return jsonb_build_object('status','invalid_state');end if;
 if exists(select 1 from public.ledger_transactions where source_key='card-fee-closure:'||p_closure||':reversal'
  or (correction_of_id=v_original.id and source_type='card_fee_month_close_reversal')) then return jsonb_build_object('status','already_cancelled');end if;
 v_before:=jsonb_build_object('closure',to_jsonb(v_closure),'expenseTransaction',to_jsonb(v_original),
  'lines',(select jsonb_agg(to_jsonb(f) order by f.id) from public.ledger_card_fee_allocation_lines f where f.closure_id=p_closure));
 v_reversal:=nextval(pg_get_serial_sequence('public.ledger_transactions','id'));
 v_meta:=jsonb_build_object('closureId',p_closure,'originalTransactionId',v_original.id,'cancelReason',btrim(p_reason),'autoConfirmed',true,'autoCancellation',true);
 insert into ledger_card_fee_private.cancellation_permissions values(txid_current(),p_closure,v_original.id,v_reversal,p_actor,v_month,v_closure.fee_amount,v_date,now(),btrim(p_reason));
 insert into public.ledger_transactions(id,operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,party_id,
  status,source_type,source_key,source_snapshot,source_fingerprint,source_synced_at,correction_of_id,memo,created_by,confirmed_by,economic_effect_sign)
 values(v_reversal,gen_random_uuid(),'expense_recognition',now(),v_date,v_month,v_closure.fee_amount,v_original.category_id,v_original.party_id,
  'confirmed','card_fee_month_close_reversal','card-fee-closure:'||p_closure||':reversal',v_meta,md5(v_meta::text),now(),v_original.id,
  'Post-close card fee cancellation: '||btrim(p_reason),p_actor,p_actor,-1);
 insert into public.ledger_movements(transaction_id,fund_account_id,amount) values(v_reversal,v_clearing,v_closure.fee_amount);
 update public.ledger_card_fee_closures set status='cancelled',cancelled_at=now(),cancelled_by=p_actor,cancel_reason=btrim(p_reason),updated_at=now() where id=p_closure;
 insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
 values(p_actor,'card_fee_month_cancelled','card_fee_closure',p_closure,v_before,
  v_meta||jsonb_build_object('feeMonth',v_month,'feeAmount',v_closure.fee_amount,'reversalTransactionId',v_reversal,'status','cancelled',
   'preservedLineCount',(select count(*) from public.ledger_card_fee_allocation_lines where closure_id=p_closure)),btrim(p_reason));
 delete from ledger_card_fee_private.cancellation_permissions where xact_id=txid_current();
 return jsonb_build_object('status','cancelled','closureId',p_closure,'feeMonth',v_month,'reversalTransactionId',v_reversal);
end $$;

-- Preserve the legacy cancellation implementation and permissions. Only genuine
-- automatic post-close closures route to the narrow append-only reversal path.
do $cancel_rpc$
declare v_definition text;v_anchor text:='  select fee_month into v_month from public.ledger_card_fee_closures where id = p_closure_id;';
begin
 v_definition:=pg_get_functiondef('public.ledger_cancel_card_fee_month_v1(bigint,text,bigint)'::regprocedure);
 if position(v_anchor in v_definition)=0 then raise exception 'CARD_FEE_CANCEL_CONTRACT_MISMATCH';end if;
 v_definition:=replace(v_definition,v_anchor,$route$
  if exists(select 1 from public.ledger_card_fee_closures c join public.ledger_transactions t on t.id=c.expense_transaction_id
   where c.id=p_closure_id and c.finalization_business_date is not null and t.source_snapshot->>'autoConfirmed'='true') then
   return ledger_card_fee_private.cancel_auto_month(p_closure_id,p_reason,p_actor_user_id);
  end if;
$route$||v_anchor);
 execute v_definition;
end $cancel_rpc$;

create or replace function public.ledger_transaction_month_guard_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_old_month date;v_old_business date;v_new_month date;v_new_business date;
begin
 if tg_op='INSERT' and (ledger_card_fee_private.allowed_transaction(new) or ledger_card_fee_private.allowed_reversal(new)) then
  perform public.ledger_assert_month_open_v1(date_trunc('month',new.business_date)::date);
  return new;
 end if;
 if tg_op<>'INSERT' then v_old_month:=old.recognition_month;v_old_business:=date_trunc('month',old.business_date)::date;end if;
 if tg_op<>'DELETE' then v_new_month:=new.recognition_month;v_new_business:=date_trunc('month',new.business_date)::date;end if;
 perform public.ledger_assert_month_open_v1(v_old_month);perform public.ledger_assert_month_open_v1(v_old_business);
 perform public.ledger_assert_month_open_v1(v_new_month);perform public.ledger_assert_month_open_v1(v_new_business);
 return case when tg_op='DELETE' then old else new end;
end$$;

create or replace function public.ledger_movement_month_guard_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id bigint;v_tx public.ledger_transactions%rowtype;
begin
 v_id:=case when tg_op='DELETE' then old.transaction_id else new.transaction_id end;
 select * into v_tx from public.ledger_transactions where id=v_id;
 if tg_op='INSERT' and ((ledger_card_fee_private.allowed_transaction(v_tx) and new.amount=-v_tx.amount)
    or (ledger_card_fee_private.allowed_reversal(v_tx) and new.amount=v_tx.amount))
    and exists(select 1 from public.ledger_fund_accounts where id=new.fund_account_id and code='card_clearing' and is_active)
    and not exists(select 1 from public.ledger_movements where transaction_id=v_tx.id) then
  perform public.ledger_assert_month_open_v1(date_trunc('month',v_tx.business_date)::date);
  return new;
 end if;
 perform public.ledger_assert_month_open_v1(v_tx.recognition_month);
 perform public.ledger_assert_month_open_v1(date_trunc('month',v_tx.business_date)::date);
 return case when tg_op='DELETE' then old else new end;
end$$;

create or replace function public.ledger_card_fee_closure_month_guard_v1() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op='UPDATE' and old.status='confirmed' and new.status='cancelled'
    and (to_jsonb(new)-array['status','cancelled_at','cancelled_by','cancel_reason','updated_at'])
      =(to_jsonb(old)-array['status','cancelled_at','cancelled_by','cancel_reason','updated_at'])
    and exists(select 1 from ledger_card_fee_private.cancellation_permissions p
      join public.ledger_transactions t on t.id=p.reversal_id
      where p.xact_id=txid_current() and p.closure_id=old.id and p.original_id=old.expense_transaction_id
       and p.fee_month=old.fee_month and p.fee_amount=old.fee_amount
       and p.actor_id=new.cancelled_by and p.reason=new.cancel_reason and p.cancelled_at=new.cancelled_at and p.cancelled_at=new.updated_at
       and ledger_card_fee_private.allowed_reversal(t)
       and (select count(*) from public.ledger_movements where transaction_id=t.id)=1
       and (select coalesce(sum(m.amount),0) from public.ledger_movements m join public.ledger_fund_accounts f on f.id=m.fund_account_id
         where m.transaction_id=t.id and f.code='card_clearing')=p.fee_amount
    ) then return new;end if;
  if tg_op='INSERT' and new.status='confirmed' and exists(
    select 1 from ledger_card_fee_private.finalization_permissions p
    join public.ledger_transactions t on t.id=p.expense_id
    where p.xact_id=txid_current() and p.closure_id=new.id and p.fee_month=new.fee_month
      and p.fee_amount=new.fee_amount and p.expense_id=new.expense_transaction_id
      and p.actor_id=new.confirmed_by and p.business_date=new.finalization_business_date and ledger_card_fee_private.allowed_transaction(t)
  ) then return new; end if;
  perform public.ledger_assert_month_open_v1(case when tg_op = 'DELETE' then old.fee_month else new.fee_month end);
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create or replace function public.ledger_card_fee_line_month_guard_v1() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_month date;
begin
  select fee_month into v_month from public.ledger_card_fee_closures
  where id = case when tg_op = 'DELETE' then old.closure_id else new.closure_id end;
  if tg_op='INSERT' and exists(
    select 1 from ledger_card_fee_private.finalization_permissions p
    join public.ledger_card_fee_closures c on c.id=p.closure_id and c.status='confirmed'
    join public.ledger_transactions t on t.id=new.pos_card_transaction_id
    where p.xact_id=txid_current() and p.closure_id=new.closure_id and p.fee_month=v_month
      and t.status='confirmed' and t.source_type='pos_sales_daily_payment' and t.source_key like 'pos:%:card'
      and date_trunc('month',t.business_date)::date=v_month
      and new.allocated_fee_amount>0 and new.allocated_fee_amount<=t.amount-public.ledger_card_sale_consumed_v1(t.id)
  ) then return new; end if;
  perform public.ledger_assert_month_open_v1(v_month);
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create or replace function public.ledger_create_card_deposit_auto_allocate_v1(
  p_deposit_at timestamptz,
  p_amount numeric,
  p_destination_account_id bigint,
  p_memo text,
  p_actor_user_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
  v_policy jsonb:=ledger_card_fee_private.policy();
  v_current_month date:=date_trunc('month',((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date)::date;
  v_sale_month record; v_month_payment numeric; v_month_fee numeric; v_total_fee numeric:=0;
  v_fees jsonb:='[]'; v_fee_result jsonb:='[]'; v_fee_item jsonb; v_line jsonb; v_lock_month date;
  v_clearing bigint;
  v_bank bigint;
  v_balance numeric;
  v_available numeric;
  v_remaining numeric;
  v_allocated numeric;
  v_transaction bigint;
  v_reconciliation bigint;
  v_operation uuid := gen_random_uuid();
  v_date date;
  v_month date;
  v_sale record;
  v_allocations jsonb := '[]'::jsonb;
begin
  select lower(role::text) into v_role
  from public.users
  where id = p_actor_user_id and is_active = true and app_login_enabled = true;
  if coalesce(v_role, '') not in ('owner', 'master') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_deposit_at is null or p_amount is null or p_amount <= 0 or scale(p_amount) > 3 then
    return jsonb_build_object('status', 'invalid_amount');
  end if;

  v_date := ((p_deposit_at at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date;
  v_month := date_trunc('month', v_date)::date;
  -- Same lock order as create/match/cancel: month close, then card clearing balance.
  perform pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));
  -- Every affected month lock comes before the shared clearing lock, in ascending order.
  for v_lock_month in select m from (
   select distinct date_trunc('month',business_date)::date m from public.ledger_transactions
    where status='confirmed' and source_type='pos_sales_daily_payment' and source_key like 'pos:%:card' and business_date<=v_date
   union select v_month union select v_current_month
  ) months order by m loop
   perform pg_advisory_xact_lock(hashtext('ledger_month_close'),hashtext(v_lock_month::text));
   perform pg_advisory_xact_lock(hashtext('ledger_month_close:'||to_char(v_lock_month,'YYYY-MM')));
  end loop;
  if public.ledger_month_is_closed_v1(v_month) then
    return jsonb_build_object('status', 'month_closed');
  end if;
  perform pg_advisory_xact_lock(hashtext('ledger_card_clearing_balance'));

  select id into v_clearing
  from public.ledger_fund_accounts
  where code = 'card_clearing' and is_active = true
  for update;
  if v_clearing is null then return jsonb_build_object('status', 'card_clearing_missing'); end if;

  -- Card deposits always land in the BABA corporate bank account.
  select id into v_bank
  from public.ledger_fund_accounts
  where code = 'baba_corporate_bank' and is_active = true and type <> 'card_clearing';
  if v_bank is null then return jsonb_build_object('status', 'corporate_bank_missing'); end if;
  if p_destination_account_id is distinct from v_bank then
    return jsonb_build_object('status', 'invalid_destination');
  end if;

  select coalesce(sum(m.amount), 0) into v_balance
  from public.ledger_movements m
  join public.ledger_transactions t on t.id = m.transaction_id
  where m.fund_account_id = v_clearing and t.status = 'confirmed';
  if v_balance < p_amount then
    return jsonb_build_object('status', 'insufficient_card_pending', 'pendingBalance', v_balance);
  end if;

  -- Lock candidate sales in id order (the match RPC's order) before reading balances.
  perform 1
  from public.ledger_transactions
  where status = 'confirmed'
    and source_type = 'pos_sales_daily_payment'
    and source_key like 'pos:%:card'
    and business_date <= v_date
  order by id
  for update;

  -- Outstanding = sale gross minus every non-cancelled allocation (legacy partial lines included)
  -- and every active month-end card fee allocation, so fee-consumed gross is never re-paid.
  select coalesce(sum(outstanding), 0) into v_available
  from (
    select c.id, c.business_date, c.outstanding
    from (
      select t.id, t.business_date,
        t.amount - public.ledger_card_sale_consumed_v1(t.id) as outstanding
      from public.ledger_transactions t
      where t.status = 'confirmed'
        and t.source_type = 'pos_sales_daily_payment'
        and t.source_key like 'pos:%:card'
        and t.business_date <= v_date
    ) c
    where c.outstanding > 0
  ) eligible;
  if v_available < p_amount then
    return jsonb_build_object(
      'status', 'insufficient_unsettled_card_sales',
      'availableOutstanding', v_available,
      'depositAmount', p_amount
    );
  end if;

  -- Corruption / unresolved legacy deposits cannot be converted into an estimated fee.
  if exists(select 1 from public.ledger_transactions t where t.status='confirmed' and t.source_type='pos_sales_daily_payment'
      and t.source_key like 'pos:%:card' and public.ledger_card_sale_consumed_v1(t.id)>t.amount)
     or exists(select 1 from public.ledger_card_reconciliations r where
      (r.status='auto_allocated' and r.deposit_amount<>(select coalesce(sum(l.allocated_gross_amount),0) from public.ledger_card_reconciliation_lines l where l.reconciliation_id=r.id))
      or (r.status='matched' and r.matched_gross_amount<>(select coalesce(sum(l.allocated_gross_amount),0) from public.ledger_card_reconciliation_lines l where l.reconciliation_id=r.id)))
     or exists(select 1 from public.ledger_card_fee_closures c where c.status='confirmed'
      and c.fee_amount<>(select coalesce(sum(f.allocated_fee_amount),0) from public.ledger_card_fee_allocation_lines f where f.closure_id=c.id))
  then return jsonb_build_object('status','card_data_invalid'); end if;

  -- Plan first, before writing a transaction or fee. Preserve exact deposit principal.
  v_remaining:=p_amount;
  for v_sale_month in
   select date_trunc('month',t.business_date)::date sale_month,sum(t.amount) gross,
    sum(t.amount-public.ledger_card_sale_consumed_v1(t.id)) outstanding
   from public.ledger_transactions t where t.status='confirmed' and t.source_type='pos_sales_daily_payment'
    and t.source_key like 'pos:%:card' and t.business_date<=v_date
   group by 1 having sum(t.amount-public.ledger_card_sale_consumed_v1(t.id))>0 order by 1
  loop
   exit when v_remaining<=0;
   v_month_fee:=0;
   v_month_payment:=least(v_remaining,v_sale_month.outstanding);
   if v_sale_month.sale_month<v_month and v_sale_month.sale_month<v_current_month
     and public.ledger_month_is_closed_v1(v_sale_month.sale_month)
     and not exists(select 1 from public.ledger_card_fee_closures c where c.fee_month=v_sale_month.sale_month and c.status='confirmed') then
    if exists(select 1 from public.ledger_card_reconciliations r where r.status in('unmatched','partial') and r.deposit_date>=v_sale_month.sale_month)
       or v_sale_month.gross<=0 or v_sale_month.outstanding/v_sale_month.gross<(v_policy->>'minRate')::numeric then
     return jsonb_build_object('status','card_fee_review_required','feeMonth',v_sale_month.sale_month,'remainingAmount',v_sale_month.outstanding);
    end if;
    if v_sale_month.outstanding/v_sale_month.gross<=(v_policy->>'maxRate')::numeric then
     v_month_fee:=v_sale_month.outstanding;
     v_month_payment:=0;
    elsif (v_sale_month.outstanding-v_month_payment)/v_sale_month.gross between (v_policy->>'minRate')::numeric and (v_policy->>'maxRate')::numeric then
     v_month_fee:=v_sale_month.outstanding-v_month_payment;
    elsif (v_sale_month.outstanding-v_month_payment)/v_sale_month.gross<(v_policy->>'minRate')::numeric then
     -- Overshoot: stop at target, and carry the unused deposit to the next sale month.
     v_month_fee:=round(v_sale_month.gross*(v_policy->>'targetRate')::numeric,3);
     v_month_payment:=v_sale_month.outstanding-v_month_fee;
    end if;
    if v_month_fee>0 then
     if v_month_fee/v_sale_month.gross not between (v_policy->>'minRate')::numeric and (v_policy->>'maxRate')::numeric then
      return jsonb_build_object('status','card_fee_review_required','feeMonth',v_sale_month.sale_month);
     end if;
     v_fees:=v_fees||jsonb_build_array(jsonb_build_object('month',v_sale_month.sale_month,'amount',v_month_fee));
     v_total_fee:=v_total_fee+v_month_fee;
    end if;
   end if;
   v_remaining:=v_remaining-v_month_payment;
   for v_sale in select t.id,t.business_date,t.amount-public.ledger_card_sale_consumed_v1(t.id) outstanding
    from public.ledger_transactions t where t.status='confirmed' and t.source_type='pos_sales_daily_payment'
     and t.source_key like 'pos:%:card' and t.business_date<=v_date
     and date_trunc('month',t.business_date)::date=v_sale_month.sale_month
     and t.amount-public.ledger_card_sale_consumed_v1(t.id)>0 order by t.business_date,t.id
   loop
    exit when v_month_payment<=0;
    v_allocated:=least(v_month_payment,v_sale.outstanding);
    v_allocations:=v_allocations||jsonb_build_array(jsonb_build_object('transactionId',v_sale.id,'businessDate',v_sale.business_date,
     'outstandingBefore',v_sale.outstanding,'allocatedAmount',v_allocated,'outstandingAfter',v_sale.outstanding-v_allocated));
    v_month_payment:=v_month_payment-v_allocated;
   end loop;
  end loop;
  if v_remaining<>0 then
   return jsonb_build_object('status','insufficient_unsettled_card_sales','availableOutstanding',p_amount-v_remaining,'depositAmount',p_amount);
  end if;
  if v_balance<p_amount+v_total_fee then return jsonb_build_object('status','insufficient_card_pending','pendingBalance',v_balance); end if;
  if v_total_fee>0 then
   perform public.ledger_assert_month_open_v1(date_trunc('month',((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date)::date);
  end if;

  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, amount, status, source_type,
    source_snapshot, source_fingerprint, source_synced_at, memo, created_by, confirmed_by
  ) values (
    v_operation, 'card_settlement_deposit', p_deposit_at, v_date, p_amount, 'confirmed',
    'card_settlement_deposit',
    jsonb_build_object(
      'depositAmount', p_amount,
      'destinationFundAccountId', v_bank,
      'allocationMode', 'fifo_auto'
    ),
    md5(v_operation::text || ':' || p_amount::text), now(), nullif(btrim(p_memo), ''),
    p_actor_user_id, p_actor_user_id
  ) returning id into v_transaction;

  insert into public.ledger_movements(transaction_id, fund_account_id, amount)
  values
    (v_transaction, v_clearing, -p_amount),
    (v_transaction, v_bank, p_amount);

  insert into public.ledger_card_reconciliations(
    deposit_transaction_id, deposit_date, destination_fund_account_id, deposit_amount,
    matched_gross_amount, difference_amount, status, memo
  ) values (
    v_transaction, v_date, v_bank, p_amount, p_amount, 0, 'auto_allocated', nullif(btrim(p_memo), '')
  ) returning id into v_reconciliation;

  for v_line in select value from jsonb_array_elements(v_allocations) loop
   insert into public.ledger_card_reconciliation_lines(reconciliation_id,pos_card_transaction_id,allocated_gross_amount)
   values(v_reconciliation,(v_line->>'transactionId')::bigint,(v_line->>'allocatedAmount')::numeric);
  end loop;
  if (select sum(allocated_gross_amount) from public.ledger_card_reconciliation_lines where reconciliation_id=v_reconciliation)<>p_amount then
   raise exception 'CARD_DEPOSIT_ALLOCATION_MISMATCH';
  end if;
  for v_fee_item in select value from jsonb_array_elements(v_fees) loop
   v_fee_result:=v_fee_result||jsonb_build_array(ledger_card_fee_private.finalize_month((v_fee_item->>'month')::date,v_reconciliation,p_actor_user_id));
  end loop;

  insert into public.ledger_audit_logs(
    actor_user_id, action, entity_type, entity_id, after_snapshot, reason
  ) values (
    p_actor_user_id, 'card_deposit_auto_allocated', 'card_reconciliation', v_reconciliation,
    jsonb_build_object(
      'depositTransactionId', v_transaction,
      'bankAccountId', v_bank,
      'depositAmount', p_amount,
      'beforePendingBalance', v_balance,
      'afterPendingBalance', v_balance - p_amount - v_total_fee,
      'autoFeeClosures', v_fee_result,
      'allocations', v_allocations,
      'matchedGrossAmount', p_amount,
      'differenceAmount', 0,
      'status', 'auto_allocated'
    ),
    nullif(btrim(p_memo), '')
  );
  return jsonb_build_object(
    'status', 'created',
    'reconciliationId', v_reconciliation,
    'transactionId', v_transaction,
    'totalAllocated', p_amount,
    'allocations', v_allocations,
    'autoFeeClosures', v_fee_result
  );
exception
  when check_violation or foreign_key_violation or not_null_violation then
    return jsonb_build_object('status', 'invalid_input');
end;
$$;

-- Preserve every existing preflight contract, replacing only fee-pending blocking.
do $preflight$
declare v_definition text;v_anchor text;
begin
 v_definition:=pg_get_functiondef('public.ledger_close_preflight_v1(date,bigint)'::regprocedure);
 v_anchor:=$anchor$v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','CARD_FEE_NOT_CONFIRMED','amount',v_card_outstanding));$anchor$;
 if position(v_anchor in v_definition)=0 then raise exception 'CARD_FEE_PREFLIGHT_CONTRACT_MISMATCH';end if;
 v_definition:=replace(v_definition,v_anchor,$replacement$v_warnings:=v_warnings||jsonb_build_array(jsonb_build_object('code','CARD_FEE_PENDING','amount',v_card_outstanding));$replacement$);
 if position(' v_token:=md5(' in v_definition)=0 then raise exception 'CARD_FEE_PREFLIGHT_HASH_ANCHOR_MISSING';end if;
 v_definition:=replace(v_definition,' v_token:=md5(',$checks$
 if (select coalesce(sum(m.amount),0) from public.ledger_movements m join public.ledger_transactions t on t.id=m.transaction_id
     join public.ledger_fund_accounts f on f.id=m.fund_account_id where f.code='card_clearing' and t.status='confirmed')<0 then
  v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','CARD_CLEARING_NEGATIVE'));end if;
 if exists(select 1 from public.ledger_card_reconciliations r where
  (r.status='auto_allocated' and r.deposit_amount<>(select coalesce(sum(l.allocated_gross_amount),0) from public.ledger_card_reconciliation_lines l where l.reconciliation_id=r.id))
  or (r.status='matched' and r.matched_gross_amount<>(select coalesce(sum(l.allocated_gross_amount),0) from public.ledger_card_reconciliation_lines l where l.reconciliation_id=r.id))) then
  v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','CARD_ALLOCATION_MISMATCH'));end if;
 if exists(select 1 from public.ledger_card_fee_closures c where c.status='confirmed' and
  c.fee_amount<>(select coalesce(sum(f.allocated_fee_amount),0) from public.ledger_card_fee_allocation_lines f where f.closure_id=c.id)) then
  v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code','CARD_FEE_ALLOCATION_MISMATCH'));end if;
 v_token:=md5($checks$);
 execute v_definition;
end $preflight$;

alter table ledger_card_fee_private.finalization_permissions enable row level security;
revoke all on all functions in schema ledger_card_fee_private from public,anon,authenticated,service_role;
revoke all on function public.ledger_create_card_deposit_auto_allocate_v1(timestamptz,numeric,bigint,text,bigint) from public,anon,authenticated;
grant execute on function public.ledger_create_card_deposit_auto_allocate_v1(timestamptz,numeric,bigint,text,bigint) to service_role;
comment on function public.ledger_create_card_deposit_auto_allocate_v1(timestamptz,numeric,bigint,text,bigint) is
 'Registers actual bank principal FIFO; reserves/finalizes prior closed-month card fees atomically. Review or insufficient next-month capacity writes nothing.';
commit;
