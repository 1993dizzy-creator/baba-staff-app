-- LOCAL ONLY until reviewed and manually applied in SQL Editor. No backfill.
-- Additive names; rerun intentionally fails on an existing object instead of
-- masking schema drift. Apply this whole file in ONE transaction in SQL Editor.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$
begin
 if to_regprocedure('public.sales_close_business_day_v1(date,text,jsonb,jsonb,bigint,text,boolean,bigint)') is null
  or to_regprocedure('pos_sales_close_private.build_source(date)') is null
  or to_regprocedure('public.ledger_month_is_closed_v1(date)') is null
  or to_regclass('public.pos_inventory_deductions') is null
  or to_regclass('public.pos_inventory_deduction_receipts') is null then
  raise exception 'POS_RESOLUTION_DEPENDENCY_MISSING' using errcode='55000';
 end if;
 if (select count(*) from information_schema.columns where table_schema='public' and table_name='pos_sales_receipts'
   and column_name in('ref_date','created_at') and data_type='timestamp with time zone')<>2 then
  raise exception 'POS_RESOLUTION_TIMESTAMP_CONTRACT_MISMATCH' using errcode='55000';
 end if;
end $preflight$;
create schema pos_resolution_private;
revoke all on schema pos_resolution_private from public, anon, authenticated, service_role;

create table public.pos_sales_receipt_admin_resolutions (
  receipt_id bigint primary key references public.pos_sales_receipts(id) on delete restrict,
  request_id uuid not null unique,
  decision text not null check(decision in ('paid','canceled')),
  confirmed_amount numeric not null check(confirmed_amount >= 0 and confirmed_amount = trunc(confirmed_amount)),
  payments jsonb not null,
  reason text not null check(length(btrim(reason)) between 1 and 2000),
  evidence text not null check(length(btrim(evidence)) between 1 and 2000),
  actor_user_id bigint not null references public.users(id),
  confirmed_at timestamptz not null default now(),
  request_payload jsonb not null,
  before_snapshot jsonb not null,
  result jsonb not null,
  check ((decision='paid' and confirmed_amount>0) or (decision='canceled' and confirmed_amount=0))
);
create table public.pos_sales_receipt_resolution_history (
  id bigint generated always as identity primary key,
  receipt_id bigint not null references public.pos_sales_receipts(id) on delete restrict,
  event text not null,
  actor_user_id bigint references public.users(id),
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
create index pos_resolution_history_receipt_idx on public.pos_sales_receipt_resolution_history(receipt_id,id desc);
create table public.pos_sales_receipt_pos_observations (
  id bigint generated always as identity primary key,
  receipt_id bigint not null references public.pos_sales_receipts(id) on delete restrict,
  observation_key text not null,
  observed_at timestamptz not null,
  origin text not null check(origin in ('sync','refresh','retry')),
  list_payment_status integer,
  detail_payment_status integer,
  final_amount numeric,
  raw_payload jsonb not null,
  reconciliation text not null check(reconciliation in ('pending','matched','conflict','unknown')),
  unique(receipt_id,observation_key)
);
create index pos_resolution_observations_receipt_idx on public.pos_sales_receipt_pos_observations(receipt_id,observed_at desc,id desc);
create table pos_resolution_private.capabilities (
  transaction_id bigint not null, receipt_id bigint not null, primary key(transaction_id,receipt_id)
);
revoke all on table pos_resolution_private.capabilities from public,anon,authenticated,service_role;

alter table public.pos_sales_receipt_admin_resolutions enable row level security;
alter table public.pos_sales_receipt_resolution_history enable row level security;
alter table public.pos_sales_receipt_pos_observations enable row level security;
revoke all on public.pos_sales_receipt_admin_resolutions, public.pos_sales_receipt_resolution_history,
  public.pos_sales_receipt_pos_observations from public,anon,authenticated,service_role;
revoke all on sequence public.pos_sales_receipt_resolution_history_id_seq,
  public.pos_sales_receipt_pos_observations_id_seq from public,anon,authenticated,service_role;
grant select on public.pos_sales_receipt_admin_resolutions,public.pos_sales_receipt_resolution_history,
  public.pos_sales_receipt_pos_observations to service_role;

create function pos_resolution_private.immutable()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin raise exception 'POS_RESOLUTION_APPEND_ONLY' using errcode='55000'; end $$;
create trigger pos_resolution_immutable before update or delete on public.pos_sales_receipt_admin_resolutions
for each statement execute function pos_resolution_private.immutable();
create trigger pos_resolution_no_truncate before truncate on public.pos_sales_receipt_admin_resolutions
for each statement execute function pos_resolution_private.immutable();
create trigger pos_resolution_history_immutable before update or delete or truncate on public.pos_sales_receipt_resolution_history
for each statement execute function pos_resolution_private.immutable();
create trigger pos_resolution_observation_immutable before update or delete or truncate on public.pos_sales_receipt_pos_observations
for each statement execute function pos_resolution_private.immutable();

create function pos_resolution_private.snapshot(p_id bigint)
returns jsonb language sql stable set search_path=pg_catalog,public as $$
select jsonb_build_object('receipt',to_jsonb(r),
 'lines',coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from public.pos_sales_receipt_lines l where l.receipt_id=r.id),'[]'),
 'payments',coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from public.pos_sales_receipt_payments p where p.receipt_id=r.id),'[]'))
