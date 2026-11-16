-- NOT APPLIED. Install OFF; operating DB/application activation requires separate approval.
-- Follow-up only: never edit/replay 20261115103656_tables_cleaning_v1.
begin;
set local lock_timeout = '5s';
do $$ begin
 if to_regprocedure('table_operations_private.evidence_v1(text,date,uuid)') is null
  or to_regclass('table_operations_private.activation_generation_seq') is null then
  raise exception 'auto_normal_cleaning_p0_dependency_missing';end if;
end $$;

create sequence table_operations_private.auto_generation_seq;
create table table_operations_private.auto_config(
 singleton boolean primary key default true check(singleton), enabled boolean not null default false,
 generation bigint not null check(generation>0), activation_key uuid not null
);
create function table_operations_private.auto_activation_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' or new.enabled is distinct from old.enabled then
  new.generation:=nextval('table_operations_private.auto_generation_seq');
  new.activation_key:=gen_random_uuid();
 else new.generation:=old.generation;new.activation_key:=old.activation_key;end if;
 return new;
end $$;
create trigger tables_auto_activation before insert or update on table_operations_private.auto_config
 for each row execute function table_operations_private.auto_activation_v1();
insert into table_operations_private.auto_config(singleton) values(true);
create table table_operations_private.payment_observations(
 id bigint generated always as identity primary key,
 scope text not null, business_date date not null,
 table_id uuid not null references table_operations_private.catalog(table_id),
 receipt_id bigint not null check(receipt_id>0), evidence_key text not null,
 order_epoch jsonb not null check(jsonb_typeof(order_epoch)='array'),
 generation bigint not null, first_verified_at timestamptz not null default clock_timestamp(),
 unique(scope,business_date,table_id,generation,evidence_key)
);
create index payment_observations_receipt on table_operations_private.payment_observations(receipt_id);
create table table_operations_private.auto_invalidations(
 id bigint generated always as identity primary key,
 event_id bigint not null unique references table_operations_private.payment_observations(id),
 reason text not null, observed_at timestamptz not null default clock_timestamp()
);
alter table table_operations_private.auto_config enable row level security;
alter table table_operations_private.payment_observations enable row level security;
alter table table_operations_private.auto_invalidations enable row level security;
revoke all on table table_operations_private.auto_config,table_operations_private.payment_observations,
 table_operations_private.auto_invalidations from public,anon,authenticated,service_role;
revoke all on sequence table_operations_private.auto_generation_seq,
 table_operations_private.payment_observations_id_seq,table_operations_private.auto_invalidations_id_seq from public,anon,authenticated,service_role;

-- Existing manual evidence remains unchanged. Append-only automatic invalidations prevent
-- change -> restore resurrection even when there has been no observer run in between.
create function table_operations_private.auto_evidence_v1(p_scope text,p_day date,p_table uuid) returns jsonb
language sql stable set search_path='' as $$
 select e || jsonb_build_object('autoKey',md5(jsonb_build_array(p_table,p_day,
  table_operations_private.receipt_version_v1((e->>'receiptId')::bigint),e->'orderEpoch',
  (select coalesce(max(i.id),0) from table_operations_private.auto_invalidations i
   join table_operations_private.payment_observations o on o.id=i.event_id
   where o.scope=p_scope and o.business_date=p_day and o.table_id=p_table))::text))
 from table_operations_private.evidence_v1(p_scope,p_day,p_table) e
 join public.pos_sales_receipts r on r.id=(e->>'receiptId')::bigint
 where e is not null and not exists(select 1 from public.pos_sales_receipts x
  where x.source='cukcuk' and x.branch_id=r.branch_id and x.business_date=p_day
   and lower(btrim(x.raw_json->>'TableName'))=lower(btrim(r.raw_json->>'TableName'))
   and (x.ref_date,x.id)>(r.ref_date,r.id) and (x.is_canceled or x.payment_status in(4,5)))
$$;

