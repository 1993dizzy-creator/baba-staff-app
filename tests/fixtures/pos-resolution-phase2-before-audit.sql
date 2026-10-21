-- Phase 2. LOCAL/isolated test only. Apply AFTER 20261021070640, as one transaction.
-- No backfill, source deletion, original JSON replacement, or automatic stock work.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $types$
begin
 if exists(select 1 from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in('inventory','pos_item_mappings','pos_item_mapping_recipes') and a.attname='id'
   and format_type(a.atttypid,a.atttypmod) not in('smallint','integer','bigint')) then raise exception 'POS_RESOLUTION_INVENTORY_ID_CONTRACT_MISMATCH';end if;
end $types$;
create table public.pos_sales_receipt_resolution_versions (
 receipt_id bigint not null references public.pos_sales_receipt_admin_resolutions(receipt_id),
 version bigint not null check(version>1), request_id uuid not null unique,
 actor_user_id bigint not null references public.users(id), request_payload jsonb not null,
 decision text not null check(decision in('paid','canceled')), amount numeric not null,
 payments jsonb not null, before_snapshot jsonb not null, after_snapshot jsonb not null,
 result jsonb not null, reason text not null check(length(btrim(reason)) between 1 and 2000),
 created_at timestamptz not null default now(), primary key(receipt_id,version)
);
create table pos_resolution_private.work_capabilities (
 transaction_id bigint not null, receipt_id bigint not null, purpose text not null,
 primary key(transaction_id,receipt_id)
);
create table public.pos_sales_receipt_inventory_reviews (
 id uuid primary key default gen_random_uuid(), receipt_id bigint not null references public.pos_sales_receipt_admin_resolutions(receipt_id),
 resolution_version bigint not null, actor_user_id bigint not null references public.users(id),
 context_fingerprint text not null, plan jsonb not null, blockers jsonb not null,
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '15 minutes'
);
create table public.pos_sales_receipt_inventory_approvals (
 request_id uuid primary key, review_id uuid not null unique references public.pos_sales_receipt_inventory_reviews(id),
 receipt_id bigint not null references public.pos_sales_receipt_admin_resolutions(receipt_id),
 actor_user_id bigint not null references public.users(id), request_payload jsonb not null,
 result jsonb not null, reason text not null, created_at timestamptz not null default now()
);
alter table public.pos_sales_receipts add column admin_resolution_version bigint not null default 0;
alter table public.pos_sales_receipts add column admin_resolution_financial_review_required boolean not null default false;
alter table public.pos_sales_receipt_payments add column admin_resolution_retired boolean not null default false;
alter table public.pos_sales_receipt_pos_observations add column resolution_version bigint;
alter table public.pos_inventory_deduction_receipts add column admin_resolution_content_fingerprint text;
alter table public.pos_sales_receipt_resolution_versions enable row level security;
alter table public.pos_sales_receipt_inventory_reviews enable row level security;
alter table public.pos_sales_receipt_inventory_approvals enable row level security;
revoke all on public.pos_sales_receipt_resolution_versions,public.pos_sales_receipt_inventory_reviews,
 public.pos_sales_receipt_inventory_approvals,pos_resolution_private.work_capabilities from public,anon,authenticated,service_role;
grant select on public.pos_sales_receipt_resolution_versions,public.pos_sales_receipt_inventory_reviews,
 public.pos_sales_receipt_inventory_approvals to service_role;
create trigger pos_resolution_versions_immutable before update or delete or truncate on public.pos_sales_receipt_resolution_versions
 for each statement execute function pos_resolution_private.immutable();
create trigger pos_resolution_reviews_immutable before update or delete or truncate on public.pos_sales_receipt_inventory_reviews
 for each statement execute function pos_resolution_private.immutable();
create trigger pos_resolution_approvals_immutable before update or delete or truncate on public.pos_sales_receipt_inventory_approvals
 for each statement execute function pos_resolution_private.immutable();

create function pos_resolution_private.version(p_id bigint) returns bigint language sql stable set search_path=pg_catalog,public as $$
 select coalesce(max(version),1) from public.pos_sales_receipt_resolution_versions where receipt_id=p_id
$$;
create function pos_resolution_private.actor(p_id bigint,p_stock boolean default false) returns text
language plpgsql set search_path=pg_catalog,public as $$
declare v_username text; v_role text;
begin
 select username,lower(btrim(role::text)) into v_username,v_role from public.users
 where id=p_id and is_active=true and app_login_enabled=true for share;
 if coalesce(v_role,'') not in('owner','master','manager') or (p_stock and v_role='manager') then
  raise exception 'POS_RESOLUTION_FORBIDDEN' using errcode='42501';end if;
 return v_username;
end $$;
create function pos_resolution_private.lock_source(p_id bigint) returns date
language plpgsql set search_path=pg_catalog,public as $$
declare v_date date;
begin
 select business_date into v_date from public.pos_sales_receipts where id=p_id;
 if v_date is null then raise exception 'POS_RESOLUTION_NOT_FOUND';end if;
 perform pg_advisory_xact_lock(hashtext('ledger_month_close_serial'));
 perform pg_advisory_xact_lock(hashtext('ledger_month_close'),hashtext(date_trunc('month',v_date)::date::text));
 perform pg_advisory_xact_lock(hashtext('ledger_month_close:'||to_char(v_date,'YYYY-MM')));
 perform pg_advisory_xact_lock(hashtext('pos_sales_business_day_close:'||v_date::text));
 lock table public.pos_sales_receipts,public.pos_sales_receipt_payments,public.pos_sales_receipt_lines in share row exclusive mode;
 perform 1 from public.pos_sales_receipts where id=p_id and business_date=v_date for update;
 if not found then raise exception 'POS_RESOLUTION_SOURCE_CHANGED';end if;
 if public.ledger_month_is_closed_v1(date_trunc('month',v_date)::date) then raise exception 'POS_RESOLUTION_MONTH_CLOSED';end if;
 return v_date;
end $$;
create function pos_resolution_private.authorize_day(p_date date,p_actor bigint,p_request jsonb,p_inventory boolean default false)
returns boolean language plpgsql set search_path=pg_catalog,public as $$
declare v_close public.pos_sales_business_day_closures%rowtype; v_role text; v_source jsonb;
begin
 select * into v_close from public.pos_sales_business_day_closures where business_date=p_date order by revision desc limit 1;
 if not found then return false;end if;
 select lower(btrim(role::text)) into v_role from public.users where id=p_actor;
 if v_role not in('owner','master') or p_request->'approveReclose' is distinct from 'true'::jsonb
  or p_request->>'closureFingerprint' is distinct from v_close.source_fingerprint then raise exception 'POS_RESOLUTION_OFFICIAL_RECLOSE_REQUIRED';end if;
 v_source:=pos_sales_close_private.build_source(p_date);
 if v_source->>'sourceFingerprint' is distinct from v_close.source_fingerprint then raise exception 'POS_RESOLUTION_DAY_SOURCE_DRIFT';end if;
 return true;