from public.pos_sales_receipts r where r.id=p_id
$$;
create function pos_resolution_private.fingerprint(p_snapshot jsonb)
returns text language sql immutable set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to(p_snapshot::text,'UTF8')),'hex')
$$;
create function pos_resolution_private.eligibility(p_ref timestamptz,p_created timestamptz,p_now timestamptz)
returns jsonb language sql immutable set search_path=pg_catalog,public as $$
 select jsonb_build_object('eligibleAt',case when isfinite(p_ref) and p_ref<=p_now then p_ref else p_created end + interval '30 minutes',
 'fallbackReason',case when p_ref is null or not isfinite(p_ref) then 'invalid_ref_date' when p_ref>p_now then 'future_ref_date' else null end,
 'elapsed',coalesce(isfinite(case when isfinite(p_ref) and p_ref<=p_now then p_ref else p_created end)
   and case when isfinite(p_ref) and p_ref<=p_now then p_ref else p_created end + interval '30 minutes'<=p_now,false))
$$;

-- Inspect original POS content independently of the administrator-edited lines.
create function pos_resolution_private.raw_duplicate_groups(p_raw jsonb)
returns integer language plpgsql immutable set search_path=pg_catalog,public as $$
declare v_lines jsonb; v_count integer;
begin
 if jsonb_typeof(p_raw) is distinct from 'object' then return 0;end if;
 select value into v_lines from jsonb_each(coalesce(p_raw,'{}'))
 where key in('SAInvoiceDetails','saInvoiceDetails','Details','details','InvoiceDetails','invoiceDetails') and jsonb_typeof(value)='array' limit 1;
 if v_lines is null then return 0;end if;
 select count(*) into v_count from (
  select coalesce(l->>'ItemCode',l->>'itemCode',l->>'ItemID',l->>'ItemName',l->>'itemName') item,
   coalesce(l->>'Quantity',l->>'quantity') quantity,coalesce(l->>'UnitPrice',l->>'unitPrice',l->>'Price',l->>'price') price,
   coalesce(l->>'ParentRefDetailID',l->>'ParentRefDetailId',l->>'parentRefDetailId') parent
  from jsonb_array_elements(v_lines) l where jsonb_typeof(l)='object'
  group by 1,2,3,4 having count(*)>1
 ) duplicates where item is not null;
 return v_count;
end $$;

