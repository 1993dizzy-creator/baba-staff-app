-- P1-2 stage 1: shadow-only, additive, no backfill and no legacy engine changes.
begin;
create schema pos_inventory_shadow;
revoke all on schema pos_inventory_shadow from public,anon,authenticated,service_role;

create table pos_inventory_shadow.streams(
 id bigint generated always as identity primary key,
 source text not null, branch_key text not null, ref_id text not null,
 receipt_id bigint not null references public.pos_sales_receipts(id),
 last_sequence bigint, latest_version integer not null default 0,
 unique(source,branch_key,ref_id)
);
create table pos_inventory_shadow.versions(
 id bigint generated always as identity primary key,
 stream_id bigint not null references pos_inventory_shadow.streams(id),
 version_no integer not null, source_sequence bigint not null,
 kind text not null check(kind in ('sale','correction','cancel')),
 sale_snapshot jsonb not null, semantic_key text not null,
 economic_targets jsonb not null, legacy_targets jsonb not null,
 receipt_updated_at timestamptz not null,
 received_at timestamptz not null default clock_timestamp(),
 unique(stream_id,version_no)
);
create table pos_inventory_shadow.observations(
 id bigint generated always as identity primary key,
 stream_id bigint not null references pos_inventory_shadow.streams(id),
 observation_key text not null, payload_key text not null,
 source_sequence bigint, payload jsonb not null,
 version_id bigint references pos_inventory_shadow.versions(id),
 result jsonb not null, received_at timestamptz not null default clock_timestamp(),
 unique(stream_id,observation_key)
);
create table pos_inventory_shadow.plans(
 id bigint generated always as identity primary key,
 version_id bigint not null references pos_inventory_shadow.versions(id),
 physical_targets jsonb not null, reason text,
 evidence jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create index on pos_inventory_shadow.plans(version_id,id desc);
create table pos_inventory_shadow.jobs(
 id bigint generated always as identity primary key,
 version_id bigint not null unique references pos_inventory_shadow.versions(id),
 state text not null check(state in ('queued','leased','retry_wait','needs_review','completed')),
 generation integer not null default 0, lease_token uuid, lease_until timestamptz,
 next_run_at timestamptz not null default clock_timestamp(),
 failure_reason text, retry_condition text, result jsonb,
 check((state='leased')=(lease_token is not null and lease_until is not null))
);
create index on pos_inventory_shadow.jobs(next_run_at,id) where state in ('queued','retry_wait','leased');
create table pos_inventory_shadow.attempts(
 id bigint generated always as identity primary key,
 job_id bigint not null references pos_inventory_shadow.jobs(id),
 generation integer not null, token uuid not null unique, worker text not null,
 started_at timestamptz not null default clock_timestamp(),
 unique(job_id,generation)
);
create table pos_inventory_shadow.attempt_events(
 id bigint generated always as identity primary key,
 attempt_id bigint not null unique references pos_inventory_shadow.attempts(id),
 outcome text not null check(outcome in ('completed','needs_review','retry_wait','lease_expired')),
 reason text, retry_condition text, result jsonb,
 finished_at timestamptz not null default clock_timestamp()
);
-- Confirmed metadata references an existing immutable audit log. It creates no
-- count, purchase, or physical return in the operating inventory.
create table pos_inventory_shadow.movements(
 id bigint generated always as identity primary key,
 log_id bigint not null unique references public.inventory_logs(id),
 item_id bigint not null references public.inventory(id),
 kind text not null check(kind in ('count','purchase','physical_return','adjustment')),
 quantity numeric not null check(quantity::text not in ('NaN','Infinity','-Infinity')),
 effective_at timestamptz not null, evidence jsonb not null,
 recorded_at timestamptz not null default clock_timestamp()
);
create index on pos_inventory_shadow.movements(item_id,effective_at,id);

create function pos_inventory_shadow.immutable() returns trigger language plpgsql
set search_path=pg_catalog as $$begin raise exception 'POS_SHADOW_IMMUTABLE';end;$$;
do $protect$
declare n text;
begin
 foreach n in array array['versions','observations','plans','attempts','attempt_events','movements'] loop
  execute format('create trigger immutable before update or delete on pos_inventory_shadow.%I for each row execute function pos_inventory_shadow.immutable()',n);
 end loop;
 foreach n in array array['streams','versions','observations','plans','jobs','attempts','attempt_events','movements'] loop
  execute format('alter table pos_inventory_shadow.%I enable row level security',n);
 end loop;
end $protect$;

create function pos_inventory_shadow.authorize(p_actor text) returns void
language plpgsql stable set search_path=pg_catalog,public as $$
begin
 if not exists(select 1 from public.users where username=nullif(btrim(p_actor),'')
  and is_active and role in ('owner','master','manager')) then
  raise exception using errcode='42501',message='POS_SHADOW_PERMISSION_DENIED';
 end if;
end;$$;

-- Explicit offset required: a local wall-clock string is not timing evidence.
create function pos_inventory_shadow.valid_time(p_value text) returns boolean
language plpgsql immutable set search_path=pg_catalog as $$
begin
 if p_value is null or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then return false;end if;
 return isfinite(p_value::timestamptz);
exception when invalid_datetime_format or datetime_field_overflow then return false;
end;$$;

create function public.pos_shadow_capture_version(
 p_receipt_id bigint,p_expected_updated_at timestamptz,p_observation_key text,
 p_source_sequence bigint,p_sale_snapshot jsonb,p_effects jsonb,p_evidence jsonb,p_actor text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare
 r public.pos_sales_receipts%rowtype; s pos_inventory_shadow.streams%rowtype;
 old pos_inventory_shadow.versions%rowtype; o pos_inventory_shadow.observations%rowtype;
 v_id bigint; v_job bigint; v_kind text; v_key text; v_payload jsonb; v_semantic text;
 v_result jsonb; v_targets jsonb; v_legacy jsonb; v_reason text; v_prior_reason text;
begin
 perform pos_inventory_shadow.authorize(p_actor);
 if nullif(p_observation_key,'') is null or length(p_observation_key)>200
  or jsonb_typeof(p_sale_snapshot) is distinct from 'object'
  or jsonb_typeof(p_effects) is distinct from 'array'
  or jsonb_typeof(p_evidence) is distinct from 'object' then raise exception 'POS_SHADOW_INVALID_OBSERVATION';end if;
 select * into r from public.pos_sales_receipts where id=p_receipt_id;
 if not found then raise exception 'POS_SHADOW_RECEIPT_NOT_FOUND';end if;
 if r.updated_at is distinct from p_expected_updated_at then return jsonb_build_object('result','stale_observation');end if;
 if nullif(r.source,'') is null or nullif(r.ref_id,'') is null then raise exception 'POS_SHADOW_SOURCE_IDENTITY_MISSING';end if;
 if exists(select 1 from jsonb_array_elements(p_effects) e
  where nullif(e->>'effectKey','') is null or (e->>'itemId')::bigint is null
   or (e->>'quantity')::numeric is null or (e->>'quantity')::numeric<0
   or (e->>'quantity')::numeric::text in ('NaN','Infinity','-Infinity'))
 or exists(select 1 from jsonb_array_elements(p_effects) e group by e->>'effectKey' having count(*)>1)
 then raise exception 'POS_SHADOW_INVALID_EFFECTS';end if;
 -- Preserve source identity across duplicate receipt rows, without rewriting them.
 insert into pos_inventory_shadow.streams(source,branch_key,ref_id,receipt_id)
 values(r.source,coalesce(to_jsonb(r)->>'branch_id',''),r.ref_id,r.id)
 on conflict(source,branch_key,ref_id) do nothing;
 select * into s from pos_inventory_shadow.streams
 where source=r.source and branch_key=coalesce(to_jsonb(r)->>'branch_id','') and ref_id=r.ref_id for update;
 v_payload:=jsonb_build_object('sale',p_sale_snapshot,'effects',p_effects,'evidence',p_evidence,'sequence',p_source_sequence);
 v_key:=encode(sha256(convert_to(v_payload::text,'UTF8')),'hex');
 select * into o from pos_inventory_shadow.observations where stream_id=s.id and observation_key=p_observation_key;
 if found then
  if o.payload_key<>v_key then raise exception 'POS_SHADOW_OBSERVATION_KEY_CONFLICT';end if;
  return o.result;
 end if;
 select * into old from pos_inventory_shadow.versions where stream_id=s.id and version_no=s.latest_version;
 v_kind:=case when r.is_canceled then 'cancel' when old.id is null then 'sale' else 'correction' end;
 v_semantic:=encode(sha256(convert_to(jsonb_build_object('sale',p_sale_snapshot,
   'canceled',r.is_canceled,'paid',r.payment_status)::text,'UTF8')),'hex');
 select coalesce(jsonb_agg(e order by e->>'effectKey'),'[]') into v_targets from jsonb_array_elements(p_effects) e;
 if p_source_sequence is null then
  v_result:=jsonb_build_object('result','needs_review','reason','source_order_unknown');
 elsif s.last_sequence is not null and p_source_sequence<s.last_sequence then
  v_result:=jsonb_build_object('result','out_of_order','reason','older_source_sequence');
 elsif old.semantic_key=v_semantic and not r.is_canceled and old.economic_targets<>v_targets then
  v_result:=jsonb_build_object('result','needs_review','reason','same_version_plan_conflict','versionId',old.id);
 elsif old.semantic_key=v_semantic then
  v_result:=jsonb_build_object('result','duplicate','versionId',old.id,'version',old.version_no);
  update pos_inventory_shadow.streams set last_sequence=greatest(last_sequence,p_source_sequence) where id=s.id;
 elsif s.last_sequence is not null and p_source_sequence=s.last_sequence then
  v_result:=jsonb_build_object('result','needs_review','reason','source_sequence_conflict');
 else
  -- Opening links reuse legacy audit facts; no legacy row is altered or replayed.
  select coalesce(jsonb_agg(jsonb_build_object('effectKey','legacy:'||d.id,'itemId',d.inventory_item_id,
    'quantity',d.deduct_quantity_total,'effectiveAt',r.ref_date,'deductionId',d.id) order by d.id),'[]')
  into v_legacy from public.pos_inventory_deductions d
  where d.receipt_id=s.receipt_id and coalesce(d.operation_type,'deduction')<>'revert'
   and (d.status in ('applied','success') or d.applied_at is not null or d.inventory_log_id is not null)
   and not exists(select 1 from public.pos_inventory_deductions rev where rev.reversal_of_deduction_id=d.id
    and rev.operation_type='revert' and (rev.status in ('applied','success','reverted') or rev.applied_at is not null or rev.inventory_log_id is not null));
  if v_kind='cancel' then
   if old.id is not null then
    select physical_targets,reason into v_targets,v_prior_reason from pos_inventory_shadow.plans where version_id=old.id order by id desc limit 1;
   else v_targets:=v_legacy;end if;
  end if;
  v_reason:=case
   when r.payment_status is distinct from 3 and not r.is_canceled then 'sale_not_confirmed'
   when v_kind='cancel' and old.id is null and jsonb_array_length(v_legacy)=0 then 'cancel_without_physical_baseline'
   when v_prior_reason is not null then 'previous_timing_unresolved'
   when nullif(p_evidence->>'proof','') is null or p_evidence->>'timeBasis' is null
     or p_evidence->>'timeBasis' not in ('physical_event','historical_correction') then 'physical_time_unproven'
   when exists(select 1 from jsonb_array_elements(v_targets) e where not pos_inventory_shadow.valid_time(e->>'effectiveAt')
      or case when pos_inventory_shadow.valid_time(e->>'effectiveAt') then (e->>'effectiveAt')::timestamptz>clock_timestamp() else false end) then 'physical_time_unknown'
   when old.id is null and exists(select 1 from jsonb_array_elements(v_legacy) e
     where e->>'itemId' is null or e->>'quantity' is null or (e->>'quantity')::numeric<=0
       or (e->>'quantity')::numeric::text in ('NaN','Infinity','-Infinity')
       or not pos_inventory_shadow.valid_time(e->>'effectiveAt')) then 'legacy_baseline_unknown'
   else null end;
  insert into pos_inventory_shadow.versions(stream_id,version_no,source_sequence,kind,sale_snapshot,
   semantic_key,economic_targets,legacy_targets,receipt_updated_at)
  values(s.id,s.latest_version+1,p_source_sequence,v_kind,p_sale_snapshot,v_semantic,
   case when v_kind='cancel' then '[]'::jsonb else v_targets end,v_legacy,p_expected_updated_at) returning id into v_id;
  insert into pos_inventory_shadow.plans(version_id,physical_targets,reason,evidence) values(v_id,v_targets,v_reason,p_evidence);
  insert into pos_inventory_shadow.jobs(version_id,state,failure_reason,retry_condition)
  values(v_id,case when v_reason is null then 'queued' else 'needs_review' end,v_reason,
   case when v_reason is not null then 'new_timing_or_source_evidence' end) returning id into v_job;
  update pos_inventory_shadow.streams set latest_version=latest_version+1,last_sequence=p_source_sequence where id=s.id;
  v_result:=jsonb_build_object('result',case when v_reason is null then 'queued' else 'needs_review' end,
   'versionId',v_id,'version',s.latest_version+1,'jobId',v_job,'reason',v_reason);
 end if;
 insert into pos_inventory_shadow.observations(stream_id,observation_key,payload_key,source_sequence,payload,version_id,result)
 values(s.id,p_observation_key,v_key,p_source_sequence,v_payload,coalesce(v_id,(v_result->>'versionId')::bigint),v_result);
 return v_result;
end;$$;

create function public.pos_shadow_register_movement(
 p_log_id bigint,p_kind text,p_effective_at text,p_evidence jsonb,p_actor text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare l public.inventory_logs%rowtype; m pos_inventory_shadow.movements%rowtype; v_id bigint; v_q numeric;
begin
 perform pos_inventory_shadow.authorize(p_actor);
 if p_kind is null or p_kind not in ('count','purchase','physical_return','adjustment')
  or not pos_inventory_shadow.valid_time(p_effective_at)
  or p_effective_at::timestamptz>clock_timestamp() or nullif(p_evidence->>'proof','') is null
 then raise exception 'POS_SHADOW_MOVEMENT_EVIDENCE_REQUIRED';end if;
 select * into l from public.inventory_logs where id=p_log_id;
 if not found then raise exception 'POS_SHADOW_LOG_NOT_FOUND';end if;
 -- Same item row used by the existing count save RPC and P0. No stock write.
 perform id from public.inventory where id=l.item_id for update;
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'POS_SHADOW_REQUIRES_READ_COMMITTED';end if;
 if (p_kind='count' and l.reason is distinct from 'stock_check')
  or (p_kind='purchase' and l.reason is distinct from 'purchase')
  or (p_kind='physical_return' and (coalesce(l.change_quantity,0)<=0 or l.source='pos_sales' or l.reason in ('purchase','stock_check')))
  or (p_kind='adjustment' and (l.source='pos_sales' or l.reason in ('purchase','stock_check')))
 then raise exception 'POS_SHADOW_LOG_KIND_MISMATCH';end if;
 v_q:=case when p_kind='count' then l.new_quantity else l.change_quantity end;
 if v_q is null or v_q::text in ('NaN','Infinity','-Infinity') or (p_kind='count' and v_q<0) then raise exception 'POS_SHADOW_INVALID_MOVEMENT_QUANTITY';end if;
 select * into m from pos_inventory_shadow.movements where log_id=p_log_id;
 if found then
  if m.kind<>p_kind or m.effective_at<>p_effective_at::timestamptz or m.evidence<>p_evidence or m.quantity<>v_q then
   raise exception 'POS_SHADOW_MOVEMENT_CONFLICT';end if;
  return jsonb_build_object('movementId',m.id,'result','duplicate');
 end if;
 insert into pos_inventory_shadow.movements(log_id,item_id,kind,quantity,effective_at,evidence)
 values(l.id,l.item_id,p_kind,v_q,p_effective_at::timestamptz,p_evidence) returning id into v_id;
 return jsonb_build_object('movementId',v_id,'result','recorded');
end;$$;

create function public.pos_shadow_claim(p_worker text,p_actor text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j pos_inventory_shadow.jobs%rowtype; v_token uuid:=gen_random_uuid();
begin
 perform pos_inventory_shadow.authorize(p_actor);
 if nullif(btrim(p_worker),'') is null or length(p_worker)>100 then raise exception 'POS_SHADOW_INVALID_WORKER';end if;
 select q.* into j from pos_inventory_shadow.jobs q join pos_inventory_shadow.versions v on v.id=q.version_id
 where ((q.state in ('queued','retry_wait') and q.next_run_at<=clock_timestamp()) or (q.state='leased' and q.lease_until<clock_timestamp()))
  and not exists(select 1 from pos_inventory_shadow.jobs prior join pos_inventory_shadow.versions pv on pv.id=prior.version_id
    where pv.stream_id=v.stream_id and pv.version_no<v.version_no and prior.state<>'completed')
 order by q.next_run_at,q.id for update of q skip locked limit 1;
 if not found then return jsonb_build_object('result','empty');end if;
 if j.state='leased' then
  insert into pos_inventory_shadow.attempt_events(attempt_id,outcome,reason,retry_condition)
  select id,'lease_expired','worker_lease_expired','reclaimed_with_new_token' from pos_inventory_shadow.attempts where token=j.lease_token;
 end if;
 update pos_inventory_shadow.jobs set state='leased',generation=generation+1,lease_token=v_token,
  lease_until=clock_timestamp()+interval '30 seconds' where id=j.id;
 insert into pos_inventory_shadow.attempts(job_id,generation,token,worker) values(j.id,j.generation+1,v_token,p_worker);
 return jsonb_build_object('result','leased','jobId',j.id,'versionId',j.version_id,'token',v_token);
end;$$;

create function public.pos_shadow_fail(p_job_id bigint,p_token uuid,p_sqlstate text,p_actor text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j pos_inventory_shadow.jobs%rowtype; v_retry boolean;
begin
 perform pos_inventory_shadow.authorize(p_actor);
 select * into j from pos_inventory_shadow.jobs where id=p_job_id for update;
 if not found or j.state<>'leased' or j.lease_token<>p_token or j.lease_until<clock_timestamp() then
  return jsonb_build_object('result','lease_lost');end if;
 v_retry:=p_sqlstate in ('55P03','40P01','40001') or p_sqlstate like '08%';
 insert into pos_inventory_shadow.attempt_events(attempt_id,outcome,reason,retry_condition)
 select id,case when v_retry then 'retry_wait' else 'needs_review' end,coalesce(p_sqlstate,'unknown_sql_error'),
  case when v_retry then 'backoff_elapsed' else 'new_evidence_or_engine_fix' end from pos_inventory_shadow.attempts where token=p_token;
 update pos_inventory_shadow.jobs set state=case when v_retry then 'retry_wait' else 'needs_review' end,
  failure_reason=coalesce(p_sqlstate,'unknown_sql_error'),retry_condition=case when v_retry then 'backoff_elapsed' else 'new_evidence_or_engine_fix' end,
  next_run_at=clock_timestamp()+least(3600,30*power(2,least(generation,7))) * interval '1 second',
  lease_token=null,lease_until=null where id=p_job_id;
 return jsonb_build_object('result',case when v_retry then 'retry_wait' else 'needs_review' end);
end;$$;

revoke all on all tables in schema pos_inventory_shadow from public,anon,authenticated,service_role;
revoke all on all sequences in schema pos_inventory_shadow from public,anon,authenticated,service_role;
revoke all on all functions in schema pos_inventory_shadow from public,anon,authenticated,service_role;
revoke all on function public.pos_shadow_capture_version(bigint,timestamptz,text,bigint,jsonb,jsonb,jsonb,text),
 public.pos_shadow_register_movement(bigint,text,text,jsonb,text),public.pos_shadow_claim(text,text),
 public.pos_shadow_fail(bigint,uuid,text,text) from public,anon,authenticated;
grant execute on function public.pos_shadow_capture_version(bigint,timestamptz,text,bigint,jsonb,jsonb,jsonb,text),
 public.pos_shadow_register_movement(bigint,text,text,jsonb,text),public.pos_shadow_claim(text,text),
 public.pos_shadow_fail(bigint,uuid,text,text) to service_role;
commit;
