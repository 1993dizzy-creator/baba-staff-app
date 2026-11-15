-- NOT APPLIED. Owner approval is required for application AND separate activation.
-- No sales, receipt, inventory, collector or accounting objects are changed.
-- Established private SECURITY DEFINER + service-only public INVOKER wrapper pattern.
begin;
set local lock_timeout = '5s';
create schema table_operations_private;
revoke all on schema table_operations_private from public,anon,authenticated,service_role;
create table table_operations_private.config(singleton boolean primary key default true check(singleton), enabled boolean not null default false);
insert into table_operations_private.config values(true,false);
create table table_operations_private.catalog(table_id uuid primary key, table_name text not null unique, branch_id text not null);
insert into table_operations_private.catalog values
('5a052b69-a6d9-4861-bc1f-9f63f117fa2f','BAR1','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('ce3be370-e5e1-4c34-a586-ad704bfd0fff','BAR2','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('3ed3715e-249f-4c3e-9808-46e9b765feb0','BAR3','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('330083ed-5363-43c8-a7d8-c0d4059805a6','BAR4','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('e12e41dd-e625-4f6f-af78-148915faf0d9','BAR5','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('676e0935-f3a2-474b-ae9a-fe426ed032c7','BAR6','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('c61a5550-41d5-4ba6-9f47-af8ba3e999bd','BAR7','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('7d27a96d-44f4-471f-b736-416bfc4dd8f8','BAR8','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('753e2349-be88-42e2-be69-415b1ef35ca2','BAR9','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('14f542b2-92d2-488f-8808-cabb0c24db4f','BAR10','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('db63d3cc-e61a-42e0-afed-3c7d2d897850','BAR11','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('78fccd19-eccd-426d-bf47-4ebf69d110ff','1','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('6f19cf59-f09f-45c3-9a88-6eb5bf13dd6f','2','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('1d36583c-d01c-48bc-8d8b-7937c3bf0033','3','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('943d7206-b88e-433d-b73c-87f5f36d063d','4','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('296dbc39-5f0a-4ff0-a76e-8a6033ca4d76','5','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('2d187fe3-3ed0-4fff-8f3d-53d858477ed2','6','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('287c9895-cad0-46ce-8e91-b368c2dc8253','7','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('24b63fb9-46c4-4e23-9511-7580fb6e8e50','8','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('8e5c68cd-2281-4d9c-9e50-90cfbe090309','11','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('78720f8d-38d4-4ebd-a8de-a44c6e0a180b','12','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('bae28d67-45ab-42b4-a56c-e91c07617d0b','13','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('5917f86e-b860-4d47-8719-28562db4ff06','14','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('c353bcf5-7366-42c7-8958-9d1dd0a84560','15','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('a1762647-b6a2-403c-9111-e286aa526dc4','16','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('4b959b7b-7207-45be-8212-996e1f72588f','17','c39228ba-a452-4cf9-bf34-424ffb151fb8'),
('eb71c7df-22e3-4b39-8bf8-9de5094d45cf','18','c39228ba-a452-4cf9-bf34-424ffb151fb8');
create table table_operations_private.cleaning_events(
 id bigint generated always as identity primary key,
 request_id uuid not null unique, staff_user_id bigint not null references public.users(id),
 scope text not null, table_id uuid not null references table_operations_private.catalog(table_id),
 -- Logical receipt reference + immutable evidence key, deliberately NO receipt FK:
 -- operational cleaning must not change ledger deletion/correction constraints.
 business_date date not null, receipt_id bigint not null check(receipt_id>0),
 evidence_key text not null check(evidence_key ~ '^[0-9a-f]{32}$'),
 order_epoch jsonb not null check(jsonb_typeof(order_epoch)='array'),
 confirmed_at timestamptz not null default clock_timestamp(),
 event_kind text not null default 'manual_cleaning' check(event_kind='manual_cleaning'),
 unique(scope,table_id,business_date,evidence_key)
);
-- Append-only invalidation survives snapshot retention and canceled/replaced receipts.
create table table_operations_private.invalidations(
 id bigint generated always as identity primary key,
 event_id bigint not null unique references table_operations_private.cleaning_events(id),
 reason text not null, observed_at timestamptz not null default clock_timestamp()
);
alter table table_operations_private.config enable row level security;
alter table table_operations_private.catalog enable row level security;
alter table table_operations_private.cleaning_events enable row level security;
alter table table_operations_private.invalidations enable row level security;
revoke all on all tables in schema table_operations_private from public,anon,authenticated,service_role;
revoke all on all sequences in schema table_operations_private from public,anon,authenticated,service_role;

-- Full row/line hashes detect revisions without exposing raw/customer data to clients.
create function table_operations_private.receipt_version_v1(p_id bigint) returns text
language sql stable set search_path='' as $$
 select md5(jsonb_build_array(to_jsonb(r),coalesce((select jsonb_agg(to_jsonb(l) order by l.id)
   from public.pos_sales_receipt_lines l where l.receipt_id=r.id and l.source='cukcuk'),'[]'::jsonb))::text)
 from public.pos_sales_receipts r where r.id=p_id
$$;
create function table_operations_private.receipts_v1(p_scope text,p_day date) returns jsonb
language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'ref_no',r.ref_no,'final_amount',r.final_amount,
  'payment_status',r.payment_status,'is_canceled',r.is_canceled,'business_date',r.business_date,
  'ref_date',r.ref_date,'status_changed_at',r.status_changed_at,'order_id',r.raw_json->>'OrderId',
  'table_name',r.raw_json->>'TableName','version',table_operations_private.receipt_version_v1(r.id)) order by r.id),'[]'::jsonb)
 from public.pos_sales_receipts r where r.source='cukcuk' and r.branch_id=split_part(p_scope,':',2)
  and r.business_date between p_day and p_day+1
$$;

-- Conservative independent eligibility checks, in addition to the server's complete v3
-- overview policy. RefDate is a receipt reference, NEVER a timer start or occupancy fact.
create function table_operations_private.evidence_v1(p_scope text,p_day date,p_table uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare c table_operations_private.catalog%rowtype; r public.pos_sales_receipts%rowtype; epoch jsonb;
begin
 select * into c from table_operations_private.catalog where table_id=p_table and branch_id=split_part(p_scope,':',2);
 if not found then return null;end if;
 select * into r from public.pos_sales_receipts where source='cukcuk' and branch_id=c.branch_id and business_date=p_day
  and lower(btrim(raw_json->>'TableName'))=lower(c.table_name) and payment_status=3 and is_canceled=false
  order by ref_date desc nulls last,id desc limit 1;
 if not found or r.ref_date is null or r.ref_date>clock_timestamp() or r.final_amount is null or r.final_amount<0
  or public.store_business_date_for_timestamp_v1(r.ref_date)::date<>p_day
  or nullif(btrim(r.raw_json->>'OrderId'),'') is null then return null;end if;
 -- Any merge membership blocks physical cleaning, including a surviving receipt whose
 -- TableName points at a different physical table (#8885 shape).
 if exists(select 1 from pos_open_orders_private.orders o where o.scope=p_scope and o.business_date=p_day
  and o.closure_merged_into_order_id is not null and (o.closure_receipt_id=r.id or lower(btrim(o.table_name))=lower(c.table_name))) then return null;end if;
 if exists(select 1 from public.pos_sales_receipts x where x.source='cukcuk' and x.branch_id=c.branch_id
  and x.business_date between p_day and p_day+1 and x.is_canceled is not true and (x.payment_status is null or x.payment_status not in(4,5))
  and (lower(btrim(x.raw_json->>'TableName'))=lower(c.table_name) or lower(btrim(x.raw_json->>'OrderId'))=lower(btrim(r.raw_json->>'OrderId')))
  and (x.payment_status is distinct from 3 or x.is_canceled is distinct from false or nullif(btrim(x.raw_json->>'OrderId'),'') is null
    or (select count(*) from public.pos_sales_receipts y where y.source='cukcuk' and y.branch_id=c.branch_id
       and y.business_date between p_day and p_day+1 and lower(btrim(y.raw_json->>'OrderId'))=lower(btrim(x.raw_json->>'OrderId'))
       and y.is_canceled is not true and (y.payment_status is null or y.payment_status not in(4,5)))<>1)) then return null;end if;
 -- An unconverted current order at this table blocks. A retained paid order is history.
 if exists(select 1 from pos_open_orders_private.orders o where o.scope=p_scope and o.business_date=p_day
   and lower(btrim(o.table_name))=lower(c.table_name) and o.status is distinct from 5
   and not exists(select 1 from public.pos_sales_receipts x where x.source='cukcuk' and x.branch_id=c.branch_id
    and x.business_date between p_day and p_day+1 and lower(btrim(x.raw_json->>'OrderId'))=lower(o.order_id)
    and x.payment_status=3 and x.is_canceled=false and x.ref_date>=o.order_date)) then return null;end if;
 -- All retained table orders define a generation. A new order permanently invalidates
 -- an older event even after that order is canceled, until a new cleaning action.
 select coalesce(jsonb_agg(jsonb_build_array(o.order_id,o.order_date,o.status,o.table_name,o.closure_receipt_id,
  o.closure_merged_into_order_id) order by o.order_id),'[]'::jsonb) into epoch
 from pos_open_orders_private.orders o where o.scope=p_scope and o.business_date=p_day and lower(btrim(o.table_name))=lower(c.table_name);
 return jsonb_build_object('receiptId',r.id,'orderEpoch',epoch,'evidenceKey',md5(jsonb_build_array(p_table,p_day,
   table_operations_private.receipt_version_v1(r.id),epoch,
   (select coalesce(max(i.id),0) from table_operations_private.invalidations i join table_operations_private.cleaning_events e on e.id=i.event_id
    where e.scope=p_scope and e.table_id=p_table and e.business_date=p_day))::text));
end $$;

create function table_operations_private.context_v1(p_scope text,p_day date) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare snap jsonb; receipts jsonb; keys jsonb:='{}'; cleaned jsonb:='[]'; c record; e jsonb; fresh boolean;
begin
 if (select enabled from table_operations_private.config where singleton) is distinct from true then return jsonb_build_object('enabled',false);end if;
 if p_scope is null or p_scope !~ '^[a-f0-9]{64}:[a-zA-Z0-9-]+$' or p_day is distinct from public.store_business_date_for_timestamp_v1(clock_timestamp())::date then
  raise exception 'cleaning_stale' using errcode='40001';end if;
 perform pg_advisory_xact_lock(hashtextextended('pos_open_orders:'||p_scope,0));
 lock table public.pos_sales_receipts in share mode;
 lock table public.pos_sales_receipt_lines in share mode;
 snap:=pos_open_orders_private.read_v1(p_scope,p_day);
 receipts:=table_operations_private.receipts_v1(p_scope,p_day);
 select exists(select 1 from pos_open_orders_private.sync_state where scope=p_scope and business_date=p_day and last_error_code is null
  and last_success_at between clock_timestamp()-interval '10 minutes' and clock_timestamp())
  and not exists(select 1 from pos_open_orders_private.runs where scope=p_scope and status='collecting' and lease_until>clock_timestamp()) into fresh;
 if fresh then
  for c in select table_id from table_operations_private.catalog where branch_id=split_part(p_scope,':',2) loop
   e:=table_operations_private.evidence_v1(p_scope,p_day,c.table_id);
   if e is not null then
    keys:=keys||jsonb_build_object(c.table_id::text,jsonb_build_object('receiptId',e->'receiptId','evidenceKey',e->'evidenceKey'));
    if exists(select 1 from table_operations_private.cleaning_events x where scope=p_scope and table_id=c.table_id and business_date=p_day and evidence_key=e->>'evidenceKey'
      and not exists(select 1 from table_operations_private.invalidations i where i.event_id=x.id)) then
     cleaned:=cleaned||jsonb_build_array(c.table_id);end if;
   end if;
  end loop;
 end if;
 return jsonb_build_object('enabled',true,'snapshot',snap,'receipts',receipts,'keys',keys,'cleanedTableIds',cleaned);
end $$;

create function table_operations_private.confirm_v1(p_scope text,p_day date,p_table uuid,p_actor bigint,p_request uuid,
 p_receipt bigint,p_key text,p_snapshot jsonb,p_receipts jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare e jsonb; prior table_operations_private.cleaning_events%rowtype; v_id bigint;
begin
 if p_request is null or p_key is null or p_snapshot is null or jsonb_typeof(p_receipts) is distinct from 'array' then
  raise exception 'cleaning_invalid' using errcode='22023';end if;
 -- Same order as the collector: scope advisory lock, then receipt share lock.
 perform pg_advisory_xact_lock(hashtextextended('pos_open_orders:'||p_scope,0));
 lock table public.pos_sales_receipts in share mode;
 lock table public.pos_sales_receipt_lines in share mode;
 perform 1 from public.users where id=p_actor and is_active=true and app_login_enabled=true
  and role in('master','owner','manager','leader','staff') for share;
 if not found then raise exception 'cleaning_forbidden' using errcode='42501';end if;
 if (select enabled from table_operations_private.config where singleton) is distinct from true then raise exception 'cleaning_disabled' using errcode='55000';end if;
 if p_scope is null or p_scope !~ '^[a-f0-9]{64}:[a-zA-Z0-9-]+$' or p_day is distinct from public.store_business_date_for_timestamp_v1(clock_timestamp())::date
  or exists(select 1 from pos_open_orders_private.runs where scope=p_scope and status='collecting' and lease_until>clock_timestamp())
  or not exists(select 1 from pos_open_orders_private.sync_state where scope=p_scope and business_date=p_day and last_error_code is null
     and last_success_at between clock_timestamp()-interval '10 minutes' and clock_timestamp()) then raise exception 'cleaning_stale' using errcode='40001';end if;
 if pos_open_orders_private.read_v1(p_scope,p_day) is distinct from p_snapshot or table_operations_private.receipts_v1(p_scope,p_day) is distinct from p_receipts then
  raise exception 'cleaning_stale' using errcode='40001';end if;
 e:=table_operations_private.evidence_v1(p_scope,p_day,p_table);
 if e is null or (e->>'receiptId')::bigint is distinct from p_receipt or e->>'evidenceKey' is distinct from p_key then
  raise exception 'cleaning_stale' using errcode='40001';end if;
 select * into prior from table_operations_private.cleaning_events where request_id=p_request;
 if found then
  if prior.scope<>p_scope or prior.table_id<>p_table or prior.staff_user_id<>p_actor or prior.business_date<>p_day
    or prior.receipt_id<>p_receipt or prior.evidence_key<>p_key then raise exception 'cleaning_request_conflict' using errcode='40001';end if;
  return jsonb_build_object('eventId',prior.id,'saved',true);
 end if;
 select id into v_id from table_operations_private.cleaning_events where scope=p_scope and table_id=p_table and business_date=p_day and evidence_key=p_key;
 if v_id is null then
  insert into table_operations_private.cleaning_events(request_id,staff_user_id,scope,table_id,business_date,receipt_id,evidence_key,order_epoch)
   values(p_request,p_actor,p_scope,p_table,p_day,p_receipt,p_key,e->'orderEpoch') returning id into v_id;
 end if;
 return jsonb_build_object('eventId',v_id,'saved',true);
end $$;

-- These AFTER triggers append operational invalidations only. They NEVER rewrite the
-- central snapshot, v3 proof, receipt or accounting values. Identical retained orders
-- reinserted by the collector do not invalidate a confirmation.
create function table_operations_private.invalidate_order_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare fact jsonb;
begin
 fact:=jsonb_build_array(new.order_id,new.order_date,new.status,new.table_name,new.closure_receipt_id,new.closure_merged_into_order_id);
 insert into table_operations_private.invalidations(event_id,reason)
 select e.id,'order_generation_changed' from table_operations_private.cleaning_events e
 join table_operations_private.catalog c on c.table_id=e.table_id
 where e.scope=new.scope and e.business_date=new.business_date
  and (lower(btrim(new.table_name))=lower(c.table_name) or exists(select 1 from jsonb_array_elements(e.order_epoch) v where v->>0=new.order_id))
  and not exists(select 1 from jsonb_array_elements(e.order_epoch) previous_fact where previous_fact=fact)
  and not exists(select 1 from table_operations_private.invalidations i where i.event_id=e.id)
 on conflict(event_id) do nothing;
 return new;
end $$;
create trigger tables_cleaning_order_invalidation after insert or update on pos_open_orders_private.orders
 for each row execute function table_operations_private.invalidate_order_v1();
create function table_operations_private.invalidate_receipt_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare r public.pos_sales_receipts%rowtype;
begin
 if tg_op='UPDATE' and to_jsonb(new) is not distinct from to_jsonb(old) then return new;end if;
 if tg_op='DELETE' then r:=old;else r:=new;end if;
 insert into table_operations_private.invalidations(event_id,reason)
 select e.id,'receipt_changed' from table_operations_private.cleaning_events e join table_operations_private.catalog c on c.table_id=e.table_id
 where r.source='cukcuk' and e.business_date=r.business_date and split_part(e.scope,':',2)=r.branch_id
  and (e.receipt_id=r.id or lower(btrim(r.raw_json->>'TableName'))=lower(c.table_name))
  and not exists(select 1 from table_operations_private.invalidations i where i.event_id=e.id)
 on conflict(event_id) do nothing;
 if tg_op='DELETE' then return old;else return new;end if;
end $$;
create trigger tables_cleaning_receipt_invalidation after insert or update or delete on public.pos_sales_receipts
 for each row execute function table_operations_private.invalidate_receipt_v1();
create function table_operations_private.invalidate_line_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare old_id bigint; new_id bigint;
begin
 if tg_op='UPDATE' and to_jsonb(new) is not distinct from to_jsonb(old) then return new;end if;
 if tg_op<>'INSERT' then old_id:=old.receipt_id;end if;
 if tg_op<>'DELETE' then new_id:=new.receipt_id;end if;
 insert into table_operations_private.invalidations(event_id,reason)
 select e.id,'receipt_menu_changed' from table_operations_private.cleaning_events e
 where e.receipt_id in(old_id,new_id) and not exists(select 1 from table_operations_private.invalidations i where i.event_id=e.id)
 on conflict(event_id) do nothing;
 if tg_op='DELETE' then return old;else return new;end if;
end $$;
create trigger tables_cleaning_line_invalidation after insert or update or delete on public.pos_sales_receipt_lines
 for each row execute function table_operations_private.invalidate_line_v1();

create function public.tables_cleaning_context_v1(p_scope text,p_day date) returns jsonb language sql security invoker set search_path='' as $$
 select table_operations_private.context_v1(p_scope,p_day) $$;
create function public.tables_cleaning_confirm_v1(p_scope text,p_day date,p_table uuid,p_actor bigint,p_request uuid,p_receipt bigint,p_key text,p_snapshot jsonb,p_receipts jsonb)
returns jsonb language sql security invoker set search_path='' as $$
 select table_operations_private.confirm_v1(p_scope,p_day,p_table,p_actor,p_request,p_receipt,p_key,p_snapshot,p_receipts) $$;
revoke all on all functions in schema table_operations_private from public,anon,authenticated,service_role;
revoke all on function public.tables_cleaning_context_v1(text,date),public.tables_cleaning_confirm_v1(text,date,uuid,bigint,uuid,bigint,text,jsonb,jsonb) from public,anon,authenticated,service_role;
grant usage on schema table_operations_private to service_role;
grant execute on function table_operations_private.context_v1(text,date),table_operations_private.confirm_v1(text,date,uuid,bigint,uuid,bigint,text,jsonb,jsonb),
 public.tables_cleaning_context_v1(text,date),public.tables_cleaning_confirm_v1(text,date,uuid,bigint,uuid,bigint,text,jsonb,jsonb) to service_role;
commit;
