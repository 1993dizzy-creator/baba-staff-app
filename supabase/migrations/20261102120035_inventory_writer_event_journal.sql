-- P1-2E stage 1. Additive journal; no backfill, quantity rewrite or P0 change.
create schema inventory_writer_private;
revoke all on schema inventory_writer_private from public,anon,authenticated,service_role;
create table inventory_writer_private.changes (
 id uuid primary key default gen_random_uuid(), tx bigint not null default txid_current(),
 item_id bigint not null references public.inventory(id), operation text not null,
 previous_quantity numeric not null,new_quantity numeric not null,
 previous_unit text,new_unit text,observed_at timestamptz not null default clock_timestamp(),
 request_id uuid, unique(id,item_id)
);
create table inventory_writer_private.audit_births (
 log_id bigint primary key references public.inventory_logs(id),tx bigint not null default txid_current(),
 context jsonb not null,observed_at timestamptz not null default clock_timestamp()
);
create table inventory_writer_private.events (
 id uuid primary key default gen_random_uuid(),ordinal bigint generated always as identity unique,
 item_id bigint not null references public.inventory(id),log_id bigint not null unique references public.inventory_logs(id),
 kind text not null,quantity numeric,previous_quantity numeric,new_quantity numeric,unit text,
 effective_at timestamptz,observed_at timestamptz not null,recorded_at timestamptz not null default clock_timestamp(),
 origin jsonb not null,source_snapshot jsonb not null,source_hash text not null,
 request_id uuid,idempotency_key text not null unique,proof jsonb not null,
 boundary_log_id bigint references public.inventory_logs(id),blocking_reason text
);
create table inventory_writer_private.links (
 change_id uuid primary key references inventory_writer_private.changes(id),
 event_id uuid not null unique references inventory_writer_private.events(id)
);
create table inventory_writer_private.outbox (
 event_id uuid primary key references inventory_writer_private.events(id),
 state text not null default 'queued',last_dependency text,last_result jsonb
);
create function inventory_writer_private.immutable() returns trigger language plpgsql as $$
begin raise exception 'INVENTORY_WRITER_AUDIT_IMMUTABLE' using errcode='55000';end $$;
do $$ declare n text;begin
 foreach n in array array['changes','audit_births','events','links','outbox'] loop
  execute format('alter table inventory_writer_private.%I enable row level security',n);
  if n<>'outbox' then execute format('create trigger immutable before update or delete on inventory_writer_private.%I for each row execute function inventory_writer_private.immutable()',n);end if;
  execute format('create trigger no_truncate before truncate on inventory_writer_private.%I for each statement execute function inventory_writer_private.immutable()',n);
 end loop;
end $$;

-- Known RPCs acquire this before business locks (stage 2). A direct DML caller
-- with an unknown prior lock order must retry rather than wait in a lock cycle.
create function inventory_writer_private.enter(p_wait boolean default true) returns void
language plpgsql set search_path=pg_catalog,public as $$
begin
 if current_setting('transaction_isolation')<>'read committed' then
  raise exception 'INVENTORY_WRITER_REQUIRES_READ_COMMITTED' using errcode='40001';end if;
 if p_wait then perform pg_advisory_xact_lock(784291,1202);
 elsif not pg_try_advisory_xact_lock(784291,1202) then
  raise exception 'INVENTORY_WRITER_RETRY_LOCK_ORDER' using errcode='40001';end if;
end $$;
create function inventory_writer_private.statement_gate() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin perform inventory_writer_private.enter(false);return null;end $$;
create trigger inventory_writer_quantity_gate before insert or update of quantity,unit,package_content_quantity,package_content_unit on public.inventory
for each statement execute function inventory_writer_private.statement_gate();
create trigger inventory_writer_log_gate before insert or update or delete on public.inventory_logs
for each statement execute function inventory_writer_private.statement_gate();

create function inventory_writer_private.capture_change() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_old numeric:=0;v_old_unit text;v_context jsonb;
begin
 if tg_op='UPDATE' then
  if new.quantity is not distinct from old.quantity and new.unit is not distinct from old.unit
   and to_jsonb(new)->'package_content_quantity' is not distinct from to_jsonb(old)->'package_content_quantity'
   and to_jsonb(new)->'package_content_unit' is not distinct from to_jsonb(old)->'package_content_unit' then return new;end if;
  v_old:=old.quantity;v_old_unit:=old.unit;
 end if;
 if new.quantity is null or new.quantity<0 or new.quantity::text in ('NaN','Infinity','-Infinity') then
  raise exception 'INVENTORY_PHYSICAL_QUANTITY_INVALID' using errcode='22023';end if;
 v_context:=coalesce(nullif(current_setting('baba.inventory_writer_context',true),'')::jsonb,'{}');
 insert into inventory_writer_private.changes(item_id,operation,previous_quantity,new_quantity,previous_unit,new_unit,request_id)
 values(new.id,tg_op,coalesce(v_old,0),new.quantity,v_old_unit,new.unit,(v_context->>'requestId')::uuid);
 return new;
end $$;
create trigger inventory_writer_capture_change after insert or update on public.inventory
for each row execute function inventory_writer_private.capture_change();

create function inventory_writer_private.audit_birth() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 insert into inventory_writer_private.audit_births(log_id,context) values(new.id,
  coalesce(nullif(current_setting('baba.inventory_writer_context',true),'')::jsonb,'{}'));
 return new;
end $$;
create trigger inventory_writer_audit_birth after insert on public.inventory_logs for each row execute function inventory_writer_private.audit_birth();
create function inventory_writer_private.guard_audit() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 -- Existing correction RPCs finish a newly inserted correction log in the same
 -- transaction. Once committed, use append-only correction instead of rewrite.
 if tg_op='UPDATE' and exists(select 1 from inventory_writer_private.audit_births where log_id=old.id and tx=txid_current())
   and not exists(select 1 from inventory_writer_private.events where log_id=old.id) then return new;end if;
 raise exception 'INVENTORY_SOURCE_AUDIT_IMMUTABLE' using errcode='55000';
