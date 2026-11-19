-- Installation only. Registration is a separately approved operational action.
-- Owner-confirmed reconciliation basis, NOT a payable/purchase/expense/payment.
begin;

create table public.ledger_payable_balance_anchors (
  id bigint generated always as identity primary key,
  party_id bigint not null references public.ledger_parties(id),
  business_date date not null,
  owner_balance numeric(16,3) not null,
  app_balance numeric(16,3) not null,
  adjustment_amount numeric(16,3) generated always as (owner_balance-app_balance) stored,
  evidence_kind text not null default 'owner_confirmation',
  source_unverified boolean not null default true,
  evidence_reference text not null check(length(btrim(evidence_reference)) between 1 and 2000),
  reason text not null check(length(btrim(reason)) between 1 and 2000),
  created_by bigint not null references public.users(id),
  created_at timestamptz not null default now(),
  baseline_snapshot jsonb not null,
  unique(party_id,business_date),
  constraint coca_owner_anchor_scope check(party_id=5 and business_date=date '2026-11-17'
    and owner_balance=4982000 and app_balance=4647952
    and evidence_kind='owner_confirmation' and source_unverified=true)
);
alter table public.ledger_payable_balance_anchors enable row level security;
revoke all on public.ledger_payable_balance_anchors from public,anon,authenticated,service_role;
grant select on public.ledger_payable_balance_anchors to service_role;
revoke all on sequence public.ledger_payable_balance_anchors_id_seq from public,anon,authenticated,service_role;

-- The same ordinary confirmed payable/allocation scope as calculatePayableBalances.
create function public.ledger_coca_payable_balance_v1(p_through_date date) returns numeric
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
   and e.business_date<=p_through_date and coalesce(e.source_snapshot->>'paymentVerification','')<>'pending'
$$;
revoke all on function public.ledger_coca_payable_balance_v1(date) from public,anon,authenticated,service_role;

-- A changed historical basis is a HOLD, never a silent second balance adjustment.
create function public.ledger_owner_payable_anchor_adjustment_v1(p_through_date date) returns numeric
language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_anchor public.ledger_payable_balance_anchors%rowtype;v_legacy numeric;
begin
 select * into v_anchor from public.ledger_payable_balance_anchors where business_date<=p_through_date;
 if not found then return 0;end if;
 if public.ledger_coca_payable_balance_v1(v_anchor.business_date)<>v_anchor.app_balance then
   raise exception 'PAYABLE_BALANCE_ANCHOR_BASELINE_DRIFT';
 end if;
 -- Replace only Coca-Cola's old preflight contribution, retaining every other
 -- party's existing warning calculation. Includes newly dated applications.
 select coalesce(sum(p.original_amount-coalesce((select sum(a.allocated_amount)
   from public.ledger_payable_allocations a join public.ledger_transactions t on t.id=a.payment_transaction_id
   where a.payable_id=p.id and t.business_date<=p_through_date),0)),0) into v_legacy
 from public.ledger_payables p join public.ledger_transactions e on e.id=p.expense_transaction_id
 where p.party_id=5 and p.status<>'cancelled' and e.business_date<=p_through_date
   and coalesce(e.source_snapshot->>'paymentVerification','')<>'pending';
 return v_anchor.adjustment_amount+public.ledger_coca_payable_balance_v1(p_through_date)-v_legacy;
end $$;
revoke all on function public.ledger_owner_payable_anchor_adjustment_v1(date) from public,anon,authenticated,service_role;