end $$;
create function pos_resolution_private.reclose(p_date date,p_actor bigint) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare v_source jsonb; v_result jsonb;
begin
 v_source:=pos_sales_close_private.build_source(p_date);
 v_result:=public.sales_close_business_day_v1(p_date,v_source->>'sourceFingerprint',v_source->'sourceSnapshot',v_source->'rows',p_actor,'manual',true,null);
 if coalesce(v_result->>'status','') not in('closed','reclosed','already_closed') then raise exception 'POS_RESOLUTION_RECLOSE_FAILED' using detail=v_result->>'status';end if;
 return v_result;
end $$;

-- Current payment rows may change; POS raw_json and immutable before snapshots
-- do not. Retain old row IDs with zero derived amount, rather than DELETE.
create function pos_resolution_private.replace_payments(p_id bigint,p_payments jsonb) returns void
language plpgsql set search_path=pg_catalog,public as $$
declare v_r public.pos_sales_receipts%rowtype; v_p jsonb; v_id bigint; v_name text; v_method text;
begin
 select * into v_r from public.pos_sales_receipts where id=p_id;
 update public.pos_sales_receipt_payments set amount=0,admin_resolution_retired=true,updated_at=clock_timestamp() where receipt_id=p_id;
 for v_p in select value from jsonb_array_elements(p_payments) loop
  v_method:=v_p->>'method';
  v_name:=case v_method when 'cash' then 'Tiền mặt' when 'transfer' then 'Chuyển khoản' when 'card' then 'Card' else 'Khác' end;
  -- Stable identity for repeated derived buckets; never rewrite original raw.
  select id into v_id from public.pos_sales_receipt_payments where receipt_id=p_id
   and source='manual' and receipt_ref_id=v_r.ref_id
   and payment_type=case when v_method='card' then 2 else 1 end and payment_name=v_name
   and card_name is not distinct from case when v_method='card' then 'Card' else null end order by id limit 1;
  if v_id is not null then
   update public.pos_sales_receipt_payments set amount=(v_p->>'amount')::numeric,admin_resolution_retired=false,payment_type=case when v_method='card' then 2 else 1 end,
    payment_name=v_name,card_name=case when v_method='card' then 'Card' else null end,updated_at=clock_timestamp() where id=v_id;
  else
   insert into public.pos_sales_receipt_payments(source,receipt_id,receipt_ref_id,business_date,ref_date,payment_type,payment_name,card_name,amount,raw_json,synced_at,updated_at)
   values('manual',p_id,v_r.ref_id,v_r.business_date,v_r.ref_date,case when v_method='card' then 2 else 1 end,v_name,
    case when v_method='card' then 'Card' else null end,(v_p->>'amount')::numeric,jsonb_build_object('source','baba_admin_resolution','adminResolutionMethod',v_method),now(),now());
  end if;
 end loop;
end $$;

-- Reuse the reviewed financial engine with explicit safe changes. Fail before
-- creating a clone if an expected contract/anchor is absent. The public normal
-- POS-paid edit function is not changed and never called for protected edits.
create function pos_resolution_private.financial_consistent(p_id bigint,p_amount numeric) returns boolean
language sql stable set search_path=pg_catalog,public as $$
 select p_amount>0 and exists(select 1 from public.pos_sales_receipt_lines where receipt_id=p_id and is_excluded is not true and is_canceled is not true)
 and not exists(select 1 from public.pos_sales_receipt_lines where receipt_id=p_id and is_excluded is not true and is_canceled is not true
  and (quantity is null or quantity<=0 or unit_price is null or unit_price<0 or final_amount is null or final_amount<0 or tax_amount is null or tax_amount<0))
 and p_amount=(select coalesce(sum(final_amount+tax_amount),0) from public.pos_sales_receipt_lines where receipt_id=p_id and is_excluded is not true and is_canceled is not true)
