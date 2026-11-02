-- P1-2F. Append-only Shadow interpretation; no stock/history backfill or P0 removal.
create schema pos_signed_private;
revoke all on schema pos_signed_private from public,anon,authenticated,service_role;
create table pos_signed_private.epochs (
 id bigint generated always as identity primary key,item_id bigint not null references public.inventory(id),
 starts_at timestamptz not null,base_unit text not null check(base_unit in ('ml','g','each')),
 factors jsonb not null,proof text not null,actor text not null,request_id uuid not null unique,
 created_at timestamptz not null default clock_timestamp(),unique(item_id,starts_at)
);
create table pos_signed_private.event_revisions (
 id bigint generated always as identity primary key,event_id uuid not null references inventory_writer_private.events(id),
 prior_id bigint references pos_signed_private.event_revisions(id),epoch_id bigint not null references pos_signed_private.epochs(id),
 effective_at timestamptz not null,source_unit text not null,base_quantity numeric not null,
 proof text not null,actor text not null,request_id uuid not null unique,
 timing_event uuid references inventory_writer_private.events(id),created_at timestamptz not null default clock_timestamp()
);
create index on pos_signed_private.event_revisions(event_id,id desc);
create table pos_signed_private.receipts (
 receipt_id bigint primary key references public.pos_sales_receipts(id),adoption_key uuid unique not null,
 baseline jsonb not null,legacy_snapshot jsonb not null,proof text not null,actor text not null,
 created_at timestamptz not null default clock_timestamp()
);
create table pos_signed_private.sale_versions (
 id bigint generated always as identity primary key,receipt_id bigint not null references pos_signed_private.receipts(receipt_id),
 parent_id bigint references pos_signed_private.sale_versions(id),request_id uuid not null unique,
 kind text not null check(kind in ('sale','correction','cancel')),targets jsonb not null,
 source_snapshot jsonb not null,proof text not null,actor text not null,
 source_complete boolean not null default false check(not source_complete),
 created_at timestamptz not null default clock_timestamp()
);
create index on pos_signed_private.sale_versions(receipt_id,id desc);
create table pos_signed_private.route_requests (
 id bigint generated always as identity primary key,receipt_id bigint not null references pos_signed_private.receipts(receipt_id),
 operation text not null,request_key text not null unique,snapshot jsonb not null,result jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create table pos_signed_private.projections (
 id bigint generated always as identity primary key,item_id bigint not null references public.inventory(id),
 dependency text not null,result jsonb not null,created_at timestamptz not null default clock_timestamp(),unique(item_id,dependency)
);
-- E contracts remain immutable evidence. F records an explicit successor body.
create table pos_signed_private.rpc_successors(function_oid oid primary key,prior_body text not null,installed_body text not null);
create function pos_signed_private.current_rpc_body(p_oid oid) returns text language sql stable set search_path=pg_catalog as $$
 select coalesce((select installed_body from pos_signed_private.rpc_successors where function_oid=p_oid),
 (select installed_body from inventory_writer_private.rpc_contracts where function_oid=p_oid))
$$;
do $$ declare n text;begin
 foreach n in array array['epochs','event_revisions','receipts','sale_versions','route_requests','projections','rpc_successors'] loop
  execute format('alter table pos_signed_private.%I enable row level security',n);
  execute format('create trigger immutable before update or delete on pos_signed_private.%I for each row execute function inventory_writer_private.immutable()',n);
  execute format('create trigger no_truncate before truncate on pos_signed_private.%I for each statement execute function inventory_writer_private.immutable()',n);
 end loop;
end $$;
create function pos_signed_private.authorize(p_actor text) returns void
language plpgsql stable set search_path=pg_catalog,public as $$
begin
 if not exists(select 1 from public.users where username=p_actor and role in ('owner','master') and is_active and app_login_enabled) then
  raise exception 'SIGNED_PROJECTION_FORBIDDEN' using errcode='42501';end if;
end $$;
create function pos_signed_private.convert(p_epoch bigint,p_unit text,p_quantity numeric,p_at timestamptz) returns numeric
language plpgsql stable set search_path=pg_catalog,public as $$
declare e pos_signed_private.epochs%rowtype;f jsonb;n numeric;d numeric;q numeric;
begin
 select * into strict e from pos_signed_private.epochs where id=p_epoch;
 if p_at<e.starts_at or exists(select 1 from pos_signed_private.epochs later where later.item_id=e.item_id and later.starts_at>e.starts_at and later.starts_at<=p_at) then
  raise exception 'SIGNED_UNIT_EPOCH_TIME_MISMATCH' using errcode='22023';end if;
 f:=e.factors->lower(btrim(p_unit));n:=(f->>'numerator')::numeric;d:=(f->>'denominator')::numeric;
 if n is null or d is null or n<=0 or d<=0 or p_quantity is null or p_quantity::text in ('NaN','Infinity','-Infinity') then
  raise exception 'SIGNED_UNIT_CONVERSION_UNPROVEN' using errcode='22023';end if;
 q:=p_quantity*n/d;
 if q*d<>p_quantity*n or q<>round(q,12) then raise exception 'SIGNED_UNIT_PRECISION_UNSUPPORTED' using errcode='22023';end if;
 return q;
end $$;
create function public.pos_signed_define_epoch(p_item bigint,p_from text,p_base text,p_factors jsonb,p_expected bigint,p_proof text,p_request uuid,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare e pos_signed_private.epochs%rowtype;last_e pos_signed_private.epochs%rowtype;v_id bigint;
begin
 perform pos_signed_private.authorize(p_actor);perform inventory_writer_private.enter(true);
 perform id from public.inventory where id=p_item for update;if not found then raise exception 'SIGNED_ITEM_MISSING';end if;
 if not pos_inventory_shadow.valid_time(p_from) or p_from::timestamptz>clock_timestamp() or length(btrim(coalesce(p_proof,'')))<10 or p_request is null
  or p_base not in ('ml','g','each') or jsonb_typeof(p_factors) is distinct from 'object' then raise exception 'SIGNED_UNIT_EVIDENCE_REQUIRED' using errcode='22023';end if;
 select * into e from pos_signed_private.epochs where request_id=p_request;
 if found then
  if e.item_id<>p_item or e.starts_at<>p_from::timestamptz or e.base_unit<>p_base or e.factors<>p_factors or e.proof<>p_proof then raise exception 'SIGNED_IDEMPOTENCY_CONFLICT';end if;
  return jsonb_build_object('epochId',e.id,'baseUnit',e.base_unit);
 end if;
 select * into last_e from pos_signed_private.epochs where item_id=p_item order by starts_at desc limit 1;
 if last_e.id is distinct from p_expected then raise exception 'SIGNED_EPOCH_CONFLICT' using errcode='40001';end if;
 if last_e.id is not null and (last_e.base_unit<>p_base or last_e.starts_at>=p_from::timestamptz) then raise exception 'SIGNED_EPOCH_DIMENSION_OR_ORDER_INVALID' using errcode='22023';end if;
 if exists(select 1 from pos_signed_private.event_revisions r join inventory_writer_private.events ev on ev.id=r.event_id where ev.item_id=p_item and r.effective_at>=p_from::timestamptz)
 or exists(select 1 from pos_signed_private.receipts a cross join lateral jsonb_array_elements(a.baseline) t where (t->>'itemId')::bigint=p_item and (t->>'effectiveAt')::timestamptz>=p_from::timestamptz)
 or exists(select 1 from pos_signed_private.sale_versions s cross join lateral jsonb_array_elements(s.targets) t where (t->>'itemId')::bigint=p_item and (t->>'effectiveAt')::timestamptz>=p_from::timestamptz)
 then raise exception 'SIGNED_EPOCH_WOULD_REINTERPRET_HISTORY' using errcode='22023';end if;
 if exists(select 1 from jsonb_each(p_factors) f where f.key<>lower(btrim(f.key)) or jsonb_typeof(f.value)<>'object'
   or coalesce(f.value->>'numerator','') !~ '^[0-9]+$' or coalesce(f.value->>'denominator','') !~ '^[0-9]+$'
   or (f.value->>'numerator')::numeric<=0 or (f.value->>'denominator')::numeric<=0)
  or p_factors->p_base is distinct from '{"numerator":1,"denominator":1}'::jsonb then raise exception 'SIGNED_UNIT_RATIOS_INVALID' using errcode='22023';end if;
 insert into pos_signed_private.epochs(item_id,starts_at,base_unit,factors,proof,actor,request_id)
 values(p_item,p_from::timestamptz,p_base,p_factors,p_proof,p_actor,p_request) returning id into v_id;
 return jsonb_build_object('epochId',v_id,'baseUnit',p_base);
end $$;

create function public.pos_signed_revise_event(p_event uuid,p_epoch bigint,p_unit text,p_at text,p_expected bigint,p_proof text,p_request uuid,p_actor text,p_timing_event uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare e inventory_writer_private.events%rowtype;r pos_signed_private.event_revisions%rowtype;v_last bigint;v_q numeric;v_id bigint;t inventory_writer_private.events%rowtype;
begin
 perform pos_signed_private.authorize(p_actor);perform inventory_writer_private.enter(true);
 select * into strict e from inventory_writer_private.events where id=p_event;
 perform id from public.inventory where id=e.item_id for update;
 if not pos_inventory_shadow.valid_time(p_at) or p_at::timestamptz>clock_timestamp() or length(btrim(coalesce(p_proof,'')))<10 or p_request is null then raise exception 'SIGNED_PHYSICAL_TIME_UNPROVEN' using errcode='22023';end if;
 if e.kind not in ('count','purchase','purchase_correction','adjustment','physical_return','keg_replace') then raise exception 'SIGNED_EVENT_NOT_PHYSICAL' using errcode='22023';end if;
 if e.source_hash is distinct from encode(sha256(convert_to(pos_inventory_shadow.writer_log_snapshot(e.log_id)::text,'UTF8')),'hex') then raise exception 'SIGNED_SOURCE_CHANGED' using errcode='40001';end if;
 if lower(btrim(p_unit)) is distinct from lower(btrim(e.unit)) or not exists(select 1 from pos_signed_private.epochs where id=p_epoch and item_id=e.item_id) then raise exception 'SIGNED_SOURCE_UNIT_MISMATCH' using errcode='22023';end if;
 if not exists(select 1 from inventory_writer_private.links where event_id=e.id) and
   ((e.kind='count' and e.new_quantity is distinct from (select observed_quantity from inventory_writer_private.audit_births where log_id=e.log_id)) or (e.kind<>'count' and coalesce(e.quantity,0)<>0)) then raise exception 'SIGNED_MUTATION_AUDIT_UNPAIRED';end if;
 if p_timing_event is not null then
  select * into strict t from inventory_writer_private.events where id=p_timing_event;
  if t.kind<>'keg_timing' or e.kind<>'keg_replace' or t.item_id<>e.item_id
   or (t.source_snapshot#>>'{before_state,active,started_log_id}')::bigint is distinct from e.log_id
   or (t.source_snapshot#>>'{after_state,active,started_at}')::timestamptz is distinct from p_at::timestamptz then raise exception 'SIGNED_KEG_TIMING_LINK_INVALID';end if;
 end if;
 v_q:=pos_signed_private.convert(p_epoch,p_unit,e.quantity,p_at::timestamptz);
 select * into r from pos_signed_private.event_revisions where request_id=p_request;
 if found then
  if r.event_id<>e.id or r.epoch_id<>p_epoch or r.effective_at<>p_at::timestamptz or r.source_unit<>p_unit or r.base_quantity<>v_q or r.proof<>p_proof or r.timing_event is distinct from p_timing_event then raise exception 'SIGNED_IDEMPOTENCY_CONFLICT';end if;
  return jsonb_build_object('revisionId',r.id,'baseQuantity',r.base_quantity);
 end if;
 select id into v_last from pos_signed_private.event_revisions where event_id=e.id order by id desc limit 1;
 if v_last is distinct from p_expected then raise exception 'SIGNED_REVISION_CONFLICT' using errcode='40001';end if;
 insert into pos_signed_private.event_revisions(event_id,prior_id,epoch_id,effective_at,source_unit,base_quantity,proof,actor,request_id,timing_event)
 values(e.id,v_last,p_epoch,p_at::timestamptz,p_unit,v_q,p_proof,p_actor,p_request,p_timing_event) returning id into v_id;
 return jsonb_build_object('revisionId',v_id,'baseQuantity',v_q);
end $$;

create function pos_signed_private.normalize_targets(p_targets jsonb) returns jsonb
language plpgsql stable set search_path=pg_catalog,public as $$
declare v_target jsonb;q numeric;result jsonb:='[]';
begin
 if jsonb_typeof(p_targets) is distinct from 'array' then raise exception 'SIGNED_TARGETS_INVALID';end if;
 for v_target in select value from jsonb_array_elements(p_targets) loop
  if not pos_inventory_shadow.valid_time(v_target->>'effectiveAt') or (v_target->>'effectiveAt')::timestamptz>clock_timestamp()
   or not exists(select 1 from pos_signed_private.epochs where id=(v_target->>'epochId')::bigint and item_id=(v_target->>'itemId')::bigint)
   or (v_target->>'quantity') is null or (v_target->>'quantity')::numeric<0 or nullif(v_target->>'effectKey','') is null then raise exception 'SIGNED_TARGET_EVIDENCE_INVALID';end if;
  q:=pos_signed_private.convert((v_target->>'epochId')::bigint,v_target->>'unit',(v_target->>'quantity')::numeric,(v_target->>'effectiveAt')::timestamptz);
  result:=result||jsonb_build_array(v_target||jsonb_build_object('baseQuantity',q));
 end loop;
 if jsonb_array_length(result)<>(select count(distinct t->>'effectKey') from jsonb_array_elements(result) t) then raise exception 'SIGNED_TARGET_DUPLICATE';end if;
 return result;
end $$;
create function public.pos_signed_adopt_receipt(p_receipt bigint,p_expected_at timestamptz,p_targets jsonb,p_proof text,p_request uuid,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.pos_sales_receipts%rowtype;old pos_signed_private.receipts%rowtype;v_targets jsonb;v_legacy jsonb;v_sum numeric;
begin
 perform pos_signed_private.authorize(p_actor);perform inventory_writer_private.enter(true);
 select * into strict r from public.pos_sales_receipts where id=p_receipt for update;
 v_targets:=pos_signed_private.normalize_targets(p_targets);
 if length(btrim(coalesce(p_proof,'')))<10 or p_request is null then raise exception 'SIGNED_ADOPTION_EVIDENCE_REQUIRED';end if;
 select * into old from pos_signed_private.receipts where receipt_id=r.id;
 if found then
  if old.adoption_key<>p_request or old.baseline<>v_targets or old.proof<>p_proof then raise exception 'SIGNED_ADOPTION_CONFLICT';end if;
  return jsonb_build_object('result','signed_adopted','receiptId',r.id,'inventoryWritten',false);
 end if;
 if r.updated_at is distinct from p_expected_at then raise exception 'SIGNED_RECEIPT_STALE' using errcode='40001';end if;
 -- Preserve every pre-transition deduction/reversal in the baseline evidence.
 select coalesce(jsonb_agg(to_jsonb(d) order by d.id),'[]') into v_legacy from public.pos_inventory_deductions d where d.receipt_id=r.id;
 -- A past monetary cancellation/reversal does not prove physical return.
 if exists(select 1 from public.pos_inventory_deductions d where d.receipt_id=r.id and (d.operation_type='revert' or d.status='reverted')) then
  raise exception 'SIGNED_HISTORIC_REVERSAL_REQUIRES_PHYSICAL_RECONCILIATION';end if;
 -- Explicit targets must cover every currently applied deduction exactly once.
 if exists(select 1 from public.pos_inventory_deductions d where d.receipt_id=r.id and d.status='applied' and coalesce(d.operation_type,'')<>'revert'
    and not exists(select 1 from jsonb_array_elements(v_targets) t where (t->>'deductionId')::bigint=d.id and (t->>'itemId')::bigint=d.inventory_item_id
       and (t->>'quantity')::numeric=d.deduct_quantity_total and lower(btrim(t->>'unit'))=lower(btrim((select unit from public.inventory where id=d.inventory_item_id)))))
   or exists(select 1 from jsonb_array_elements(v_targets) t where not exists(select 1 from public.pos_inventory_deductions d
     where d.id=(t->>'deductionId')::bigint and d.receipt_id=r.id and d.status='applied' and coalesce(d.operation_type,'')<>'revert'
       and d.inventory_item_id=(t->>'itemId')::bigint and d.deduct_quantity_total=(t->>'quantity')::numeric))
   or jsonb_array_length(v_targets)<>(select count(distinct t->>'deductionId') from jsonb_array_elements(v_targets) t) then raise exception 'SIGNED_LEGACY_BASELINE_MISMATCH';end if;
 perform i.id from public.inventory i where i.id in(select (t->>'itemId')::bigint from jsonb_array_elements(v_targets) t) order by i.id for update;
 insert into pos_signed_private.receipts(receipt_id,adoption_key,baseline,legacy_snapshot,proof,actor) values(r.id,p_request,v_targets,v_legacy,p_proof,p_actor);
 return jsonb_build_object('result','signed_adopted','receiptId',r.id,'inventoryWritten',false);
end $$;

create function public.pos_signed_observe_sale(p_receipt bigint,p_parent bigint,p_kind text,p_targets jsonb,p_expected_at timestamptz,p_proof text,p_request uuid,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_last bigint;old pos_signed_private.sale_versions%rowtype;v_targets jsonb;v_id bigint;r public.pos_sales_receipts%rowtype;
begin
 perform pos_signed_private.authorize(p_actor);perform inventory_writer_private.enter(true);
 select * into strict r from public.pos_sales_receipts where id=p_receipt for update;
 if not exists(select 1 from pos_signed_private.receipts where receipt_id=r.id) then raise exception 'SIGNED_RECEIPT_NOT_ADOPTED';end if;
 if p_kind not in ('sale','correction','cancel') or length(btrim(coalesce(p_proof,'')))<10 or p_request is null then raise exception 'SIGNED_SALE_EVIDENCE_REQUIRED';end if;
 select * into old from pos_signed_private.sale_versions where request_id=p_request;
 if found then
  if old.receipt_id<>r.id or old.parent_id is distinct from p_parent or old.kind<>p_kind or old.proof<>p_proof
   or (p_kind<>'cancel' and old.targets<>pos_signed_private.normalize_targets(p_targets))
   or (p_kind='cancel' and p_targets is distinct from '[]'::jsonb) then raise exception 'SIGNED_IDEMPOTENCY_CONFLICT';end if;
  return jsonb_build_object('versionId',old.id,'automaticConfirmation',false,'sourceComplete',false);
 end if;
 if p_kind='cancel' then
  if p_targets is distinct from '[]'::jsonb then raise exception 'SIGNED_CANCEL_CANNOT_ASSERT_RETURN';end if;
  if r.is_canceled is distinct from true then raise exception 'SIGNED_CANCEL_STATUS_MISMATCH';end if;
  select targets into v_targets from pos_signed_private.sale_versions where receipt_id=r.id order by id desc limit 1;
  if v_targets is null then select baseline into v_targets from pos_signed_private.receipts where receipt_id=r.id;end if;
 else v_targets:=pos_signed_private.normalize_targets(p_targets);end if;
 if r.updated_at is distinct from p_expected_at then raise exception 'SIGNED_RECEIPT_STALE' using errcode='40001';end if;
 select id into v_last from pos_signed_private.sale_versions where receipt_id=r.id order by id desc limit 1;
 if v_last is distinct from p_parent then raise exception 'SIGNED_SALE_PARENT_CONFLICT' using errcode='40001';end if;
 insert into pos_signed_private.sale_versions(receipt_id,parent_id,request_id,kind,targets,source_snapshot,proof,actor)
 values(r.id,v_last,p_request,p_kind,v_targets,to_jsonb(r),p_proof,p_actor) returning id into v_id;
 return jsonb_build_object('versionId',v_id,'automaticConfirmation',false,'sourceComplete',false);
end $$;

create function pos_signed_private.route(p_receipt bigint,p_operation text,p_expected timestamptz,p_actor text) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
declare r public.pos_sales_receipts%rowtype;k text;v_result jsonb;
begin
 perform pos_inventory_shadow.authorize(p_actor);perform inventory_writer_private.enter(true);
 select * into strict r from public.pos_sales_receipts where id=p_receipt for update;
 if r.updated_at is distinct from p_expected then return jsonb_build_object('result','failed','failureReason','stale_receipt');end if;
 k:=md5(jsonb_build_array(r.id,p_operation,to_jsonb(r))::text);
 select result into v_result from pos_signed_private.route_requests where request_key=k;if found then return v_result;end if;
 v_result:=jsonb_build_object('result','signed_routed','receiptId',r.id,'operation',p_operation,'inventoryWritten',false,
   'sourceComplete',false,'automaticConfirmation',false,'reason','signed_source_review_required');
 insert into pos_signed_private.route_requests(receipt_id,operation,request_key,snapshot,result) values(r.id,p_operation,k,to_jsonb(r),v_result);
 return v_result;
end $$;
-- Exclusive per-receipt transition fence, before any preview/reversal/stock DML.
-- Other receipts continue on the original legacy engine. No route is activated here.
do $route$
declare c record;p record;b text;v_id text;v_at text;insertion text;patched text;d text;
begin
 for c in select * from inventory_writer_private.rpc_contracts where name in ('prepare_and_apply_sales_inventory_reprocess','reprocess_modified_sales_inventory_deduction_receipt','rollback_canceled_sales_inventory_deduction_receipt') loop
  select * into strict p from pg_proc where oid=c.function_oid;
  if p.prosrc<>c.installed_body then raise exception 'SIGNED_ROUTE_SOURCE_DRIFT';end if;
  v_id:=case when c.name='reprocess_modified_sales_inventory_deduction_receipt' then '(select receipt_id from public.pos_inventory_deduction_receipts where id=p_batch_receipt_id)' else 'p_receipt_id' end;
  v_at:=case when c.name='prepare_and_apply_sales_inventory_reprocess' then 'p_expected_receipt_updated_at' else 'p_expected_receipt_updated_at' end;
  insertion:=format(E'\n if exists(select 1 from pos_signed_private.receipts where receipt_id=%s) then return pos_signed_private.route(%s,%L,%s,p_actor_username);end if; -- SIGNED_ROUTE_FENCE\n',v_id,v_id,c.name,v_at);
  b:=regexp_replace(p.prosrc,'(^|\n)([ \t]*[Bb][Ee][Gg][Ii][Nn])([ \t\r\n])',E'\\1\\2'||insertion||E'\\3');
  d:=pg_get_functiondef(p.oid);execute replace(d,p.prosrc,b);
  if b=p.prosrc or b not like '%SIGNED_ROUTE_FENCE%' then raise exception 'SIGNED_ROUTE_PATCH_MISSING';end if;
  insert into pos_signed_private.rpc_successors values(p.oid,p.prosrc,b);
 end loop;
end $route$;

-- Initial batches may contain multiple receipts; hold a mixed batch atomically
-- rather than execute a legacy deduction for an adopted receipt.
do $$ declare p record;b text;begin
 select pr.* into strict p from inventory_writer_private.rpc_contracts c join pg_proc pr on pr.oid=c.function_oid where c.name='apply_sales_inventory_deduction_batch';
 b:=regexp_replace(p.prosrc,'(^|\n)([ \t]*[Bb][Ee][Gg][Ii][Nn])([ \t\r\n])',E'\\1\\2\n if exists(select 1 from public.pos_inventory_deduction_receipts d join pos_signed_private.receipts a on a.receipt_id=d.receipt_id where d.batch_id=p_batch_id) then return jsonb_build_object(''result'',''signed_batch_held'',''inventoryWritten'',false,''automaticConfirmation'',false,''reason'',''adopted_receipt_in_legacy_batch'');end if;\n\\3');
 if b=p.prosrc then raise exception 'SIGNED_BATCH_PATCH_MISSING';end if;
 execute replace(pg_get_functiondef(p.oid),p.prosrc,b);
 insert into pos_signed_private.rpc_successors values(p.oid,p.prosrc,b);
end $$;
-- Update only the contract resolver in E guards/dispatcher/inspector. All
-- legacy contracts and function OIDs/ACL/defaults remain intact.
do $$ declare p record;b text;begin
 for p in select * from pg_proc where oid in ('inventory_writer_private.capture_change()'::regprocedure,'public.inventory_writer_apply_v1(uuid,text,jsonb,jsonb,bigint)'::regprocedure,'public.inventory_writer_inspect(text)'::regprocedure) loop
  b:=replace(p.prosrc,'fn.prosrc=c.installed_body','fn.prosrc=pos_signed_private.current_rpc_body(c.function_oid)');
  b:=replace(b,'p.prosrc<>p.installed_body','p.prosrc<>pos_signed_private.current_rpc_body(p.oid)');
  b:=replace(b,'p.prosrc is distinct from c.installed_body','p.prosrc is distinct from pos_signed_private.current_rpc_body(c.function_oid)');
  if b=p.prosrc then raise exception 'SIGNED_CONTRACT_RESOLVER_PATCH_MISSING: %',p.proname;end if;
  execute replace(pg_get_functiondef(p.oid),p.prosrc,b);
 end loop;
end $$;

create function public.pos_signed_compare(p_item bigint,p_actor text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare anchor record;v_in numeric;v_out numeric;v_book numeric;v_pending integer;v_result jsonb;v_key text;v_actual numeric;v_base text;v_unit text;v_actual_base numeric;
begin
 perform pos_signed_private.authorize(p_actor);perform inventory_writer_private.enter(true);
 select quantity,unit into v_actual,v_unit from public.inventory where id=p_item for update;
 select r.*,e.log_id into anchor from pos_signed_private.event_revisions r join inventory_writer_private.events e on e.id=r.event_id
 where e.item_id=p_item and e.kind='count' and r.id=(select max(x.id) from pos_signed_private.event_revisions x where x.event_id=r.event_id)
 order by r.effective_at desc,e.log_id desc limit 1;
 if not found then return jsonb_build_object('reason','verified_count_anchor_missing','sourceComplete',false,'automaticConfirmation',false);end if;
 select base_unit into v_base from pos_signed_private.epochs where id=anchor.epoch_id;
 if anchor.epoch_id is distinct from (select id from pos_signed_private.epochs where item_id=p_item order by starts_at desc limit 1) then
  return jsonb_build_object('reason','new_unit_epoch_requires_verified_count','automaticConfirmation',false,'sourceComplete',false);end if;
 select coalesce(sum(r.base_quantity),0) into v_in from pos_signed_private.event_revisions r join inventory_writer_private.events e on e.id=r.event_id
 where e.item_id=p_item and e.kind<>'count' and r.effective_at>anchor.effective_at
 and r.id=(select max(x.id) from pos_signed_private.event_revisions x where x.event_id=r.event_id);
 with latest as (
  select coalesce((select targets from pos_signed_private.sale_versions s where s.receipt_id=a.receipt_id order by id desc limit 1),a.baseline) targets
  from pos_signed_private.receipts a
 ) select coalesce(sum((t->>'baseQuantity')::numeric),0) into v_out from latest cross join lateral jsonb_array_elements(targets) t
 where (t->>'itemId')::bigint=p_item and (t->>'effectiveAt')::timestamptz>anchor.effective_at;
 select count(*) into v_pending from inventory_writer_private.events e where e.item_id=p_item and
 ((e.kind not in ('metadata','sale_posting','keg_timing') and not exists(select 1 from pos_signed_private.event_revisions r where r.event_id=e.id))
 or (e.kind='keg_timing' and not exists(select 1 from pos_signed_private.event_revisions r where r.timing_event=e.id)));
 v_book:=anchor.base_quantity+v_in-v_out;
 -- Comparing container counts directly with ml would hide the legacy two-place
 -- rounding discrepancy. Preserve it visibly; never round away signed debt.
 v_actual_base:=pos_signed_private.convert(anchor.epoch_id,v_unit,v_actual,clock_timestamp());
 v_result:=jsonb_build_object('itemId',p_item,'baseUnit',v_base,'boundaryLogId',anchor.log_id,'boundaryAt',anchor.effective_at,
  'countQuantity',anchor.base_quantity,'physicalMovement',v_in,'consumption',v_out,'bookQuantity',v_book,
  'shortage',greatest(-v_book,0),'operatingQuantity',v_actual,'operatingUnit',v_unit,'operatingBaseQuantity',v_actual_base,
  'differenceToOperating',v_book-v_actual_base,'pendingPhysicalEvents',v_pending,
  'sourceComplete',false,'automaticConfirmation',false,'inventoryWritten',false);
 v_key:=md5(v_result::text);
 insert into pos_signed_private.projections(item_id,dependency,result) values(p_item,v_key,v_result) on conflict do nothing;
 return v_result;
end $$;
revoke all on all tables in schema pos_signed_private from public,anon,authenticated,service_role;
revoke all on all sequences in schema pos_signed_private from public,anon,authenticated,service_role;
revoke all on all functions in schema pos_signed_private from public,anon,authenticated,service_role;
revoke all on function public.pos_signed_define_epoch(bigint,text,text,jsonb,bigint,text,uuid,text),
 public.pos_signed_revise_event(uuid,bigint,text,text,bigint,text,uuid,text,uuid),
 public.pos_signed_adopt_receipt(bigint,timestamptz,jsonb,text,uuid,text),
 public.pos_signed_observe_sale(bigint,bigint,text,jsonb,timestamptz,text,uuid,text),public.pos_signed_compare(bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.pos_signed_define_epoch(bigint,text,text,jsonb,bigint,text,uuid,text),
 public.pos_signed_revise_event(uuid,bigint,text,text,bigint,text,uuid,text,uuid),
 public.pos_signed_adopt_receipt(bigint,timestamptz,jsonb,text,uuid,text),
 public.pos_signed_observe_sale(bigint,bigint,text,jsonb,timestamptz,text,uuid,text),public.pos_signed_compare(bigint,text) to service_role;