create function public.ledger_register_coca_owner_balance_anchor_v1(p_evidence_reference text,p_reason text,p_actor_user_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public set lock_timeout='5s' as $$
declare v_existing public.ledger_payable_balance_anchors%rowtype;v_id bigint;v_snapshot jsonb;
begin
 if not exists(select 1 from public.users where id=p_actor_user_id and lower(role::text) in('owner','master') and is_active and app_login_enabled) then
   return jsonb_build_object('status','forbidden');end if;
 if nullif(btrim(p_evidence_reference),'') is null or length(p_evidence_reference)>2000
   or nullif(btrim(p_reason),'') is null or length(p_reason)>2000 then return jsonb_build_object('status','invalid_input');end if;
 perform pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));
 perform pg_advisory_xact_lock(hashtext('ledger_month_close'),hashtext('2026-11-01'));
 perform pg_advisory_xact_lock(hashtext('ledger_month_close:2026-11'));
 perform pg_advisory_xact_lock(hashtextextended('ledger-payable-party:5',0));
 select * into v_existing from public.ledger_payable_balance_anchors where party_id=5 and business_date=date '2026-11-17';
 if found then return jsonb_build_object('status','already_registered','anchorId',v_existing.id);end if;
 perform public.ledger_assert_month_open_v1(date '2026-11-01');
 -- Briefly exclude non-cooperating source writers while recording the reviewed basis.
 lock table public.ledger_transactions,public.ledger_payables,public.ledger_payable_allocations,public.ledger_movements in share mode;
 if public.ledger_coca_payable_balance_v1(date '2026-11-17')<>4647952 then raise exception 'COCA_OWNER_ANCHOR_BASELINE_MISMATCH';end if;
 if not exists(select 1 from public.ledger_transactions where id=5097 and party_id=5 and type='payable_payment'
   and status='confirmed' and business_date=date '2026-11-17' and amount=6215888
   and operation_id='fdee4d5d-e62f-4008-8517-00f725a87497'::uuid) then raise exception 'COCA_OWNER_ANCHOR_PAYMENT_MISMATCH';end if;
 if (select count(*) from public.ledger_movements where transaction_id=5097)<>1 or not exists(
   select 1 from public.ledger_movements where id=2854 and transaction_id=5097 and fund_account_id=2 and amount=-6215888) then
   raise exception 'COCA_OWNER_ANCHOR_MOVEMENT_MISMATCH';end if;
 if (select count(*) from public.ledger_payable_allocations where payment_transaction_id=5097)<>9 or exists(
   select 1 from (values (2191::bigint,389::bigint,533952::numeric),(2192,390,576000),(2193,506,700000),
     (2194,507,711936),(2195,508,732000),(2196,509,768000),(2197,594,700000),(2198,1088,750000),(2199,1101,744000)) x(id,payable_id,amount)
   where not exists(select 1 from public.ledger_payable_allocations a where a.id=x.id and a.payment_transaction_id=5097
     and a.payable_id=x.payable_id and a.allocated_amount=x.amount)) then raise exception 'COCA_OWNER_ANCHOR_ALLOCATION_MISMATCH';end if;
 select jsonb_build_object('payment',(select to_jsonb(t) from public.ledger_transactions t where id=5097),
   'allocations',(select jsonb_agg(to_jsonb(a) order by id) from public.ledger_payable_allocations a where payment_transaction_id=5097),
   'movements',(select jsonb_agg(to_jsonb(m) order by id) from public.ledger_movements m where transaction_id=5097),
   'existingAudit',(select jsonb_agg(to_jsonb(l) order by id) from public.ledger_audit_logs l where entity_type='transaction' and entity_id=5097),
   'ownerReportedPayment',6582000,'paymentRecordUnchanged',true,'unexplainedDebtDifference',700160,
   'unexplainedPaymentDifference',366112,'supplierStatementAvailable',false) into v_snapshot;
 insert into public.ledger_payable_balance_anchors(party_id,business_date,owner_balance,app_balance,evidence_reference,reason,created_by,baseline_snapshot)
 values(5,date '2026-11-17',4982000,4647952,btrim(p_evidence_reference),btrim(p_reason),p_actor_user_id,v_snapshot) returning id into v_id;
 insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
 values(p_actor_user_id,'owner_payable_balance_anchor_registered','payable_balance_anchor',v_id,
   jsonb_build_object('appBalance',4647952),
   (select to_jsonb(a) from public.ledger_payable_balance_anchors a where id=v_id),btrim(p_reason));
 return jsonb_build_object('status','registered','anchorId',v_id,'ownerBalance',4982000,'adjustmentAmount',334048);
end $$;
revoke all on function public.ledger_register_coca_owner_balance_anchor_v1(text,text,bigint) from public,anon,authenticated;
grant execute on function public.ledger_register_coca_owner_balance_anchor_v1(text,text,bigint) to service_role;

-- Preserve the deployed preflight's other guards and hash algorithm. Replace only
-- its ordinary outstanding warning point; fail rather than overwrite unknown SQL.
do $anchor_preflight$
declare v_def text;v_old text := $old$if v_amount>0 then v_warnings:=v_warnings||jsonb_build_array(jsonb_build_object('code','PAYABLE_OUTSTANDING','amount',v_amount));end if;$old$;
begin
 select pg_get_functiondef('public.ledger_close_preflight_v1(date,bigint)'::regprocedure) into v_def;
 if (length(v_def)-length(replace(v_def,v_old,'')))<>length(v_old) then raise exception 'COCA_ANCHOR_PREFLIGHT_SHAPE_MISMATCH';end if;
 execute replace(v_def,v_old,
   'v_amount:=v_amount+public.ledger_owner_payable_anchor_adjustment_v1((p_month+interval''1 month'')::date-1);'||v_old);
end $anchor_preflight$;

commit;