$$;
do $clone$
declare d text; a integer; b integer;
begin
 d:=pg_get_functiondef('public.admin_update_paid_sales_receipt(bigint,bigint,uuid,text,text,text,numeric,text,numeric,jsonb,numeric)'::regprocedure);
 if position('inventory_deduction_processing_paused=false' in d)=0 or position('delete from public.pos_sales_receipt_lines line' in d)=0 then raise exception 'POS_RESOLUTION_EDIT_CONTRACT_MISMATCH';end if;
 d:=replace(d,'public.admin_update_paid_sales_receipt(','pos_resolution_private.edit_paid_held(');
 d:=replace(d,'inventory_deduction_auto_eligible_at=v_now','inventory_deduction_auto_eligible_at=null');
 d:=replace(d,'inventory_deduction_processing_paused=false','inventory_deduction_processing_paused=true');
 d:=replace(d,'inventory_deduction_processing_paused_at=null','inventory_deduction_processing_paused_at=v_now');
 d:=replace(d,'inventory_deduction_processing_error=null','inventory_deduction_processing_error=''admin_resolution_inventory_review_required''');
 d:=replace(d,'inventory_deduction_reprocess_required=v_inventory_changed','inventory_deduction_reprocess_required=true');
 d:=replace(d,'raw_json=coalesce(v_line->''raw_json'',''{}''::jsonb), updated_at=v_now','raw_json=pos_sales_receipt_lines.raw_json, updated_at=v_now');
 d:=replace(d,'delete from public.pos_sales_receipt_lines line','update public.pos_sales_receipt_lines line set is_excluded=true,updated_at=v_now');
 a:=position('  delete from public.pos_sales_receipt_payments where receipt_id=p_receipt_id;' in d);
 b:=position('  v_next_revision :=' in d);
 if a=0 or b<=a then raise exception 'POS_RESOLUTION_PAYMENT_CONTRACT_MISMATCH';end if;
 d:=substr(d,1,a-1)||'  perform pos_resolution_private.replace_payments(p_receipt_id,''[]''::jsonb);'||E'\n'||substr(d,b);
 a:=position('  insert into public.pos_sales_receipt_modifications (' in d);
 b:=position('  return v_result;' in d);
 if a=0 or b<=a then raise exception 'POS_RESOLUTION_MODIFICATION_CONTRACT_MISMATCH';end if;
 d:=substr(d,1,a-1)||substr(d,b);
 execute d;
 -- The initial resolution v2 preserves payment rows, and permits existing
 -- stock history ONLY because it stays held for a separate stock approval.
 d:=pg_get_functiondef('public.sales_resolve_pending_receipt_v1(bigint,bigint,jsonb)'::regprocedure);
 d:=replace(d,'public.sales_resolve_pending_receipt_v1(','pos_resolution_private.resolve_pending_with_history(');
 a:=position(' if exists(select 1 from public.pos_inventory_deductions where receipt_id=p_receipt_id)' in d);
 b:=position(' if v_r.inventory_deduction_processing_paused is true' in d);
 if a=0 or b<=a then raise exception 'POS_RESOLUTION_INITIAL_CONTRACT_MISMATCH';end if;
 d:=substr(d,1,a-1)||substr(d,b);
 a:=position(' delete from public.pos_sales_receipt_payments where receipt_id=p_receipt_id;' in d);
 b:=position(' update public.pos_sales_receipts set payment_status=' in d);
 if a=0 or b<=a then raise exception 'POS_RESOLUTION_INITIAL_PAYMENT_CONTRACT_MISMATCH';end if;
 d:=substr(d,1,a-1)||' perform pos_resolution_private.replace_payments(p_receipt_id,p_request->''payments'');'||E'\n'||substr(d,b);
 a:=position(' update public.pos_sales_receipt_lines set payment_status=' in d);
 if a=0 then raise exception 'POS_RESOLUTION_INITIAL_CLOSE_CONTRACT_MISMATCH';end if;
 b:=position(E' if v_close.id is not null then\n  v_source:=' in substr(d,a));
 if b=0 then raise exception 'POS_RESOLUTION_INITIAL_CLOSE_CONTRACT_MISMATCH';end if;
 a:=a+b-1;
 d:=substr(d,1,a-1)||' update public.pos_sales_receipts set admin_resolution_version=1,admin_resolution_financial_review_required=(v_decision=''paid'' and not pos_resolution_private.financial_consistent(p_receipt_id,v_amount)) where id=p_receipt_id;'||E'\n'||
  ' if v_decision=''paid'' then update public.pos_sales_receipts set original_tax_summary=coalesce(original_tax_summary,jsonb_build_object(''totalTaxAmount'',v_r.vat_amount)),original_amount_summary=coalesce(original_amount_summary,jsonb_build_object(''totalAmount'',v_r.total_amount,''vatAmount'',v_r.vat_amount,''finalAmount'',v_r.final_amount,''paymentTotalAmount'',v_r.final_amount)),total_amount=(select coalesce(sum(final_amount),0) from public.pos_sales_receipt_lines where receipt_id=p_receipt_id and is_excluded is not true and is_canceled is not true),vat_amount=(select coalesce(sum(tax_amount),0) from public.pos_sales_receipt_lines where receipt_id=p_receipt_id and is_excluded is not true and is_canceled is not true),discount_amount=(select coalesce(sum(discount_amount),0) from public.pos_sales_receipt_lines where receipt_id=p_receipt_id and is_excluded is not true and is_canceled is not true) where id=p_receipt_id;end if;'||E'\n'||substr(d,a);
 execute d;
end $clone$;