-- Only these new RPCs can create a transaction capability. No set_config/GUC
-- can bypass guards. Locking the parent serializes child writes and decisions.
create function pos_resolution_private.source_guard()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id bigint; v_old_id bigint;
begin
  if tg_table_name='pos_sales_receipts' then
    v_id:=old.id;
  else
    v_id:=case when tg_op='DELETE' then old.receipt_id else new.receipt_id end;
    if tg_op='UPDATE' then v_old_id:=old.receipt_id; end if;
    -- Resolution takes source table locks before its row lock. A normal child
    -- write already holds ROW EXCLUSIVE on its table; do not add parent-row
    -- locks to every normal POS line (nor invert legacy inventory lock order).
  end if;
  if exists(select 1 from public.pos_sales_receipt_admin_resolutions where receipt_id in(v_id,v_old_id))
    and not exists(select 1 from pos_resolution_private.capabilities where transaction_id=txid_current() and receipt_id=v_id) then
    -- Existing inventory confirmation may update only inventory metadata.
    -- Financial content, raw source and automatic eligibility remain protected.
    if tg_table_name='pos_sales_receipts' and tg_op='UPDATE'
      and to_jsonb(new)->>'inventory_deduction_processing_paused'='true'
      and to_jsonb(new)->>'inventory_deduction_auto_eligible_at' is null
      and to_jsonb(new)->>'inventory_deduction_processing_error'='admin_resolution_inventory_review_required'
      and (to_jsonb(new)-array['inventory_deduction_processing_paused','inventory_deduction_processing_paused_at',
        'inventory_deduction_processing_error','inventory_deduction_reprocess_required','inventory_deduction_last_checked_at',
        'inventory_deduction_pending_fingerprint','inventory_deduction_pending_status'])
       = (to_jsonb(old)-array['inventory_deduction_processing_paused','inventory_deduction_processing_paused_at',
        'inventory_deduction_processing_error','inventory_deduction_reprocess_required','inventory_deduction_last_checked_at',
        'inventory_deduction_pending_fingerprint','inventory_deduction_pending_status']) then return new; end if;
    raise exception 'POS_ADMIN_RESOLUTION_PROTECTED' using errcode='55000';
  end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
create trigger pos_resolution_receipt_guard before update or delete on public.pos_sales_receipts
for each row execute function pos_resolution_private.source_guard();
create trigger pos_resolution_line_guard before insert or update or delete on public.pos_sales_receipt_lines
for each row execute function pos_resolution_private.source_guard();
create trigger pos_resolution_payment_guard before insert or update or delete on public.pos_sales_receipt_payments
for each row execute function pos_resolution_private.source_guard();

