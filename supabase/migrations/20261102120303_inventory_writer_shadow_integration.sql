-- P1-2E stage 2. Existing RPC bodies/OIDs/ACLs retained; common lock prelude.
create or replace function inventory_writer_private.enter(p_wait boolean default true) returns void
language plpgsql set search_path=pg_catalog,public as $$
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'INVENTORY_WRITER_REQUIRES_READ_COMMITTED' using errcode='40001';end if;
 -- A previously assigned xid may mean an unregistered outer caller already
 -- owns business/tuple locks. Fail fast instead of introducing an inverse wait.
 if p_wait and pg_current_xact_id_if_assigned() is null then perform pg_advisory_xact_lock(784291,1202);
 elsif not pg_try_advisory_xact_lock(784291,1202) then raise exception 'INVENTORY_WRITER_RETRY_LOCK_ORDER' using errcode='40001';end if;
end $$;
create table inventory_writer_private.definition_changes (
 id bigint generated always as identity primary key,item_id bigint not null references public.inventory(id),
 tx bigint not null default txid_current(),previous_definition jsonb not null,new_definition jsonb not null,
 observed_at timestamptz not null default clock_timestamp()
);
alter table inventory_writer_private.audit_births add column observed_quantity numeric;
create or replace function inventory_writer_private.audit_birth() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 insert into inventory_writer_private.audit_births(log_id,context,observed_quantity) values(new.id,
  coalesce(nullif(current_setting('baba.inventory_writer_context',true),'')::jsonb,'{}'),(select quantity from public.inventory where id=new.item_id));
 return new;
end $$;
create function inventory_writer_private.capture_definition() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a jsonb;b jsonb;
begin
 a:=jsonb_build_array(old.unit,to_jsonb(old)->'package_content_quantity',to_jsonb(old)->'package_content_unit');
 b:=jsonb_build_array(new.unit,to_jsonb(new)->'package_content_quantity',to_jsonb(new)->'package_content_unit');
 if a is distinct from b then insert into inventory_writer_private.definition_changes(item_id,previous_definition,new_definition) values(new.id,a,b);end if;
 return new;