create function public.sales_resolve_pending_receipt_v2(p_receipt_id bigint,p_actor_user_id bigint,p_request jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform pos_resolution_private.actor(p_actor_user_id);
 return pos_resolution_private.resolve_pending_with_history(p_receipt_id,p_actor_user_id,p_request);
end $$;

create function pos_resolution_private.check_payments(p_amount numeric,p_payments jsonb) returns void
language plpgsql set search_path=pg_catalog,public as $$
begin
 if p_amount is null or p_amount<=0 or p_amount<>trunc(p_amount) or p_amount>999999999999
  or jsonb_typeof(p_payments) is distinct from 'array' then raise exception 'POS_RESOLUTION_INVALID_AMOUNT';end if;
 if jsonb_array_length(p_payments) not between 1 and 4 or exists(select 1 from jsonb_array_elements(p_payments) x
  where jsonb_typeof(x->'amount') is distinct from 'number' or coalesce(x->>'method','') not in('cash','transfer','card','other')) then raise exception 'POS_RESOLUTION_INVALID_PAYMENTS';end if;
 if exists(select 1 from jsonb_array_elements(p_payments) x where (x->>'amount')::numeric<=0 or (x->>'amount')::numeric<>trunc((x->>'amount')::numeric))
  or (select sum((x->>'amount')::numeric) from jsonb_array_elements(p_payments) x)<>p_amount
  or (select count(distinct x->>'method') from jsonb_array_elements(p_payments) x)<>jsonb_array_length(p_payments)
 then raise exception 'POS_RESOLUTION_PAYMENT_TOTAL_MISMATCH';end if;
end $$;

create function public.sales_correct_admin_resolution_v2(p_receipt_id bigint,p_actor_user_id bigint,p_request jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_date date; v_username text; v_r public.pos_sales_receipts%rowtype; v_header public.pos_sales_receipt_admin_resolutions%rowtype;
 v_old public.pos_sales_receipt_resolution_versions%rowtype; v_version bigint; v_before jsonb; v_after jsonb; v_result jsonb; v_existing record;
 v_id uuid; v_amount numeric; v_decision text; v_reclose boolean; v_line jsonb; v_base jsonb; v_product record; v_lines jsonb:='[]'; v_total numeric:=0; v_tax numeric:=0;
begin
 v_username:=pos_resolution_private.actor(p_actor_user_id);
 v_date:=pos_resolution_private.lock_source(p_receipt_id);
 if nullif(btrim(p_request->>'reason'),'') is null or length(p_request->>'reason')>2000
  or coalesce(p_request->>'requestId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception 'POS_RESOLUTION_INVALID_INPUT';end if;
 v_id:=(p_request->>'requestId')::uuid;
 select * into v_existing from public.pos_sales_receipt_resolution_versions where request_id=v_id;
 if found then
  if v_existing.receipt_id=p_receipt_id and v_existing.actor_user_id=p_actor_user_id and v_existing.request_payload=p_request then return v_existing.result;end if;
  raise exception 'POS_RESOLUTION_REQUEST_CONFLICT';
 end if;
 if exists(select 1 from public.pos_sales_receipt_modifications where request_id=v_id)
  or exists(select 1 from public.pos_sales_receipt_admin_resolutions where request_id=v_id) then raise exception 'POS_RESOLUTION_REQUEST_CONFLICT';end if;
 select * into v_header from public.pos_sales_receipt_admin_resolutions where receipt_id=p_receipt_id;
 if not found then raise exception 'POS_RESOLUTION_NOT_FOUND';end if;
 select * into v_r from public.pos_sales_receipts where id=p_receipt_id;
 v_version:=pos_resolution_private.version(p_receipt_id);v_before:=pos_resolution_private.snapshot(p_receipt_id);
 if p_request->>'resolutionId' is distinct from v_header.request_id::text
  or p_request->>'resolutionVersion' is distinct from v_version::text
  or p_request->>'expectedRevision' is distinct from coalesce(v_r.revision,0)::text
  or p_request->>'fingerprint' is distinct from pos_resolution_private.fingerprint(v_before)
 then raise exception 'POS_RESOLUTION_STALE';end if;
 if v_r.is_canceled is true or v_r.payment_status<>3 then raise exception 'POS_RESOLUTION_COMPENSATION_REQUIRES_REVIEW';end if;
 v_reclose:=pos_resolution_private.authorize_day(v_date,p_actor_user_id,p_request);
 v_decision:=p_request->>'decision';
 insert into pos_resolution_private.capabilities values(txid_current(),p_receipt_id);
 if v_decision='paid' then
  v_amount:=(p_request->>'amount')::numeric;perform pos_resolution_private.check_payments(v_amount,p_request->'payments');
  if jsonb_typeof(p_request->'lines') is distinct from 'array' or jsonb_array_length(p_request->'lines')=0
   or coalesce(p_request->>'taxMode','') not in('apply','exclude_all') then raise exception 'POS_RESOLUTION_LINES_REQUIRED';end if;
  for v_line in select value from jsonb_array_elements(p_request->'lines') loop
   if exists(select 1 from unnest(array['quantity','unit_price','discount_amount','tax_rate']) k where jsonb_typeof(v_line->k) is distinct from 'number') then raise exception 'POS_RESOLUTION_INVALID_LINE';end if;
   if nullif(v_line->>'id','') is not null then
    select to_jsonb(l) into v_base from public.pos_sales_receipt_lines l where l.id=(v_line->>'id')::bigint and l.receipt_id=p_receipt_id;
    if not found then raise exception 'POS_RESOLUTION_INVALID_LINE';end if;
   else
    select * into v_product from public.pos_products where id=(v_line->>'productId')::bigint and is_active=true for share;
    if not found then raise exception 'POS_RESOLUTION_PRODUCT_UNAVAILABLE';end if;
    v_base:=jsonb_build_object('id',null,'sort_order',jsonb_array_length(v_lines)+1,'ref_detail_id','admin:'||v_id::text||':'||jsonb_array_length(v_lines),
     'parent_ref_detail_id',null,'item_id',coalesce(v_product.pos_item_id,v_product.item_id),'item_code',v_product.item_code,'item_name',v_product.item_name,
     'unit_name',v_product.unit_name,'ref_detail_type',1,'inventory_item_type',null,'is_option',false,'mapping_status','unmapped','tax_reduction_amount',0,
     'raw_json',jsonb_build_object('source','baba_admin_resolution','productId',v_product.id));
   end if;
   -- Clients control only financial fields; never source/item identities.
   v_line:=v_base||jsonb_build_object('quantity',v_line->'quantity','unit_price',v_line->'unit_price','discount_amount',v_line->'discount_amount','tax_rate',v_line->'tax_rate');
   if (v_line->>'quantity')::numeric<=0 or (v_line->>'unit_price')::numeric<0 or (v_line->>'discount_amount')::numeric<0
    or (v_line->>'discount_amount')::numeric>round((v_line->>'quantity')::numeric*(v_line->>'unit_price')::numeric)
    or (v_line->>'tax_rate')::numeric<0 or (v_line->>'tax_rate')::numeric>100 then raise exception 'POS_RESOLUTION_INVALID_LINE';end if;
   v_line:=v_line||jsonb_build_object('amount',round((v_line->>'quantity')::numeric*(v_line->>'unit_price')::numeric),
    'final_amount',round((v_line->>'quantity')::numeric*(v_line->>'unit_price')::numeric)-(v_line->>'discount_amount')::numeric);
   v_line:=v_line||jsonb_build_object('tax_amount',case when p_request->>'taxMode'='exclude_all' then 0 else round((v_line->>'final_amount')::numeric*coalesce((v_line->>'tax_rate')::numeric,0)/100) end,
    'pre_tax_amount',(v_line->>'final_amount')::numeric);
   v_total:=v_total+(v_line->>'final_amount')::numeric;v_tax:=v_tax+(v_line->>'tax_amount')::numeric;
   v_lines:=v_lines||jsonb_build_array(v_line);
  end loop;
  if v_total+v_tax<>v_amount then raise exception 'POS_RESOLUTION_FINANCIAL_CORRECTION_REQUIRED';end if;
  if (select count(*) from jsonb_array_elements(v_lines) x where x->>'id' is not null)<>(select count(distinct x->>'id') from jsonb_array_elements(v_lines) x where x->>'id' is not null)
   then raise exception 'POS_RESOLUTION_EXISTING_LINE_IDS_REQUIRED';end if;
  if exists(select 1 from jsonb_array_elements(v_lines) x where nullif(x->>'parent_ref_detail_id','') is not null and not exists(select 1 from jsonb_array_elements(v_lines) p where p->>'ref_detail_id'=x->>'parent_ref_detail_id')) then raise exception 'POS_RESOLUTION_INVALID_PARENT';end if;
  -- Edit retained rows or add explicit catalog items; no raw POS item is
  -- deleted. Explicit omitted items become excluded, with before/after audit.
  update public.pos_sales_receipt_lines set is_excluded=false where receipt_id=p_receipt_id and id in(select (x->>'id')::bigint from jsonb_array_elements(v_lines) x);
  v_result:=pos_resolution_private.edit_paid_held(p_receipt_id,v_r.revision,v_id,v_username,p_request->>'reason',p_request->>'taxMode',null,'other',v_amount,v_lines,null);
  perform pos_resolution_private.replace_payments(p_receipt_id,p_request->'payments');
  update public.pos_sales_receipts set vat_amount=v_tax,admin_resolution_version=v_version+1,admin_resolution_financial_review_required=false where id=p_receipt_id;
 else
  if v_decision is distinct from 'canceled' or p_request->'refundConfirmed' is distinct from 'true'::jsonb
   or nullif(btrim(p_request->>'refundEvidence'),'') is null then raise exception 'POS_RESOLUTION_REFUND_EVIDENCE_REQUIRED';end if;
  v_amount:=0;perform pos_resolution_private.replace_payments(p_receipt_id,'[]');
  update public.pos_sales_receipts set payment_status=4,is_canceled=true,receive_amount=0,return_amount=0,revision=revision+1,
   is_modified=true,modified_by=v_username,modified_at=clock_timestamp(),modification_note=p_request->>'reason',admin_resolution_version=v_version+1,admin_resolution_financial_review_required=false,
   inventory_deduction_processing_paused=true,inventory_deduction_processing_paused_at=clock_timestamp(),inventory_deduction_auto_eligible_at=null,
   inventory_deduction_processing_error='admin_resolution_inventory_review_required',inventory_deduction_reprocess_required=true,updated_at=clock_timestamp() where id=p_receipt_id;
  update public.pos_sales_receipt_lines set payment_status=4,is_canceled=true where receipt_id=p_receipt_id;
 end if;
 v_after:=pos_resolution_private.snapshot(p_receipt_id);
 if v_decision='paid' and ((v_after->'receipt'->>'final_amount')::numeric<>v_amount or (select coalesce(sum(amount),0) from public.pos_sales_receipt_payments where receipt_id=p_receipt_id)<>v_amount) then raise exception 'POS_RESOLUTION_FINANCIAL_CORRECTION_REQUIRED';end if;
 v_result:=jsonb_build_object('status','corrected','receiptId',p_receipt_id,'resolutionId',v_header.request_id,'resolutionVersion',v_version+1,
  'revision',v_r.revision+1,'decision',v_decision,'amount',v_amount,'inventoryHeld',true);
 if v_reclose then v_result:=v_result||jsonb_build_object('reclose',pos_resolution_private.reclose(v_date,p_actor_user_id));end if;
 insert into public.pos_sales_receipt_modifications(receipt_id,request_id,revision_before,revision_after,modified_by,modification_note,before_state,after_state,result)
 values(p_receipt_id,v_id,v_r.revision,v_r.revision+1,v_username,p_request->>'reason',v_before,v_after,v_result);
 insert into public.pos_sales_receipt_resolution_versions(receipt_id,version,request_id,actor_user_id,request_payload,decision,amount,payments,before_snapshot,after_snapshot,result,reason)
 values(p_receipt_id,v_version+1,v_id,p_actor_user_id,p_request,v_decision,v_amount,case when v_decision='paid' then p_request->'payments' else '[]' end,v_before,v_after,v_result,p_request->>'reason');
 update pos_resolution_private.recheck_jobs set next_attempt_at=least(next_attempt_at,clock_timestamp()) where receipt_id=p_receipt_id;
 insert into public.pos_sales_receipt_resolution_history(receipt_id,event,actor_user_id,snapshot)
 values(p_receipt_id,'resolution_corrected',p_actor_user_id,jsonb_build_object('requestId',v_id,'resolutionId',v_header.request_id,'versionBefore',v_version,'versionAfter',v_version+1,
  'revisionBefore',v_r.revision,'revisionAfter',v_r.revision+1,'before',v_before,'after',v_after,'result',v_result,'reason',p_request->>'reason'));
 delete from pos_resolution_private.capabilities where transaction_id=txid_current() and receipt_id=p_receipt_id;
 return v_result;
end $$;

create function pos_resolution_private.inventory_context(p_id bigint) returns text
language sql stable set search_path=pg_catalog,public as $$
 select pos_resolution_private.fingerprint(jsonb_build_object('source',pos_resolution_private.snapshot(p_id),
 'version',pos_resolution_private.version(p_id),
 'lastObservation',(select to_jsonb(o)-'raw_payload' from public.pos_sales_receipt_pos_observations o where receipt_id=p_id order by observed_at desc,id desc limit 1),
 'deductions',(select coalesce(jsonb_agg(to_jsonb(d) order by id),'[]') from public.pos_inventory_deductions d where receipt_id=p_id or invoice_ref_id=(select ref_id from public.pos_sales_receipts where id=p_id)),
 'history',(select coalesce(jsonb_agg(to_jsonb(d) order by id),'[]') from public.pos_inventory_deduction_receipts d where receipt_id=p_id),
 'inventory',(select coalesce(jsonb_agg(to_jsonb(i) order by id),'[]') from public.inventory i),
 'mappings',(select coalesce(jsonb_agg(to_jsonb(m) order by id),'[]') from public.pos_item_mappings m),
 'recipes',(select coalesce(jsonb_agg(to_jsonb(m) order by id),'[]') from public.pos_item_mapping_recipes m),
 'products',(select coalesce(jsonb_agg(to_jsonb(m) order by id),'[]') from public.pos_products m)))
$$;

create function public.sales_get_admin_resolution_work_v2(p_receipt_id bigint,p_actor_user_id bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_header jsonb;v_state jsonb;v_latest jsonb;
begin
 perform pos_resolution_private.actor(p_actor_user_id);
 select to_jsonb(h)-'before_snapshot'-'request_payload' into v_header from public.pos_sales_receipt_admin_resolutions h where receipt_id=p_receipt_id;
 if v_header is null then raise exception 'POS_RESOLUTION_NOT_FOUND';end if;
 v_state:=pos_resolution_private.snapshot(p_receipt_id);
 select to_jsonb(v)-'before_snapshot'-'after_snapshot'-'request_payload' into v_latest from public.pos_sales_receipt_resolution_versions v where receipt_id=p_receipt_id order by version desc limit 1;
 return jsonb_build_object('state',v_state,'resolution',v_header,'latest',v_latest,'version',pos_resolution_private.version(p_receipt_id),
  'fingerprint',pos_resolution_private.fingerprint(v_state),'contextFingerprint',pos_resolution_private.inventory_context(p_receipt_id),
  'policy',public.sales_get_pending_resolution_v1(p_receipt_id,p_actor_user_id),
  'history',(select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'event',h.event,'actor_user_id',h.actor_user_id,'created_at',h.created_at,
    'snapshot',jsonb_build_object('reason',h.snapshot->'reason','result',h.snapshot->'result','revisionBefore',h.snapshot->'revisionBefore','revisionAfter',h.snapshot->'revisionAfter')) order by h.id),'[]')
    from(select * from public.pos_sales_receipt_resolution_history where receipt_id=p_receipt_id order by id desc limit 50) h),
  'deductions',(select coalesce(jsonb_agg(to_jsonb(d) order by id),'[]') from public.pos_inventory_deductions d where receipt_id=p_receipt_id or invoice_ref_id=(select ref_id from public.pos_sales_receipts where id=p_receipt_id)));
end $$;

-- A plan is accepted only from the server role, never directly from a browser.
-- It must have been computed between identical DB context reads.
create function public.sales_preview_admin_resolution_inventory_v2(p_receipt_id bigint,p_actor_user_id bigint,p_context text,p_plan jsonb,p_blockers jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid;v_blockers jsonb:=coalesce(p_blockers,'[]');v_r public.pos_sales_receipts%rowtype;
begin
 perform pos_resolution_private.actor(p_actor_user_id);
 perform 1 from public.pos_sales_receipts where id=p_receipt_id for update;
 if not exists(select 1 from public.pos_sales_receipt_admin_resolutions where receipt_id=p_receipt_id) then raise exception 'POS_RESOLUTION_NOT_FOUND';end if;
 if p_context is distinct from pos_resolution_private.inventory_context(p_receipt_id) then raise exception 'POS_RESOLUTION_STALE_PREVIEW';end if;
 select * into v_r from public.pos_sales_receipts where id=p_receipt_id;
 if v_r.inventory_deduction_processing_paused is not true then v_blockers:=v_blockers||'"inventory_already_approved"'::jsonb;end if;
 if v_r.is_canceled is not true then
  if v_r.admin_resolution_financial_review_required is true or not pos_resolution_private.financial_consistent(p_receipt_id,v_r.final_amount) or v_r.final_amount is distinct from (select coalesce(sum(amount),0) from public.pos_sales_receipt_payments where receipt_id=p_receipt_id)
   or v_r.final_amount is distinct from (select coalesce(sum(final_amount+coalesce(tax_amount,0)),0) from public.pos_sales_receipt_lines where receipt_id=p_receipt_id and is_excluded is not true and is_canceled is not true)
  then v_blockers:=v_blockers||'"financial_correction_required"'::jsonb;end if;
  if exists(select 1 from public.pos_sales_receipt_lines where receipt_id=p_receipt_id and is_excluded is not true and is_canceled is not true
    group by coalesce(nullif(raw_json->>'OrderDetailID',''),nullif(raw_json->>'OrderDetailId',''),nullif(raw_json->>'orderDetailId',''),nullif(ref_detail_id,''),item_code),coalesce(parent_ref_detail_id,''),coalesce(item_code,'') having count(*)>1)
  then v_blockers:=v_blockers||'"ambiguous_duplicate_order"'::jsonb;end if;
  if exists(select 1 from public.pos_sales_receipt_lines where receipt_id=p_receipt_id and is_excluded is not true and is_canceled is not true and nullif(ref_detail_id,'') is not null group by ref_detail_id having count(*)>1)
  then v_blockers:=v_blockers||'"duplicate_ref_detail"'::jsonb;end if;
  if exists(select 1 from public.pos_sales_receipt_lines l where l.receipt_id=p_receipt_id and l.is_excluded is not true and l.parent_ref_detail_id is not null
    and not exists(select 1 from public.pos_sales_receipt_lines p where p.receipt_id=p_receipt_id and p.ref_detail_id=l.parent_ref_detail_id and p.is_excluded is not true))
  then v_blockers:=v_blockers||'"missing_effective_parent"'::jsonb;end if;
 end if;
 insert into public.pos_sales_receipt_inventory_reviews(receipt_id,resolution_version,actor_user_id,context_fingerprint,plan,blockers)
 values(p_receipt_id,pos_resolution_private.version(p_receipt_id),p_actor_user_id,p_context,p_plan,v_blockers) returning id into v_id;
 return jsonb_build_object('reviewId',v_id,'plan',p_plan,'blockers',v_blockers,'expiresInSeconds',900);
end $$;

-- Block every legacy entry point BEFORE taking its batch locks. Normal POS
-- receipts still use the exact existing implementation. Only the atomic v2
-- approval may invoke a legacy engine for a protected receipt.
do $engines$
declare d text;n text;s text;guard text;
begin
 for n,s,guard in select * from (values
 ('apply_sales_inventory_deduction_batch','bigint,text,jsonb',
  'exists(select 1 from public.pos_inventory_deduction_receipts b join public.pos_sales_receipt_admin_resolutions a on a.receipt_id=b.receipt_id where b.batch_id=p_batch_id and not exists(select 1 from pos_resolution_private.work_capabilities c where c.transaction_id=txid_current() and c.receipt_id=b.receipt_id and purpose=''inventory''))'),
 ('reprocess_modified_sales_inventory_deduction_receipt','bigint,text,timestamptz,text,text',
  'exists(select 1 from public.pos_inventory_deduction_receipts b join public.pos_sales_receipt_admin_resolutions a on a.receipt_id=b.receipt_id where b.id=p_batch_receipt_id and not exists(select 1 from pos_resolution_private.work_capabilities c where c.transaction_id=txid_current() and c.receipt_id=b.receipt_id and purpose=''inventory''))'),
 ('rollback_canceled_sales_inventory_deduction_receipt','bigint,text,timestamptz,text',
  'exists(select 1 from public.pos_sales_receipt_admin_resolutions a where a.receipt_id=p_receipt_id and not exists(select 1 from pos_resolution_private.work_capabilities c where c.transaction_id=txid_current() and c.receipt_id=a.receipt_id and purpose=''inventory''))')
 ) t(n,s,g) loop
  d:=pg_get_functiondef(('public.'||n||'('||s||')')::regprocedure);
  if position(E'begin\n' in d)=0 then raise exception 'POS_RESOLUTION_ENGINE_CONTRACT_MISMATCH';end if;
  d:=regexp_replace(d,E'begin\n',E'begin\n if '||guard||' then raise exception ''POS_RESOLUTION_INVENTORY_APPROVAL_REQUIRED'';end if;'||E'\n');
  execute d;
 end loop;
end $engines$;

create function public.sales_confirm_admin_resolution_inventory_v2(p_receipt_id bigint,p_actor_user_id bigint,p_request jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_user text;v_date date;v_review public.pos_sales_receipt_inventory_reviews%rowtype;v_old public.pos_sales_receipt_inventory_approvals%rowtype;
 v_r public.pos_sales_receipts%rowtype;v_result jsonb;v_id uuid;v_batch bigint;v_br bigint;v_line jsonb;v_d jsonb;v_plan jsonb;v_work text;v_execution text;v_reclose boolean;
begin
 v_user:=pos_resolution_private.actor(p_actor_user_id,true);
 v_date:=pos_resolution_private.lock_source(p_receipt_id);
 v_id:=(p_request->>'requestId')::uuid;
 if v_id is null or nullif(btrim(p_request->>'reason'),'') is null or length(p_request->>'reason')>2000 then raise exception 'POS_RESOLUTION_INVALID_INPUT';end if;
 select * into v_old from public.pos_sales_receipt_inventory_approvals where request_id=v_id;
 if found then
  if v_old.receipt_id=p_receipt_id and v_old.actor_user_id=p_actor_user_id and v_old.request_payload=p_request then return v_old.result;end if;
  raise exception 'POS_RESOLUTION_REQUEST_CONFLICT';
 end if;
 -- Hold stock, mappings and history stable until the legacy engine completes.
 lock table public.inventory,public.pos_item_mappings,public.pos_item_mapping_recipes,public.pos_products,public.pos_inventory_deductions,public.pos_inventory_deduction_receipts in share row exclusive mode;
 select * into v_review from public.pos_sales_receipt_inventory_reviews where id=(p_request->>'reviewId')::uuid and receipt_id=p_receipt_id;
 if not found or v_review.expires_at<clock_timestamp() or v_review.resolution_version<>pos_resolution_private.version(p_receipt_id)
  or v_review.context_fingerprint is distinct from pos_resolution_private.inventory_context(p_receipt_id)
 then raise exception 'POS_RESOLUTION_STALE_PREVIEW';end if;
 if v_review.blockers<>'[]'::jsonb then raise exception 'POS_RESOLUTION_INVENTORY_BLOCKED';end if;
 if exists(select 1 from public.pos_sales_receipt_inventory_approvals where review_id=v_review.id) then raise exception 'POS_RESOLUTION_REVIEW_ALREADY_USED';end if;
 if (select count(*) from public.pos_inventory_deductions d where d.receipt_id=p_receipt_id and d.operation_type is distinct from 'revert'
  and (d.status in('applied','success') or d.applied_at is not null or d.inventory_log_id is not null)
  and not exists(select 1 from public.pos_inventory_deductions r where r.reversal_of_deduction_id=d.id and (r.status in('applied','success','reverted') or r.applied_at is not null or r.inventory_log_id is not null)))
  is distinct from (v_review.plan->>'activeCount')::bigint then raise exception 'POS_RESOLUTION_INVALID_PLAN';end if;
 v_reclose:=pos_resolution_private.authorize_day(v_date,p_actor_user_id,p_request,true);
 select * into v_r from public.pos_sales_receipts where id=p_receipt_id;
 if v_r.inventory_deduction_processing_paused is not true then raise exception 'POS_RESOLUTION_INVENTORY_ALREADY_APPROVED';end if;
 insert into pos_resolution_private.capabilities values(txid_current(),p_receipt_id);
 insert into pos_resolution_private.work_capabilities values(txid_current(),p_receipt_id,'inventory');
 -- This unpause exists only inside this transaction, while all relevant locks
 -- and the unforgeable capability are held. Any error rolls it back.
 update public.pos_sales_receipts set inventory_deduction_processing_paused=false,inventory_deduction_auto_eligible_at=null where id=p_receipt_id;
 v_plan:=v_review.plan;v_work:=v_plan->>'workflow';
 -- Content may legitimately return to an older value (1 -> 2 -> 1 -> 2).
 -- Keep the canonical content separately; scope engine idempotency by the
 -- immutable administrator version and mapping/inventory fingerprint.
 v_execution:=pos_resolution_private.fingerprint(jsonb_build_object('content',v_plan->>'contentFingerprint','inventory',v_plan->>'inventoryHash',
  'resolutionId',(select request_id from public.pos_sales_receipt_admin_resolutions where receipt_id=p_receipt_id),'version',v_review.resolution_version));
 if v_work='rollback_canceled' then
  if v_r.is_canceled is not true then raise exception 'POS_RESOLUTION_STALE_PREVIEW';end if;
  v_result:=public.rollback_canceled_sales_inventory_deduction_receipt(p_receipt_id,v_user,v_r.updated_at,v_execution);
  if v_result->>'result'='applied' then
   update public.pos_inventory_deduction_receipts set admin_resolution_content_fingerprint=v_plan->>'contentFingerprint'
    where id=(v_result->>'deductionReceiptId')::bigint and receipt_id=p_receipt_id;
  end if;
 elsif v_work='no_stock_change' then
  if coalesce((v_plan->>'activeCount')::integer,-1)<>0 or v_r.is_canceled is not true then raise exception 'POS_RESOLUTION_INVALID_PLAN';end if;
  v_result:=jsonb_build_object('result','already_processed','status','applied','noStockChange',true);
 elsif v_work in('initial_apply','reprocess_modified') then
  if v_r.payment_status<>3 or v_r.is_canceled is true then raise exception 'POS_RESOLUTION_STALE_PREVIEW';end if;
  insert into public.pos_inventory_deduction_batches(flow_version,business_date_from,business_date_to,source,status,receipt_count,ready_receipt_count,created_by,note)
   values('sales_db_v1',v_date,v_date,case when v_work='initial_apply' then 'manual_preview' else 'reprocess_modified' end,'previewed',1,1,v_user,p_request->>'reason') returning id into v_batch;
  insert into public.pos_inventory_deduction_receipts(batch_id,receipt_id,receipt_ref_no,business_date,status,inventory_affecting_hash,amount_hash,previewed_receipt_updated_at,blocked_reasons,line_summary,selected_for_apply,workflow_type,receipt_content_fingerprint,admin_resolution_content_fingerprint)
   values(v_batch,p_receipt_id,v_r.ref_no,v_date,'ready',v_plan->>'inventoryHash',v_plan->>'amountHash',v_r.updated_at,'[]',jsonb_build_object('hashVersion',v_plan->'hashVersion','lines',v_plan->'lines','adminResolutionVersion',v_review.resolution_version,'reviewId',v_review.id),true,v_work,v_execution,v_plan->>'contentFingerprint') returning id into v_br;
  for v_line in select value from jsonb_array_elements(v_plan->'lines') loop
   for v_d in select value from jsonb_array_elements(v_line->'deductions') loop
    insert into public.pos_inventory_deductions(invoice_ref_id,ref_detail_id,pos_item_code,pos_item_name,pos_quantity,mapping_type,inventory_item_id,deduct_quantity,status,flow_version,batch_id,batch_receipt_id,receipt_id,receipt_line_id,receipt_ref_no,business_date,mapping_id,recipe_id,operation_type,mapping_snapshot,inventory_affecting_hash,amount_hash,idempotency_key,quantity_sold,deduct_quantity_per_unit,deduct_quantity_total,current_quantity_snapshot,after_quantity_snapshot)
    values(v_r.ref_id,v_line->>'refDetailId',v_line->>'posItemCode',v_line->>'itemName',(v_line->>'quantitySold')::numeric,v_line->>'mappingType',(v_d->>'inventoryItemId')::bigint,(v_d->>'deductQuantity')::numeric,'selected','sales_db_v1',v_batch,v_br,p_receipt_id,(v_line->>'receiptLineId')::bigint,v_r.ref_no,v_date,(v_line->>'mappingId')::bigint,(v_d->>'recipeId')::bigint,'preview',coalesce(v_line->'mappingSnapshot','{}')||jsonb_build_object('recipeVersion',v_d->'recipeVersion'),v_plan->>'inventoryHash',v_plan->>'amountHash',v_id::text||':'||(v_line->>'receiptLineId')||':'||(v_d->>'inventoryItemId')||':'||coalesce(v_d->>'recipeId',''),(v_line->>'quantitySold')::numeric,(v_d->>'deductQuantityPerUnit')::numeric,(v_d->>'deductQuantity')::numeric,(v_d->>'currentQuantity')::numeric,(v_d->>'afterQuantity')::numeric);
   end loop;
  end loop;
  if v_work='initial_apply' then
   v_result:=public.apply_sales_inventory_deduction_batch(v_batch,v_user,jsonb_build_array(jsonb_build_object('receiptId',p_receipt_id,'currentInventoryHash',v_plan->>'inventoryHash','currentReceiptUpdatedAt',v_r.updated_at,'applyAllowed',true)));
  else
   v_result:=public.reprocess_modified_sales_inventory_deduction_receipt(v_br,v_user,v_r.updated_at,v_execution,v_plan->>'inventoryHash');
  end if;
 else raise exception 'POS_RESOLUTION_INVALID_PLAN';end if;
 if coalesce(v_result->>'result',v_result->>'status','') not in('applied','already_processed') then raise exception 'POS_RESOLUTION_INVENTORY_EXECUTION_FAILED' using detail=v_result::text;end if;
 update public.pos_sales_receipts set inventory_deduction_processing_paused=false,inventory_deduction_auto_eligible_at=null,inventory_deduction_reprocess_required=false where id=p_receipt_id;
 v_result:=jsonb_build_object('status','approved','workflow',v_work,'result',v_result,'reviewId',v_review.id,'inventoryHeld',false,
  'contentFingerprint',v_plan->>'contentFingerprint','executionFingerprint',v_execution);
 if v_reclose then v_result:=v_result||jsonb_build_object('reclose',pos_resolution_private.reclose(v_date,p_actor_user_id));end if;
 insert into public.pos_sales_receipt_inventory_approvals values(v_id,v_review.id,p_receipt_id,p_actor_user_id,p_request,v_result,p_request->>'reason',now());
 insert into public.pos_sales_receipt_resolution_history(receipt_id,event,actor_user_id,snapshot) values(p_receipt_id,'inventory_approved',p_actor_user_id,jsonb_build_object('requestId',v_id,'reviewId',v_review.id,'reason',p_request->>'reason','result',v_result));
 delete from pos_resolution_private.work_capabilities where transaction_id=txid_current() and receipt_id=p_receipt_id;
 delete from pos_resolution_private.capabilities where transaction_id=txid_current() and receipt_id=p_receipt_id;
 return v_result;
end $$;

-- Compare POS with the latest effective resolution, keeping all observations.
do $observe$
declare d text;
begin
 d:=pg_get_functiondef('public.sales_observe_resolved_receipts_v1(jsonb)'::regprocedure);
 d:=replace(d,'  v_reconciliation:=case','  select decision,amount into v_a.decision,v_a.confirmed_amount from public.pos_sales_receipt_resolution_versions where receipt_id=v_r.id order by version desc limit 1;'||E'\n'||'  if not found then select * into v_a from public.pos_sales_receipt_admin_resolutions where receipt_id=v_r.id;end if;'||E'\n'||'  v_reconciliation:=case');
 d:=replace(d,'v_key:=pos_resolution_private.fingerprint(v_item);','v_key:=pos_resolution_private.fingerprint(v_item||jsonb_build_object(''resolutionVersion'',pos_resolution_private.version(v_r.id)));');
 d:=replace(d,'final_amount,raw_payload,reconciliation)','final_amount,raw_payload,reconciliation,resolution_version)');
 d:=replace(d,'v_item->''raw'',v_reconciliation)','v_item->''raw'',v_reconciliation,pos_resolution_private.version(v_r.id))');
 execute d;
 d:=pg_get_functiondef('public.sales_claim_pending_rechecks_v1()'::regprocedure);
 if position('o.reconciliation=''matched''' in d)=0 then raise exception 'POS_RESOLUTION_RECHECK_CONTRACT_MISMATCH';end if;
 d:=replace(d,'o.reconciliation=''matched''','o.reconciliation=''matched'' and o.resolution_version=pos_resolution_private.version(r.id)');
 execute d;
 d:=pg_get_functiondef('public.sales_get_pending_resolution_v1(bigint,bigint)'::regprocedure);
 d:=replace(d,'select to_jsonb(o)-''raw_payload'' from public.pos_sales_receipt_pos_observations o',
  'select (to_jsonb(o)-''raw_payload'')||case when o.resolution_version is distinct from pos_resolution_private.version(p_receipt_id) then jsonb_build_object(''reconciliation'',''unknown'') else ''{}''::jsonb end from public.pos_sales_receipt_pos_observations o');
 execute d;
end $observe$;

-- Fail closed instead of allowing a held financial transition to become an
-- official closing/ledger source. No source fields or fingerprints change for
-- normal receipts. A held initial resolution cannot reclose an existing day.
do $financial_source$
declare d text;
begin
 d:=pg_get_functiondef('pos_sales_close_private.build_source(date)'::regprocedure);
 if position(E'begin\n' in d)=0 then raise exception 'POS_RESOLUTION_SOURCE_CONTRACT_MISMATCH';end if;
 d:=replace(d,E'begin\n',E'begin\n if exists(select 1 from public.pos_sales_receipts where business_date=p_date and payment_status=3 and is_canceled is not true and admin_resolution_financial_review_required=true) then raise exception ''POS_RESOLUTION_FINANCIAL_CORRECTION_REQUIRED'';end if;\n');
 if position('from public.pos_sales_receipt_payments p join public.pos_sales_receipts r on r.id = p.receipt_id' in d)=0 then raise exception 'POS_RESOLUTION_PAYMENT_SOURCE_CONTRACT_MISMATCH';end if;
 d:=replace(d,'from public.pos_sales_receipt_payments p join public.pos_sales_receipts r on r.id = p.receipt_id','from public.pos_sales_receipt_payments p join public.pos_sales_receipts r on r.id = p.receipt_id and p.admin_resolution_retired is not true');
 d:=replace(d,'where p.receipt_id = r.id','where p.receipt_id = r.id and p.admin_resolution_retired is not true');
 execute d;
end $financial_source$;

revoke all on all functions in schema pos_resolution_private from public,anon,authenticated,service_role;
revoke all on function public.sales_resolve_pending_receipt_v2(bigint,bigint,jsonb),public.sales_correct_admin_resolution_v2(bigint,bigint,jsonb),public.sales_get_admin_resolution_work_v2(bigint,bigint),public.sales_preview_admin_resolution_inventory_v2(bigint,bigint,text,jsonb,jsonb),public.sales_confirm_admin_resolution_inventory_v2(bigint,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.sales_resolve_pending_receipt_v2(bigint,bigint,jsonb),public.sales_correct_admin_resolution_v2(bigint,bigint,jsonb),public.sales_get_admin_resolution_work_v2(bigint,bigint),public.sales_preview_admin_resolution_inventory_v2(bigint,bigint,text,jsonb,jsonb),public.sales_confirm_admin_resolution_inventory_v2(bigint,bigint,jsonb) to service_role;
commit;