create function public.sales_get_pending_resolution_v1(p_receipt_id bigint,p_actor_user_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_r public.pos_sales_receipts%rowtype; v_role text; v_state jsonb; v_time jsonb; v_resolution jsonb; v_close jsonb;
begin
 select lower(btrim(role::text)) into v_role from public.users where id=p_actor_user_id and is_active=true and app_login_enabled=true;
 if coalesce(v_role,'') not in('owner','master','manager') then return jsonb_build_object('status','forbidden');end if;
 select * into v_r from public.pos_sales_receipts where id=p_receipt_id;
 if not found then return jsonb_build_object('status','not_found');end if;
 v_state:=pos_resolution_private.snapshot(p_receipt_id);
 v_time:=pos_resolution_private.eligibility(v_r.ref_date,v_r.created_at,statement_timestamp());
 select to_jsonb(c) into v_close from public.pos_sales_business_day_closures c where business_date=v_r.business_date order by revision desc limit 1;
 select to_jsonb(a)-'before_snapshot'-'request_payload' into v_resolution from public.pos_sales_receipt_admin_resolutions a where receipt_id=p_receipt_id;
 return jsonb_build_object('status','ok','serverNow',statement_timestamp(),'timing',v_time,'revision',coalesce(v_r.revision,0),
 'fingerprint',pos_resolution_private.fingerprint(v_state),'resolution',v_resolution,
 'eligible',v_r.source='cukcuk' and v_r.payment_status=1 and v_r.is_canceled is distinct from true and (v_time->>'elapsed')::boolean and v_resolution is null
  and not coalesce((select o.detail_payment_status in(3,4,5) from public.pos_sales_receipt_pos_observations o where o.receipt_id=p_receipt_id order by observed_at desc,id desc limit 1),false),
 'monthClosed',public.ledger_month_is_closed_v1(date_trunc('month',v_r.business_date)::date),
 'closure',case when v_close is null then null else jsonb_build_object('id',v_close->'id','fingerprint',v_close->'source_fingerprint','revision',v_close->'revision') end,
 'canReclose',v_role in('owner','master'),
 'daySourceDrift',case when v_close is null then false else
  pos_sales_close_private.build_source(v_r.business_date)->>'sourceFingerprint' is distinct from v_close->>'source_fingerprint' end,
 'rawDuplicateGroups',pos_resolution_private.raw_duplicate_groups(to_jsonb(v_r.raw_json)),
 'hasInventoryHistory',exists(select 1 from public.pos_inventory_deductions where receipt_id=p_receipt_id)
  or exists(select 1 from public.pos_inventory_deduction_receipts where receipt_id=p_receipt_id),
 'lastObservation',(select to_jsonb(o)-'raw_payload' from public.pos_sales_receipt_pos_observations o where receipt_id=p_receipt_id order by observed_at desc,id desc limit 1),
 'originalAmount',v_r.final_amount,'hasRecordedCollection',coalesce(v_r.receive_amount,0)>0 or exists(select 1 from public.pos_sales_receipt_payments where receipt_id=p_receipt_id and amount>0));
end $$;

create function public.sales_resolve_pending_receipt_v1(p_receipt_id bigint,p_actor_user_id bigint,p_request jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_r public.pos_sales_receipts%rowtype; v_existing public.pos_sales_receipt_admin_resolutions%rowtype;
 v_role text; v_username text; v_date date; v_state jsonb; v_time jsonb; v_payment jsonb;
 v_amount numeric; v_sum numeric; v_decision text; v_id uuid; v_close public.pos_sales_business_day_closures%rowtype;
 v_source jsonb; v_close_result jsonb; v_result jsonb; v_now timestamptz;
begin
 select lower(btrim(role::text)),username into v_role,v_username from public.users where id=p_actor_user_id and is_active=true and app_login_enabled=true for share;
 if coalesce(v_role,'') not in('owner','master','manager') then return jsonb_build_object('status','forbidden');end if;
 if jsonb_typeof(p_request) is distinct from 'object' or nullif(btrim(p_request->>'reason'),'') is null
   or length(p_request->>'reason')>2000 or nullif(btrim(p_request->>'evidence'),'') is null or length(p_request->>'evidence')>2000
   or coalesce(p_request->>'decision','') not in('paid','canceled')
   or coalesce(p_request->>'requestId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   or jsonb_typeof(p_request->'expectedRevision') is distinct from 'number'
   or (p_request->>'expectedRevision')::numeric<0 or (p_request->>'expectedRevision')::numeric<>trunc((p_request->>'expectedRevision')::numeric)
   or coalesce(p_request->>'fingerprint','') !~ '^[0-9a-f]{64}$'
 then return jsonb_build_object('status','invalid_input');end if;
 v_id:=(p_request->>'requestId')::uuid; v_decision:=p_request->>'decision';
 select business_date into v_date from public.pos_sales_receipts where id=p_receipt_id;
 if not found then return jsonb_build_object('status','not_found');end if;
 -- Match both historical daily-close and current month-close locking contracts.
 perform pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));
 perform pg_advisory_xact_lock(hashtext('ledger_month_close'),hashtext(date_trunc('month',v_date)::date::text));
 perform pg_advisory_xact_lock(hashtext('ledger_month_close:'||to_char(v_date,'YYYY-MM')));
 perform pg_advisory_xact_lock(hashtext('pos_sales_business_day_close:'||v_date::text));
 lock table public.pos_sales_receipts,public.pos_sales_receipt_payments,public.pos_sales_receipt_lines in share row exclusive mode;
 select * into v_r from public.pos_sales_receipts where id=p_receipt_id for update;
 if v_r.business_date is distinct from v_date then return jsonb_build_object('status','source_changed');end if;
 select * into v_existing from public.pos_sales_receipt_admin_resolutions where receipt_id=p_receipt_id or request_id=v_id;
 if found then
  if v_existing.receipt_id=p_receipt_id and v_existing.request_id=v_id and v_existing.actor_user_id=p_actor_user_id and v_existing.request_payload=p_request then return v_existing.result;end if;
  return jsonb_build_object('status','request_conflict');
 end if;
 v_now:=clock_timestamp();
 v_time:=pos_resolution_private.eligibility(v_r.ref_date,v_r.created_at,v_now);
 if v_r.source is distinct from 'cukcuk' or v_r.payment_status is distinct from 1 or v_r.is_canceled is true
  or not (v_time->>'elapsed')::boolean then return jsonb_build_object('status','not_eligible');end if;
 if coalesce((select o.detail_payment_status in(3,4,5) from public.pos_sales_receipt_pos_observations o where o.receipt_id=p_receipt_id order by observed_at desc,id desc limit 1),false)
 then return jsonb_build_object('status','pos_final_requires_sync');end if;
 v_state:=pos_resolution_private.snapshot(p_receipt_id);
 if coalesce(v_r.revision,0)<>(p_request->>'expectedRevision')::numeric or pos_resolution_private.fingerprint(v_state)<>p_request->>'fingerprint' then return jsonb_build_object('status','source_changed');end if;
 if public.ledger_month_is_closed_v1(date_trunc('month',v_date)::date) then return jsonb_build_object('status','month_closed');end if;
 select * into v_close from public.pos_sales_business_day_closures where business_date=v_date order by revision desc limit 1 for update;
 if v_close.id is not null and (v_role not in('owner','master') or p_request->'allowReclose' is distinct from 'true'::jsonb
   or p_request->>'closureFingerprint' is distinct from v_close.source_fingerprint) then return jsonb_build_object('status','reclose_required');end if;
 if v_close.id is null and nullif(p_request->>'closureFingerprint','') is not null then return jsonb_build_object('status','source_changed');end if;
 if v_close.id is not null then
  v_source:=pos_sales_close_private.build_source(v_date);
  if v_source->>'sourceFingerprint' is distinct from v_close.source_fingerprint then
   -- Never smuggle unrelated post-close drift into this receipt's approval.
   return jsonb_build_object('status','day_source_drift_requires_review');
  end if;
 end if;
 if exists(select 1 from public.pos_inventory_deductions where receipt_id=p_receipt_id)
  or exists(select 1 from public.pos_inventory_deduction_receipts where receipt_id=p_receipt_id)
 then return jsonb_build_object('status','inventory_history_requires_review');end if;
 if v_r.inventory_deduction_processing_paused is true then return jsonb_build_object('status','inventory_busy');end if;
 if jsonb_typeof(p_request->'payments') is distinct from 'array' then return jsonb_build_object('status','invalid_payments');end if;
 if v_decision='paid' then
  if jsonb_typeof(p_request->'amount') is distinct from 'number' then return jsonb_build_object('status','invalid_amount');end if;
  v_amount:=(p_request->>'amount')::numeric;
  if v_amount<=0 or v_amount<>trunc(v_amount) or v_amount>1000000000000 or jsonb_array_length(p_request->'payments') not between 1 and 4 then return jsonb_build_object('status','invalid_amount');end if;
  if exists(select 1 from jsonb_array_elements(p_request->'payments') p where jsonb_typeof(p) is distinct from 'object'
    or coalesce(p->>'method','') not in('cash','transfer','card','other') or jsonb_typeof(p->'amount') is distinct from 'number') then return jsonb_build_object('status','invalid_payments');end if;
  if exists(select 1 from jsonb_array_elements(p_request->'payments') p where (p->>'amount')::numeric<=0 or (p->>'amount')::numeric<>trunc((p->>'amount')::numeric)) then return jsonb_build_object('status','invalid_payments');end if;
  select sum((p->>'amount')::numeric) into v_sum from jsonb_array_elements(p_request->'payments') p;
  if v_sum<>v_amount or (select count(distinct p->>'method') from jsonb_array_elements(p_request->'payments') p)<>jsonb_array_length(p_request->'payments') then return jsonb_build_object('status','payment_total_mismatch');end if;
 else
  v_amount:=0;
  if p_request->'amount' is distinct from '0'::jsonb or jsonb_array_length(p_request->'payments')<>0 then return jsonb_build_object('status','invalid_payments');end if;
  if (coalesce(v_r.receive_amount,0)>0 or exists(select 1 from public.pos_sales_receipt_payments where receipt_id=p_receipt_id and amount>0))
   and p_request->'collectionAdjustmentConfirmed' is distinct from 'true'::jsonb then return jsonb_build_object('status','collection_adjustment_required');end if;
 end if;
 insert into pos_resolution_private.capabilities values(txid_current(),p_receipt_id);
 delete from public.pos_sales_receipt_payments where receipt_id=p_receipt_id;
 for v_payment in select value from jsonb_array_elements(p_request->'payments') loop
  insert into public.pos_sales_receipt_payments(source,receipt_id,receipt_ref_id,business_date,ref_date,payment_type,payment_name,card_name,amount,raw_json,synced_at,updated_at)
  values(v_r.source,v_r.id,v_r.ref_id,v_r.business_date,v_r.ref_date,
   case when v_payment->>'method'='card' then 2 else 1 end,
   case v_payment->>'method' when 'cash' then 'Tiền mặt' when 'transfer' then 'Chuyển khoản' when 'card' then 'Card' else 'Khác' end,
   case when v_payment->>'method'='card' then 'Card' else null end,(v_payment->>'amount')::numeric,
   jsonb_build_object('source','baba_admin_resolution','requestId',v_id,'method',v_payment->>'method'),v_now,v_now);
 end loop;
 update public.pos_sales_receipts set payment_status=case when v_decision='paid' then 3 else 4 end,is_canceled=v_decision='canceled',
  final_amount=case when v_decision='paid' then v_amount else final_amount end,
  receive_amount=v_amount,return_amount=0,revision=coalesce(revision,0)+1,
  inventory_deduction_auto_eligible_at=null,inventory_deduction_processing_paused=true,
  inventory_deduction_processing_paused_at=v_now,inventory_deduction_processing_error='admin_resolution_inventory_review_required',
  updated_at=v_now where id=p_receipt_id;
 update public.pos_sales_receipt_lines set payment_status=case when v_decision='paid' then 3 else 4 end,is_canceled=v_decision='canceled',updated_at=v_now where receipt_id=p_receipt_id;
 if v_close.id is not null then
  v_source:=pos_sales_close_private.build_source(v_date);
  v_close_result:=public.sales_close_business_day_v1(v_date,v_source->>'sourceFingerprint',v_source->'sourceSnapshot',v_source->'rows',p_actor_user_id,'manual',true,null);
  if coalesce(v_close_result->>'status','') not in('reclosed','closed','already_closed') then
   raise exception 'POS_RESOLUTION_RECLOSE_FAILED' using errcode='55000',detail=coalesce(v_close_result->>'status','unknown');
  end if;
 end if;
 v_result:=jsonb_build_object('status','resolved','receiptId',p_receipt_id,'requestId',v_id,'decision',v_decision,
  'revision',coalesce(v_r.revision,0)+1,'confirmedAt',v_now,'actorUsername',v_username,'reclose',v_close_result);
 insert into public.pos_sales_receipt_admin_resolutions(receipt_id,request_id,decision,confirmed_amount,payments,reason,evidence,actor_user_id,confirmed_at,request_payload,before_snapshot,result)
 values(p_receipt_id,v_id,v_decision,v_amount,p_request->'payments',btrim(p_request->>'reason'),btrim(p_request->>'evidence'),p_actor_user_id,v_now,p_request,v_state,v_result);
 insert into public.pos_sales_receipt_resolution_history(receipt_id,event,actor_user_id,snapshot)
 values(p_receipt_id,'admin_resolved',p_actor_user_id,jsonb_build_object('before',v_state,'after',pos_resolution_private.snapshot(p_receipt_id),'result',v_result,'timing',v_time));
 delete from pos_resolution_private.capabilities where transaction_id=txid_current() and receipt_id=p_receipt_id;
 return v_result;
end $$;

-- Every POS observation for a protected receipt is saved separately. Never
-- release financial/content protection merely because POS becomes paid.
create function public.sales_observe_resolved_receipts_v1(p_observations jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_item jsonb; v_r public.pos_sales_receipts%rowtype; v_a public.pos_sales_receipt_admin_resolutions%rowtype;
 v_reconciliation text; v_ids jsonb:='[]'; v_key text;
begin
 if jsonb_typeof(p_observations) is distinct from 'array' or jsonb_array_length(p_observations)>100 then raise exception 'INVALID_OBSERVATIONS';end if;
 for v_item in select value from jsonb_array_elements(p_observations) order by value->>'refId' loop
  select r.* into v_r from public.pos_sales_receipts r
   where r.source='cukcuk' and r.ref_id=v_item->>'refId' for update of r;
  if not found then continue;end if;
  select * into v_a from public.pos_sales_receipt_admin_resolutions where receipt_id=v_r.id;
  v_reconciliation:=case when v_a.receipt_id is null then 'unknown' when (v_item->>'detailStatus')::integer=1 then 'pending'
   when (v_item->>'detailStatus')::integer in(3,4,5) then
    case when ((v_a.decision='paid' and (v_item->>'detailStatus')::integer=3)
      or (v_a.decision='canceled' and (v_item->>'detailStatus')::integer in(4,5)))
     and (v_a.decision='canceled' or (v_item->>'amount')::numeric=v_a.confirmed_amount)
     then 'matched' else 'conflict' end else 'unknown' end;
  if (v_item->>'listStatus')::integer in(3,4,5) and (v_item->>'listStatus')::integer is distinct from (v_item->>'detailStatus')::integer then v_reconciliation:='conflict';end if;
  v_key:=pos_resolution_private.fingerprint(v_item);
  insert into public.pos_sales_receipt_pos_observations(receipt_id,observation_key,observed_at,origin,list_payment_status,detail_payment_status,final_amount,raw_payload,reconciliation)
  values(v_r.id,v_key,(v_item->>'observedAt')::timestamptz,v_item->>'origin',(v_item->>'listStatus')::integer,
   (v_item->>'detailStatus')::integer,(v_item->>'amount')::numeric,v_item->'raw',v_reconciliation)
  on conflict(receipt_id,observation_key) do nothing;
  if v_a.receipt_id is not null then v_ids:=v_ids||jsonb_build_array(v_r.ref_id);end if;
 end loop;
 return jsonb_build_object('protectedRefIds',v_ids);
end $$;

revoke all on all functions in schema pos_resolution_private from public,anon,authenticated,service_role;
revoke all on function public.sales_get_pending_resolution_v1(bigint,bigint),public.sales_resolve_pending_receipt_v1(bigint,bigint,jsonb),
 public.sales_observe_resolved_receipts_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.sales_get_pending_resolution_v1(bigint,bigint),public.sales_resolve_pending_receipt_v1(bigint,bigint,jsonb),
 public.sales_observe_resolved_receipts_v1(jsonb) to service_role;

-- No backfill. Each existing cron invocation may lease at most three old
-- pending/protected receipts. Expired leases can be reclaimed after a crash.
create table pos_resolution_private.recheck_jobs (
 receipt_id bigint primary key references public.pos_sales_receipts(id) on delete restrict,
 attempt integer not null default 0,
 last_leased_at timestamptz not null default now(),
 next_attempt_at timestamptz not null default now(),
 lease_id uuid, lease_until timestamptz,
 last_error text, last_checked_at timestamptz
);
revoke all on pos_resolution_private.recheck_jobs from public,anon,authenticated,service_role;
create index pos_pending_recheck_budget_idx on pos_resolution_private.recheck_jobs(last_leased_at desc);
create index pos_pending_resolution_candidates_idx on public.pos_sales_receipts(business_date,id)
 where source='cukcuk' and payment_status=1 and is_canceled is distinct from true;

create function public.sales_claim_pending_rechecks_v1()
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_r record; v_lease uuid:=gen_random_uuid(); v_result jsonb:='[]';
begin
 if not pg_try_advisory_xact_lock(hashtext('pos_pending_recheck_claim')) then return v_result;end if;
 -- Cron delivery/retries can overlap. Enforce a global three-request batch per
 -- five-minute UTC bucket, not just a limit per HTTP invocation.
 if exists(select 1 from pos_resolution_private.recheck_jobs
  where last_leased_at>=date_bin(interval '5 minutes',now(),'epoch'::timestamptz)) then return v_result;end if;
 for v_r in
  select r.id,r.ref_id from public.pos_sales_receipts r
  left join pos_resolution_private.recheck_jobs j on j.receipt_id=r.id
  where r.source='cukcuk' and r.business_date<((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date
   and ((r.payment_status=1 and r.is_canceled is distinct from true)
     or exists(select 1 from public.pos_sales_receipt_admin_resolutions a where a.receipt_id=r.id))
   and coalesce(j.next_attempt_at,'-infinity')<=now() and coalesce(j.lease_until,'-infinity')<=now()
   and not exists(select 1 from public.pos_sales_receipt_pos_observations o where o.id=(select o2.id from public.pos_sales_receipt_pos_observations o2 where o2.receipt_id=r.id order by observed_at desc,id desc limit 1) and o.reconciliation='matched')
  order by coalesce(j.next_attempt_at,r.created_at),r.id limit 3
 loop
  insert into pos_resolution_private.recheck_jobs(receipt_id,attempt,lease_id,lease_until,next_attempt_at)
  values(v_r.id,1,v_lease,now()+interval '2 minutes',now()+interval '5 minutes')
  on conflict(receipt_id) do update set attempt=pos_resolution_private.recheck_jobs.attempt+1,lease_id=v_lease,lease_until=now()+interval '2 minutes',last_leased_at=now();
  v_result:=v_result||jsonb_build_array(jsonb_build_object('receiptId',v_r.id,'refId',v_r.ref_id,'leaseId',v_lease));
 end loop;
 return v_result;
end $$;
create function public.sales_finish_pending_recheck_v1(p_receipt_id bigint,p_lease_id uuid,p_error text)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update pos_resolution_private.recheck_jobs set lease_id=null,lease_until=null,last_error=case when p_error is null then null else 'pos_lookup_failed' end,
  last_checked_at=now(),next_attempt_at=now()+make_interval(secs=>least(21600,300*power(2,least(attempt,6)))::integer)
 where receipt_id=p_receipt_id and lease_id=p_lease_id and lease_until>now();
 if not found then return false;end if;
 if p_error is not null then
  insert into public.pos_sales_receipt_resolution_history(receipt_id,event,snapshot)
  values(p_receipt_id,'pos_lookup_failed',jsonb_build_object('leaseId',p_lease_id,'error','pos_lookup_failed'));
 end if;
 return true;
end $$;
revoke all on function public.sales_claim_pending_rechecks_v1(),public.sales_finish_pending_recheck_v1(bigint,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.sales_claim_pending_rechecks_v1(),public.sales_finish_pending_recheck_v1(bigint,uuid,text) to service_role;
commit;