end $$;
create trigger inventory_writer_audit_guard before update or delete on public.inventory_logs for each row execute function inventory_writer_private.guard_audit();
create trigger inventory_writer_audit_no_truncate before truncate on public.inventory_logs for each statement execute function inventory_writer_private.immutable();
create trigger inventory_writer_no_hard_delete before delete on public.inventory for each row execute function inventory_writer_private.immutable();
create trigger inventory_writer_no_truncate before truncate on public.inventory for each statement execute function inventory_writer_private.immutable();

create function inventory_writer_private.finalize_log(p_log bigint) returns uuid
language plpgsql set search_path=pg_catalog,public set timezone='UTC' as $$
declare l public.inventory_logs%rowtype;b inventory_writer_private.audit_births%rowtype;
 c jsonb;s jsonb;v_id uuid;v_kind text;v_reason text;v_at timestamptz;v_proof jsonb;v_boundary bigint;
begin
 select id into v_id from inventory_writer_private.events where log_id=p_log;if found then return v_id;end if;
 select * into b from inventory_writer_private.audit_births where log_id=p_log;
 select * into strict l from public.inventory_logs where id=p_log;
 s:=pos_inventory_shadow.writer_log_snapshot(p_log);
 v_kind:=case when l.source='pos_sales' then 'sale_posting' when l.reason='stock_check' then 'count'
  when l.reason='purchase' and to_jsonb(l)->>'correction_of_inventory_log_id' is not null then 'purchase_correction'
  when l.reason='purchase' then 'purchase' when l.source='keg_replace' then 'keg_replace'
  when coalesce(l.change_quantity,0)=0 then 'metadata' else 'adjustment' end;
 c:=b.context;v_proof:=coalesce(c->'event','{}');
 if v_kind='sale_posting' then v_reason:='pos_source_completeness_unverified';
 elsif v_kind='metadata' then v_reason:='no_quantity_movement';
 elsif pos_inventory_shadow.valid_time(v_proof->>'effectiveAt') and nullif(v_proof->>'proof','') is not null then
  v_at:=(v_proof->>'effectiveAt')::timestamptz;
  if v_at>clock_timestamp() then v_at:=null;v_reason:='physical_time_in_future';end if;
 else v_reason:='physical_effective_at_unproven';end if;
 if v_proof->>'kind'='physical_return' then
  if v_kind='adjustment' and l.change_quantity>0 and nullif(v_proof->>'physicalEventRef','') is not null then v_kind:='physical_return';
  else v_at:=null;v_reason:='physical_return_evidence_invalid';end if;
 end if;
 select m.log_id into v_boundary from pos_inventory_shadow.movements m where m.item_id=l.item_id and m.kind='count'
  and v_at is not null and m.effective_at<=v_at order by m.effective_at desc,m.log_id desc limit 1;
 insert into inventory_writer_private.events(item_id,log_id,kind,quantity,previous_quantity,new_quantity,unit,effective_at,observed_at,
  origin,source_snapshot,source_hash,request_id,idempotency_key,proof,boundary_log_id,blocking_reason)
 values(l.item_id,l.id,v_kind,case when v_kind='count' then l.new_quantity else l.change_quantity end,l.prev_quantity,l.new_quantity,
  coalesce(to_jsonb(l)->>'unit',(select unit from public.inventory where id=l.item_id)),v_at,b.observed_at,
  jsonb_build_object('source',l.source,'receiptId',to_jsonb(l)->'related_receipt_id','deductionId',to_jsonb(l)->'related_deduction_id',
   'rootLogId',to_jsonb(l)->'correction_of_inventory_log_id','operation',c->>'operation'),s,
  encode(sha256(convert_to(s::text,'UTF8')),'hex'),(c->>'requestId')::uuid,'inventory-log:'||l.id,v_proof,v_boundary,v_reason)
 returning id into v_id;
 insert into inventory_writer_private.outbox(event_id) values(v_id);
 return v_id;
end $$;
create function inventory_writer_private.finalize_audit() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin perform inventory_writer_private.finalize_log(new.id);return null;end $$;
create constraint trigger inventory_writer_finalize_audit after insert or update on public.inventory_logs
deferrable initially deferred for each row execute function inventory_writer_private.finalize_audit();

create function inventory_writer_private.require_audit() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_log bigint;v_event uuid;
begin
 select l.id into v_log from inventory_writer_private.audit_births b join public.inventory_logs l on l.id=b.log_id
  where b.tx=new.tx and l.item_id=new.item_id
    and coalesce(l.prev_quantity,0)=new.previous_quantity and l.new_quantity=new.new_quantity
    and not exists(select 1 from inventory_writer_private.links k join inventory_writer_private.events e on e.id=k.event_id where e.log_id=l.id)
  order by l.id limit 1;
 if v_log is null then raise exception 'INVENTORY_QUANTITY_AUDIT_REQUIRED' using errcode='23514';end if;
 v_event:=inventory_writer_private.finalize_log(v_log);
 insert into inventory_writer_private.links(change_id,event_id) values(new.id,v_event);
 return null;
end $$;
create constraint trigger inventory_writer_require_audit after insert on inventory_writer_private.changes
deferrable initially deferred for each row execute function inventory_writer_private.require_audit();

revoke all on all tables in schema inventory_writer_private from public,anon,authenticated,service_role;
revoke all on all sequences in schema inventory_writer_private from public,anon,authenticated,service_role;
revoke all on all functions in schema inventory_writer_private from public,anon,authenticated,service_role;