-- Pure MVCC read: no INSERT, advisory/row/POS SHARE locks. One statement snapshot.
-- Also works with manual cleaning OFF; manual proof and its RPC are not replaced.
create function table_operations_private.auto_context_v1(p_scope text,p_day date,p_activation uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare cfg table_operations_private.auto_config%rowtype; snap jsonb; receipts jsonb;
 keys jsonb:='{}'; cleaned jsonb:='[]'; observations jsonb:='{}'; review jsonb; c record; e jsonb; o record;
 fresh boolean; manual boolean; at_time timestamptz:=statement_timestamp();
begin
 select * into cfg from table_operations_private.auto_config where singleton;
 if cfg.enabled is distinct from true or cfg.activation_key is distinct from p_activation then
  return jsonb_build_object('enabled',false);end if;
 if (select count(*) from pg_trigger where tgname in('tables_auto_order_invalidation',
  'tables_auto_receipt_invalidation','tables_auto_line_invalidation') and tgenabled='O')<>3 then
  return jsonb_build_object('enabled',false);end if;
 if p_scope is null or p_scope !~ '^[a-f0-9]{64}:[a-zA-Z0-9-]+$'
  or p_day is distinct from public.store_business_date_for_timestamp_v1(at_time)::date then
  raise exception 'auto_normal_stale' using errcode='40001';end if;
 manual:=coalesce((select enabled from table_operations_private.config where singleton),false);
 snap:=pos_open_orders_private.read_v1(p_scope,p_day);
 receipts:=table_operations_private.receipts_v1(p_scope,p_day);
 select exists(select 1 from pos_open_orders_private.sync_state where scope=p_scope and business_date=p_day
  and last_error_code is null and last_success_at between at_time-interval '10 minutes' and at_time)
  and not exists(select 1 from pos_open_orders_private.runs where scope=p_scope and status='collecting' and lease_until>at_time) into fresh;
 if fresh then
  for c in select table_id from table_operations_private.catalog where branch_id=split_part(p_scope,':',2) loop
   e:=table_operations_private.auto_evidence_v1(p_scope,p_day,c.table_id);
   if e is not null then
    keys:=keys||jsonb_build_object(c.table_id::text,e);
    if manual and exists(select 1 from table_operations_private.cleaning_events x
     where scope=p_scope and business_date=p_day and table_id=c.table_id and evidence_key=e->>'evidenceKey'
     and not exists(select 1 from table_operations_private.invalidations i where i.event_id=x.id)) then
     cleaned:=cleaned||jsonb_build_array(c.table_id);end if;
    select x.first_verified_at into o from table_operations_private.payment_observations x
     where x.scope=p_scope and x.business_date=p_day and x.table_id=c.table_id and x.generation=cfg.generation
      and x.evidence_key=e->>'autoKey' and x.receipt_id=(e->>'receiptId')::bigint
      and not exists(select 1 from table_operations_private.auto_invalidations i where i.event_id=x.id);
    if found and o.first_verified_at<=at_time then
     observations:=observations||jsonb_build_object(c.table_id::text,jsonb_build_object(
      'receiptId',e->'receiptId','firstVerifiedAt',o.first_verified_at,
      'expiresAt',o.first_verified_at+interval '30 minutes','expired',at_time>=o.first_verified_at+interval '30 minutes'));
    end if;
   end if;
  end loop;
 end if;
 select coalesce(jsonb_agg(distinct x.table_id),'[]') into review
  from table_operations_private.payment_observations x where x.scope=p_scope and x.business_date=p_day
   and x.generation=cfg.generation and not (keys ? x.table_id::text);
 return jsonb_build_object('enabled',true,'manualEnabled',manual,'serverNow',at_time,
  'snapshot',snap,'receipts',receipts,'keys',keys,'cleanedTableIds',cleaned,'observations',observations,'reviewTableIds',review);
end $$;

-- Separate post-response observer, NEVER part of the collector's commit transaction.
-- Complete server overview policy supplies paid table ids; recheck exact DB snapshot,
-- receipts and independent DB eligibility under the same lock order as manual confirm.
-- Bounded contention: caller catches failure and retries on a future successful run.
create function table_operations_private.observe_payments_v1(p_scope text,p_day date,p_activation uuid,
 p_tables jsonb,p_snapshot jsonb,p_receipts jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='150ms' set statement_timeout='2s' as $$
declare cfg table_operations_private.auto_config%rowtype; c jsonb; e jsonb; ctx jsonb; n integer:=0;
begin
 if jsonb_typeof(p_tables) is distinct from 'array' or jsonb_array_length(p_tables)>27
  or p_snapshot is null or p_receipts is null then raise exception 'auto_normal_invalid' using errcode='22023';end if;
 if not exists(select 1 from table_operations_private.auto_config where singleton and enabled and activation_key=p_activation) then
  return jsonb_build_object('saved',0,'enabled',false);end if;
 perform pg_advisory_xact_lock(hashtextextended('pos_open_orders:'||p_scope,0));
 lock table public.pos_sales_receipts in share mode;
 lock table public.pos_sales_receipt_lines in share mode;
 select * into cfg from table_operations_private.auto_config where singleton and enabled and activation_key=p_activation for share;
 if not found then return jsonb_build_object('saved',0,'enabled',false);end if;
 ctx:=table_operations_private.auto_context_v1(p_scope,p_day,p_activation);
 if ctx->'snapshot' is distinct from p_snapshot or ctx->'receipts' is distinct from p_receipts then
  raise exception 'auto_normal_stale' using errcode='40001';end if;
 for c in select value from jsonb_array_elements(p_tables) loop
  -- Cast through jsonb intentionally: reject missing, mismatched and stale evidence.
  e:=ctx->'keys'->(c->>'tableId');
  if e is null or e->>'autoKey' is distinct from c->>'autoKey'
   or e->'receiptId' is distinct from c->'receiptId' then raise exception 'auto_normal_stale' using errcode='40001';end if;
  insert into table_operations_private.payment_observations(scope,business_date,table_id,receipt_id,evidence_key,order_epoch,generation)
   values(p_scope,p_day,(c->>'tableId')::uuid,(e->>'receiptId')::bigint,e->>'autoKey',e->'orderEpoch',cfg.generation)
   on conflict(scope,business_date,table_id,generation,evidence_key) do nothing;
  if found then n:=n+1;end if;
 end loop;
 return jsonb_build_object('saved',n,'enabled',true);
end $$;

create function public.tables_auto_context_v1(p_scope text,p_day date,p_activation uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select table_operations_private.auto_context_v1(p_scope,p_day,p_activation) $$;
create function public.tables_observe_payments_v1(p_scope text,p_day date,p_activation uuid,
 p_tables jsonb,p_snapshot jsonb,p_receipts jsonb) returns jsonb
language sql security invoker set search_path='' as $$
 select table_operations_private.observe_payments_v1(p_scope,p_day,p_activation,p_tables,p_snapshot,p_receipts) $$;

create function table_operations_private.auto_invalidate_order_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare fact jsonb;
begin
 if (select enabled from table_operations_private.auto_config where singleton) is distinct from true then return new;end if;
 fact:=jsonb_build_array(new.order_id,new.order_date,new.status,new.table_name,new.closure_receipt_id,new.closure_merged_into_order_id);
 if tg_op='UPDATE' and (old.scope,old.business_date) is distinct from (new.scope,new.business_date) then
  insert into table_operations_private.auto_invalidations(event_id,reason)
  select e.id,'order_scope_changed' from table_operations_private.payment_observations e
   join table_operations_private.catalog c on c.table_id=e.table_id
   where e.scope=old.scope and e.business_date=old.business_date
    and (lower(btrim(old.table_name))=lower(c.table_name) or exists(
      select 1 from jsonb_array_elements(e.order_epoch) v where v->>0=old.order_id))
   on conflict(event_id) do nothing;
 end if;
 if tg_op='UPDATE' and fact is not distinct from jsonb_build_array(old.order_id,old.order_date,old.status,old.table_name,old.closure_receipt_id,old.closure_merged_into_order_id) then return new;end if;
 insert into table_operations_private.auto_invalidations(event_id,reason)
 select e.id,'order_generation_changed' from table_operations_private.payment_observations e
 join table_operations_private.catalog c on c.table_id=e.table_id
 where e.scope=new.scope and e.business_date=new.business_date
  and (lower(btrim(new.table_name))=lower(c.table_name) or exists(select 1 from jsonb_array_elements(e.order_epoch) v where v->>0=new.order_id))
  and not exists(select 1 from jsonb_array_elements(e.order_epoch) previous_fact where previous_fact=fact)
  and not exists(select 1 from table_operations_private.auto_invalidations i where i.event_id=e.id)
 on conflict(event_id) do nothing;
 return new;
end $$;
create trigger tables_auto_order_invalidation after insert or update on pos_open_orders_private.orders
 for each row execute function table_operations_private.auto_invalidate_order_v1();
create function table_operations_private.auto_invalidate_receipt_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare r public.pos_sales_receipts%rowtype; prior_row public.pos_sales_receipts%rowtype;
begin
 if (select enabled from table_operations_private.auto_config where singleton) is distinct from true then
  if tg_op='DELETE' then return old;else return new;end if;
 end if;
 if tg_op='UPDATE' and table_operations_private.receipt_business_v1(to_jsonb(new)) is not distinct from table_operations_private.receipt_business_v1(to_jsonb(old)) then return new;end if;
 if tg_op='DELETE' then r:=old;else r:=new;end if;
 if tg_op='UPDATE' then prior_row:=old;else prior_row:=r;end if;
 insert into table_operations_private.auto_invalidations(event_id,reason)
 select e.id,'receipt_changed' from table_operations_private.payment_observations e join table_operations_private.catalog c on c.table_id=e.table_id
 where (e.receipt_id in(r.id,prior_row.id)
  or (r.source='cukcuk' and e.business_date=r.business_date and split_part(e.scope,':',2)=r.branch_id
   and lower(btrim(r.raw_json->>'TableName'))=lower(c.table_name))
  or (prior_row.source='cukcuk' and e.business_date=prior_row.business_date and split_part(e.scope,':',2)=prior_row.branch_id
   and lower(btrim(prior_row.raw_json->>'TableName'))=lower(c.table_name)))
  and not exists(select 1 from table_operations_private.auto_invalidations i where i.event_id=e.id)
 on conflict(event_id) do nothing;
 if tg_op='DELETE' then return old;else return new;end if;
end $$;
create trigger tables_auto_receipt_invalidation after insert or update or delete on public.pos_sales_receipts
 for each row execute function table_operations_private.auto_invalidate_receipt_v1();
create function table_operations_private.auto_invalidate_line_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare old_id bigint; new_id bigint;
begin
 if (select enabled from table_operations_private.auto_config where singleton) is distinct from true then
  if tg_op='DELETE' then return old;else return new;end if;
 end if;
 if tg_op='UPDATE' and table_operations_private.line_business_v1(to_jsonb(new)) is not distinct from table_operations_private.line_business_v1(to_jsonb(old)) then return new;end if;
 if tg_op<>'INSERT' then old_id:=old.receipt_id;end if;
 if tg_op<>'DELETE' then new_id:=new.receipt_id;end if;
 insert into table_operations_private.auto_invalidations(event_id,reason)
 select e.id,'receipt_menu_changed' from table_operations_private.payment_observations e
 where e.receipt_id in(old_id,new_id) and not exists(select 1 from table_operations_private.auto_invalidations i where i.event_id=e.id)
 on conflict(event_id) do nothing;
 if tg_op='DELETE' then return old;else return new;end if;
end $$;
create trigger tables_auto_line_invalidation after insert or update or delete on public.pos_sales_receipt_lines
 for each row execute function table_operations_private.auto_invalidate_line_v1();


revoke all on function table_operations_private.auto_invalidate_order_v1(),table_operations_private.auto_invalidate_receipt_v1(),table_operations_private.auto_invalidate_line_v1() from public,anon,authenticated,service_role;

revoke all on function table_operations_private.auto_activation_v1(),
 table_operations_private.auto_evidence_v1(text,date,uuid),table_operations_private.auto_context_v1(text,date,uuid),
 table_operations_private.observe_payments_v1(text,date,uuid,jsonb,jsonb,jsonb),
 public.tables_auto_context_v1(text,date,uuid),public.tables_observe_payments_v1(text,date,uuid,jsonb,jsonb,jsonb)
 from public,anon,authenticated,service_role;
grant execute on function table_operations_private.auto_context_v1(text,date,uuid),
 table_operations_private.observe_payments_v1(text,date,uuid,jsonb,jsonb,jsonb),
 public.tables_auto_context_v1(text,date,uuid),public.tables_observe_payments_v1(text,date,uuid,jsonb,jsonb,jsonb) to service_role;
commit;