end $$;
create trigger inventory_writer_definition after update on public.inventory for each row execute function inventory_writer_private.capture_definition();
create table inventory_writer_private.rpc_contracts (
 function_oid oid primary key,signature text not null unique,name text not null,
 original_definition text not null,original_body text not null,installed_body text not null,
 installed_at timestamptz not null default clock_timestamp()
);
create table inventory_writer_private.requests (
 id uuid primary key,payload jsonb not null,result jsonb,completed boolean not null default false
);
create table inventory_writer_private.request_attempts (
 id bigint generated always as identity primary key,request_id uuid not null references inventory_writer_private.requests(id),
 result jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table inventory_writer_private.attestations (
 id bigint generated always as identity primary key,event_id uuid not null references inventory_writer_private.events(id),
 actor text not null,effective_at timestamptz not null,evidence jsonb not null,created_at timestamptz not null default clock_timestamp(),
 unique(event_id,effective_at,evidence)
);
create table inventory_writer_private.deliveries (
 id bigint generated always as identity primary key,event_id uuid not null references inventory_writer_private.events(id),
 dependency text not null,result jsonb not null,created_at timestamptz not null default clock_timestamp(),unique(event_id,dependency)
);
-- Keep deferred validation inside the short writer transaction proportional to
-- this transaction's rows, rather than the lifetime size of the audit journal.
create index inventory_writer_birth_tx on inventory_writer_private.audit_births(tx,log_id);
create index inventory_writer_change_tx on inventory_writer_private.changes(tx,item_id);
create index inventory_writer_event_item on inventory_writer_private.events(item_id,ordinal);
create index inventory_writer_pending on inventory_writer_private.outbox(state,event_id) where state<>'delivered';
create index inventory_writer_attestation_event on inventory_writer_private.attestations(event_id,id desc);
create index inventory_writer_definition_tx on inventory_writer_private.definition_changes(tx,item_id);
do $$ declare n text;begin
 foreach n in array array['rpc_contracts','requests','request_attempts','attestations','deliveries','definition_changes'] loop
  execute format('alter table inventory_writer_private.%I enable row level security',n);
  if n<>'requests' then execute format('create trigger immutable before update or delete on inventory_writer_private.%I for each row execute function inventory_writer_private.immutable()',n);end if;
  execute format('create trigger no_truncate before truncate on inventory_writer_private.%I for each statement execute function inventory_writer_private.immutable()',n);
 end loop;
end $$;
create function inventory_writer_private.enter_rpc(p_name text,p_request uuid default null) returns void
language plpgsql set search_path=pg_catalog,public as $$
declare c jsonb;
begin
 perform inventory_writer_private.enter(true);
 c:=coalesce(nullif(current_setting('baba.inventory_writer_context',true),'')::jsonb,'{}');
 if p_request is not null and c->>'requestId' is null then c:=c||jsonb_build_object('requestId',p_request);end if;
 perform set_config('baba.inventory_writer_context',(c||jsonb_build_object('operation',coalesce(c->>'operation',p_name)))::text,true);
end $$;
do $install$
declare p record;v_definition text;v_original_definition text;v_body text;v_prefix text;
begin
 for p in select pr.*,pr.oid::regprocedure::text signature from pg_proc pr join pg_namespace n on n.oid=pr.pronamespace
  where n.nspname='public' and pr.proname=any(array[
    'inventory_update_with_audit_v1','inventory_create_with_receipt_v1','inventory_apply_purchase_correction_v1',
    'inventory_apply_purchase_correction_v2','inventory_apply_purchase_correction_v3','inventory_apply_purchase_receipt_edit_v1',
    'inventory_apply_keg_change','replace_inventory_keg','apply_sales_inventory_deduction_batch',
    'prepare_and_apply_sales_inventory_reprocess','reprocess_modified_sales_inventory_deduction_receipt',
    'rollback_canceled_sales_inventory_deduction_receipt']) order by pr.oid loop
  if (select lanname from pg_language where oid=p.prolang) not in ('plpgsql','sql') or p.proretset or p.prorettype<>'jsonb'::regtype
    or p.proowner<>'postgres'::regrole or not p.prosecdef or not (
      (p.proname='inventory_update_with_audit_v1' and p.pronargs=8)
      or (p.proname='inventory_create_with_receipt_v1' and p.pronargs=4)
      or (p.proname='inventory_apply_purchase_correction_v1' and p.pronargs=6)
      or (p.proname in ('inventory_apply_purchase_correction_v2','inventory_apply_purchase_correction_v3','inventory_apply_purchase_receipt_edit_v1','prepare_and_apply_sales_inventory_reprocess') and p.pronargs=7)
      or (p.proname='inventory_apply_keg_change' and p.pronargs=11)
      or (p.proname='replace_inventory_keg' and p.pronargs in (4,5))
      or (p.proname='apply_sales_inventory_deduction_batch' and p.pronargs=3)
      or (p.proname='reprocess_modified_sales_inventory_deduction_receipt' and p.pronargs=5)
      or (p.proname='rollback_canceled_sales_inventory_deduction_receipt' and p.pronargs=4)) then
    raise exception 'INVENTORY_WRITER_RPC_UNREVIEWED_SHAPE: %',p.signature;end if;
  v_definition:=pg_get_functiondef(p.oid);
  v_original_definition:=v_definition;
  v_prefix:=E'\n  perform inventory_writer_private.enter_rpc('||quote_literal(p.proname)||
    case when 'p_request_id'=any(p.proargnames) then ',p_request_id' else '' end||E'); -- INVENTORY_WRITER_P1_2E\n';
  if p.proname='replace_inventory_keg' then
   v_prefix:=v_prefix||E'  if p_expected_quantity is null and coalesce(nullif(current_setting(''baba.inventory_writer_context'',true),'''')::jsonb->>''requestId'','''')='''' then raise exception ''INVENTORY_WRITER_REQUEST_ID_REQUIRED'' using errcode=''22023'';end if;\n';
  end if;
  v_body:=regexp_replace(p.prosrc,'(^|\n)([ \t]*[Bb][Ee][Gg][Ii][Nn])([ \t\r\n])',E'\\1\\2'||v_prefix||E'\\3');
  if (select lanname from pg_language where oid=p.prolang)='sql' then
   if p.proname<>'replace_inventory_keg' or p.pronargs<>4 or p.prosrc !~* '^[[:space:]]*select public.replace_inventory_keg\(' then
    raise exception 'INVENTORY_WRITER_SQL_WRAPPER_UNREVIEWED';end if;
   v_body:=E'begin'||v_prefix||regexp_replace(p.prosrc,'^[[:space:]]*select[[:space:]]+','return ','i')||E'\nend;\n';
   v_definition:=replace(v_definition,'LANGUAGE sql','LANGUAGE plpgsql');
  end if;
  if v_body=p.prosrc or position('INVENTORY_WRITER_P1_2E' in p.prosrc)>0 then raise exception 'INVENTORY_WRITER_RPC_PRELUDE_MISMATCH: %',p.signature;end if;
  execute replace(v_definition,p.prosrc,v_body);
  insert into inventory_writer_private.rpc_contracts(function_oid,signature,name,original_definition,original_body,installed_body)
    values(p.oid,p.signature,p.proname,v_original_definition,p.prosrc,v_body);
 end loop;
end $install$;

-- After all known RPC entry points are registered, direct service-role quantity
-- DML cannot bypass their request/CAS contract. Metadata-only updates still work.
do $fence$
declare d text;b text;patched text;
begin
 select pg_get_functiondef(p.oid),p.prosrc into d,b from pg_proc p where p.oid='inventory_writer_private.capture_change()'::regprocedure;
 patched:=replace(b,'insert into inventory_writer_private.changes',
  E'if not exists(select 1 from inventory_writer_private.rpc_contracts c join pg_proc fn on fn.oid=c.function_oid where c.name=v_context->>''operation'' and fn.prosrc=c.installed_body) then\n raise exception ''INVENTORY_WRITER_REGISTERED_REQUEST_REQUIRED'' using errcode=''42501'';end if;\n insert into inventory_writer_private.changes');
 if patched=b then raise exception 'INVENTORY_WRITER_CAPTURE_FENCE_MISMATCH';end if;
 execute replace(d,b,patched);
end $fence$;

-- Keg start-time corrections have no quantity log, but can invalidate a prior
-- physical boundary. Keep their existing safety audit as the immutable source.
alter table inventory_writer_private.events alter column log_id drop not null;
create function inventory_writer_private.capture_keg_timing() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid;s jsonb:=to_jsonb(new);v_item bigint:=new.inventory_item_id;
begin
 if new.action<>'edit-start' then return new;end if;
 insert into inventory_writer_private.events(item_id,kind,quantity,observed_at,origin,source_snapshot,source_hash,request_id,idempotency_key,proof,blocking_reason)
 values(v_item,'keg_timing',0,clock_timestamp(),jsonb_build_object('kegRequestId',new.request_id,'operation','inventory_apply_keg_change'),s,
  encode(sha256(convert_to(s::text,'UTF8')),'hex'),new.request_id,'keg-timing:'||new.request_id,'{}','keg_timing_revision_requires_reconciliation') returning id into v_id;
 insert into inventory_writer_private.outbox(event_id) values(v_id);return new;
end $$;
create function inventory_writer_private.guard_keg_times() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c jsonb;
begin
 if tg_op='UPDATE' and new.started_at is not distinct from old.started_at and new.ended_at is not distinct from old.ended_at
  and new.status is not distinct from old.status and new.inventory_item_id is not distinct from old.inventory_item_id then return new;end if;
 c:=coalesce(nullif(current_setting('baba.inventory_writer_context',true),'')::jsonb,'{}');
 if tg_op='DELETE' or not exists(select 1 from inventory_writer_private.rpc_contracts r join pg_proc p on p.oid=r.function_oid
  where r.name in ('inventory_apply_keg_change','replace_inventory_keg') and r.name=c->>'operation' and p.prosrc=r.installed_body) then
  raise exception 'INVENTORY_KEG_TIMING_WRITER_REQUIRED' using errcode='42501';end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
do $$ begin
 if to_regclass('public.inventory_keg_safety_audit') is not null then
  create trigger inventory_writer_keg_timing after insert on public.inventory_keg_safety_audit for each row execute function inventory_writer_private.capture_keg_timing();
  create trigger inventory_writer_keg_audit_immutable before update or delete on public.inventory_keg_safety_audit for each row execute function inventory_writer_private.immutable();
 end if;
 if to_regclass('public.inventory_keg_sessions') is not null then
  create trigger inventory_writer_keg_times before insert or update or delete on public.inventory_keg_sessions for each row execute function inventory_writer_private.guard_keg_times();
 end if;
end $$;

create function public.inventory_writer_apply_v1(p_request_id uuid,p_operation text,p_arguments jsonb,p_event jsonb,p_actor_user_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor public.users%rowtype;p record;v_count integer;v_args jsonb:=p_arguments;v_intent jsonb;
 v_call text;v_result jsonb;v_old inventory_writer_private.requests%rowtype;v_previous text;v_effect boolean;
begin
 select * into actor from public.users where id=p_actor_user_id and is_active and app_login_enabled;
 if not found then raise exception 'INVENTORY_WRITER_FORBIDDEN' using errcode='42501';end if;
 if p_request_id is null or jsonb_typeof(p_arguments) is distinct from 'object' or jsonb_typeof(p_event) is distinct from 'object' then
  raise exception 'INVENTORY_WRITER_INVALID_REQUEST' using errcode='22023';end if;
 perform inventory_writer_private.enter(true);
 select count(*) into v_count from inventory_writer_private.rpc_contracts c join pg_proc pr on pr.oid=c.function_oid
 where c.name=p_operation and not exists(select 1 from jsonb_object_keys(p_arguments) k where not(k=any(pr.proargnames)))
   and not exists(select 1 from unnest(pr.proargnames) with ordinality a(name,num) where num<=pr.pronargs-pr.pronargdefaults and not(p_arguments ? name));
 if v_count<>1 then raise exception 'INVENTORY_WRITER_OPERATION_NOT_REGISTERED' using errcode='22023';end if;
 select pr.*,c.installed_body into p from inventory_writer_private.rpc_contracts c join pg_proc pr on pr.oid=c.function_oid
 where c.name=p_operation and not exists(select 1 from jsonb_object_keys(p_arguments) k where not(k=any(pr.proargnames)))
   and not exists(select 1 from unnest(pr.proargnames) with ordinality a(name,num) where num<=pr.pronargs-pr.pronargdefaults and not(p_arguments ? name));
 if p.prosrc<>p.installed_body then raise exception 'INVENTORY_WRITER_RPC_DRIFT' using errcode='55000';end if;
 if 'p_actor_user_id'=any(p.proargnames) then v_args:=v_args||jsonb_build_object('p_actor_user_id',actor.id);end if;
 if 'p_actor_username'=any(p.proargnames) then v_args:=v_args||jsonb_build_object('p_actor_username',actor.username);end if;
 v_intent:=jsonb_build_object('operation',p_operation,'arguments',v_args#-'{p_payload,updated_at}',
  'event',p_event,'actor',actor.id);
 select * into v_old from inventory_writer_private.requests where id=p_request_id for update;
 if found then
  if v_old.payload is distinct from v_intent then raise exception 'INVENTORY_WRITER_IDEMPOTENCY_CONFLICT' using errcode='22023';end if;
  if v_old.completed then return v_old.result;end if;
 else insert into inventory_writer_private.requests(id,payload) values(p_request_id,v_intent);end if;
 -- Any multi-item set requested through the common interface locks ascending.
 -- Existing POS RPCs retain their own sorted candidate-item locking.
 if v_args ? 'p_item_id' then perform id from public.inventory where id=(v_args->>'p_item_id')::bigint order by id for update;end if;
 v_previous:=current_setting('baba.inventory_writer_context',true);
 perform set_config('baba.inventory_writer_context',jsonb_build_object('operation',p_operation,'requestId',p_request_id,
   'actorId',actor.id,'event',p_event||jsonb_build_object('coverageComplete',false,'sourceComplete',false))::text,true);
 select string_agg(format('%I => %s',p.proargnames[n],case when p.proargtypes[n-1]='jsonb'::regtype
    then format('($1 -> %L)',p.proargnames[n]) else format('($1 ->> %L)::%s',p.proargnames[n],format_type(p.proargtypes[n-1],null)) end),',' order by n)
  into v_call from generate_series(1,p.pronargs) n where v_args ? p.proargnames[n];
 execute format('select public.%I(%s)',p_operation,v_call) into v_result using v_args;
 select exists(select 1 from inventory_writer_private.audit_births where context->>'requestId'=p_request_id::text)
   or exists(select 1 from inventory_writer_private.changes where request_id=p_request_id) into v_effect;
 insert into inventory_writer_private.request_attempts(request_id,result) values(p_request_id,v_result);
 -- Failed/shortage attempts remain retryable; old engines keep their own
 -- dependency-aware retry rules. Only an actual effect or successful result is cached.
  update inventory_writer_private.requests set result=v_result,completed=v_effect or coalesce(v_result->>'status','')='ok'
   or coalesce(v_result->>'result','') in ('applied','already_applied','completed') where id=p_request_id;
 perform set_config('baba.inventory_writer_context',coalesce(v_previous,''),true);
 return v_result;
end $$;

create function public.inventory_writer_attest(p_event uuid,p_expected_hash text,p_effective_at text,p_evidence jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare e inventory_writer_private.events%rowtype;
begin
 perform pos_inventory_shadow.authorize(p_actor);perform inventory_writer_private.enter(true);
 select * into e from inventory_writer_private.events where id=p_event;
 if not found then raise exception 'INVENTORY_WRITER_EVENT_MISSING';end if;
 perform id from public.inventory where id=e.item_id for update;
 if e.kind='keg_timing' then return jsonb_build_object('status','held','reason','keg_timing_revision_requires_reconciliation');end if;
 if p_expected_hash is distinct from e.source_hash or e.source_hash is distinct from encode(sha256(convert_to(pos_inventory_shadow.writer_log_snapshot(e.log_id)::text,'UTF8')),'hex') then
  raise exception 'INVENTORY_WRITER_SOURCE_CHANGED' using errcode='40001';end if;
 if not pos_inventory_shadow.valid_time(p_effective_at) or (p_effective_at)::timestamptz>clock_timestamp()
  or nullif(p_evidence->>'proof','') is null then raise exception 'INVENTORY_WRITER_PHYSICAL_PROOF_REQUIRED' using errcode='22023';end if;
 if e.kind='sale_posting' then return jsonb_build_object('status','held','reason','pos_source_completeness_unverified');end if;
 insert into inventory_writer_private.attestations(event_id,actor,effective_at,evidence)
 values(e.id,p_actor,p_effective_at::timestamptz,p_evidence||jsonb_build_object('coverageComplete',false,'sourceComplete',false)) on conflict do nothing;
 if exists(select 1 from pos_inventory_shadow.movements where log_id=e.log_id and effective_at<>p_effective_at::timestamptz) then
  update inventory_writer_private.outbox set state='held',last_dependency=null,last_result=jsonb_build_object('reason','registered_movement_time_revision_requires_reconciliation') where event_id=e.id;
  return jsonb_build_object('status','held','reason','registered_movement_time_revision_requires_reconciliation');
 end if;
 return jsonb_build_object('status','attested','eventId',e.id);
end $$;

create function public.inventory_writer_shadow_drain(p_limit integer,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare job record;e inventory_writer_private.events%rowtype;a inventory_writer_private.attestations%rowtype;
 v_dependency text;v_result jsonb;v_time timestamptz;v_evidence jsonb;v_kind text;v_results jsonb:='[]';v_reason text;v_source jsonb;
begin
 perform pos_inventory_shadow.authorize(p_actor);perform inventory_writer_private.enter(true);
 if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'INVENTORY_WRITER_LIMIT_INVALID';end if;
 for job in select o.* from inventory_writer_private.outbox o join inventory_writer_private.events ev on ev.id=o.event_id
  where o.state<>'delivered' and o.last_dependency is distinct from coalesce((select max(id)::text from inventory_writer_private.attestations where event_id=o.event_id),'0')
  order by ev.item_id,ev.ordinal limit p_limit for update of o skip locked loop
  select * into e from inventory_writer_private.events where id=job.event_id;
  select * into a from inventory_writer_private.attestations where event_id=e.id order by id desc limit 1;
  v_dependency:=coalesce(a.id::text,'0');v_time:=coalesce(a.effective_at,e.effective_at);v_evidence:=coalesce(a.evidence,e.proof);
  perform id from public.inventory where id=e.item_id for update;
  v_reason:=null;v_result:=null;
  if e.kind='keg_timing' then v_reason:='keg_timing_revision_requires_reconciliation';
  elsif e.source_hash is distinct from encode(sha256(convert_to(pos_inventory_shadow.writer_log_snapshot(e.log_id)::text,'UTF8')),'hex') then v_reason:='source_audit_changed';
  elsif exists(select 1 from inventory_writer_private.links k join inventory_writer_private.changes c on c.id=k.change_id
    join inventory_writer_private.definition_changes d on d.item_id=c.item_id and d.tx=c.tx where k.event_id=e.id) then v_reason:='unit_or_package_contract_changed';
  elsif e.kind='sale_posting' then
   -- Reuse P1-2D, never convert POS posting logs to physical movements.
   v_source:=null;
   if to_regprocedure('public.pos_ingest_shadow_evidence(bigint)') is not null then
    execute 'select public.pos_ingest_shadow_evidence($1)' into v_source using (e.origin->>'receiptId')::bigint;
   end if;
   v_reason:=coalesce(v_source->>'blockingReason','pos_source_completeness_unverified');
  elsif e.kind='metadata' or (e.kind not in ('count','sale_posting','keg_timing') and e.quantity=0) then
   v_result:=jsonb_build_object('result','excluded','reason','no_quantity_movement');
  elsif v_time is null then v_reason:=coalesce(e.blocking_reason,'physical_effective_at_unproven');
  elsif exists(select 1 from pos_inventory_shadow.movements where log_id=e.log_id and effective_at<>v_time) then v_reason:='registered_movement_time_revision_requires_reconciliation';
  elsif not exists(select 1 from inventory_writer_private.links where event_id=e.id)
    and ((e.kind='count' and e.new_quantity is distinct from (select observed_quantity from inventory_writer_private.audit_births where log_id=e.log_id))
      or (e.kind<>'count' and coalesce(e.quantity,0)<>0)) then v_reason:='audit_quantity_projection_unpaired';
  else
   v_kind:=case when e.kind in ('purchase','purchase_correction') then 'purchase' when e.kind='keg_replace' then 'adjustment' else e.kind end;
   v_result:=public.pos_shadow_register_writer_movement(e.log_id,e.source_hash,to_char(v_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),v_kind,
     v_evidence||jsonb_build_object('coverageComplete',false,'writerEventId',e.id),p_actor);
  end if;
  if v_reason is not null then v_result:=jsonb_build_object('result','held','reason',v_reason,'sourceComplete',false,
    'retryCondition',case when v_reason in ('physical_effective_at_unproven','physical_time_in_future','physical_return_evidence_invalid') then 'new_physical_time_evidence'
      when e.kind='sale_posting' then 'verified_source_contract_release'
      when v_reason='unit_or_package_contract_changed' then 'verified_unit_epoch_reconciliation'
      when v_reason like '%tim%revision%' then 'versioned_movement_timing_reconciliation'
      else 'source_audit_investigation' end);end if;
  v_result:=v_result||jsonb_build_object('eventId',e.id,'effectiveAt',v_time,'boundaryLogId',
    (select m.log_id from pos_inventory_shadow.movements m where m.item_id=e.item_id and m.kind='count' order by m.effective_at desc,m.log_id desc limit 1));
  insert into inventory_writer_private.deliveries(event_id,dependency,result) values(e.id,v_dependency,v_result) on conflict do nothing;
  update inventory_writer_private.outbox set state=case when v_result->>'result' in ('recorded','duplicate','excluded') then 'delivered' else 'held' end,
    last_dependency=v_dependency,last_result=v_result where event_id=e.id;
  v_results:=v_results||jsonb_build_array(jsonb_build_object('eventId',e.id,'result',v_result));
 end loop;
 return jsonb_build_object('results',v_results,'automaticConfirmation',false,'operatingInventoryWritten',false);
end $$;

create function public.inventory_writer_compare(p_item bigint,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_book jsonb;v_pending jsonb;v_count integer;
begin
 perform pos_inventory_shadow.authorize(p_actor);perform inventory_writer_private.enter(true);
 perform id from public.inventory where id=p_item for update;
 v_book:=public.pos_shadow_compare_item(p_item,p_actor);
 select coalesce(jsonb_agg(jsonb_build_object('eventId',e.id,'kind',e.kind,'reason',coalesce(o.last_result->>'reason',e.blocking_reason,'shadow_delivery_pending')) order by e.ordinal),'[]'),count(*)
 into v_pending,v_count from inventory_writer_private.events e join inventory_writer_private.outbox o on o.event_id=e.id
 where e.item_id=p_item and o.state<>'delivered';
 return jsonb_build_object('itemId',p_item,'comparison',v_book,'pendingEvents',v_pending,'pendingCount',v_count,
   'sourceComplete',false,'automaticConfirmation',false,'replacementAllowed',false,'operatingInventoryWritten',false);
end $$;

create function public.inventory_writer_inspect(p_actor text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform pos_inventory_shadow.authorize(p_actor);
 return jsonb_build_object('writers',(select coalesce(jsonb_agg(jsonb_build_object('signature',c.signature,'drift',p.prosrc is distinct from c.installed_body) order by c.signature),'[]')
  from inventory_writer_private.rpc_contracts c left join pg_proc p on p.oid=c.function_oid),
 'events',(select coalesce(jsonb_agg(jsonb_build_object('eventId',e.id,'itemId',e.item_id,'logId',e.log_id,'kind',e.kind,'effectiveAt',e.effective_at,
   'observedAt',e.observed_at,'sourceHash',e.source_hash,'state',o.state,'result',o.last_result) order by e.ordinal),'[]')
   from inventory_writer_private.events e join inventory_writer_private.outbox o on o.event_id=e.id),
 'missingExpectedWriters',(select coalesce(jsonb_agg(w.name order by w.name),'[]') from unnest(array[
    'inventory_update_with_audit_v1','inventory_create_with_receipt_v1','inventory_apply_purchase_correction_v1',
    'inventory_apply_purchase_correction_v2','inventory_apply_purchase_correction_v3','inventory_apply_purchase_receipt_edit_v1',
    'inventory_apply_keg_change','replace_inventory_keg','apply_sales_inventory_deduction_batch',
    'prepare_and_apply_sales_inventory_reprocess','reprocess_modified_sales_inventory_deduction_receipt','rollback_canceled_sales_inventory_deduction_receipt'
 ]) w(name) where not exists(select 1 from inventory_writer_private.rpc_contracts c where c.name=w.name)),
 'directQuantityDmlFenced',true,'sourceComplete',false,'replacementAllowed',false);
end $$;
revoke all on all tables in schema inventory_writer_private from public,anon,authenticated,service_role;
revoke all on all sequences in schema inventory_writer_private from public,anon,authenticated,service_role;
revoke all on all functions in schema inventory_writer_private from public,anon,authenticated,service_role;
revoke all on function public.inventory_writer_apply_v1(uuid,text,jsonb,jsonb,bigint),public.inventory_writer_attest(uuid,text,text,jsonb,text),
 public.inventory_writer_shadow_drain(integer,text),public.inventory_writer_compare(bigint,text),public.inventory_writer_inspect(text) from public,anon,authenticated,service_role;
grant execute on function public.inventory_writer_apply_v1(uuid,text,jsonb,jsonb,bigint),public.inventory_writer_attest(uuid,text,text,jsonb,text),
 public.inventory_writer_shadow_drain(integer,text),public.inventory_writer_compare(bigint,text),public.inventory_writer_inspect(text) to service_role;
