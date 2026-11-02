-- P1-2 stage 2: expected quantities only. No operating inventory writer exists.
begin;
alter table pos_inventory_shadow.jobs add column last_dependency_key text;
create table pos_inventory_shadow.settlements(
 id bigint generated always as identity primary key,
 version_id bigint not null unique references pos_inventory_shadow.versions(id),
 job_id bigint not null unique references pos_inventory_shadow.jobs(id),
 physical_targets jsonb not null,economic_targets jsonb not null,
 result jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create table pos_inventory_shadow.item_effects(
 id bigint generated always as identity primary key,
 settlement_id bigint not null references pos_inventory_shadow.settlements(id),
 item_id bigint not null references public.inventory(id),
 economic_delta numeric not null,current_stock_delta numeric not null,
 boundary_log_id bigint references public.inventory_logs(id),
 book_quantity numeric not null,shortage numeric not null check(shortage>=0),shortage_reason text,
 legacy_raw_delta numeric not null,legacy_decision text not null,
 unique(settlement_id,item_id)
);
create table pos_inventory_shadow.coverage(
 id bigint generated always as identity primary key,
 movement_id bigint not null references pos_inventory_shadow.movements(id),
 evidence jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table pos_inventory_shadow.comparisons(
 id bigint generated always as identity primary key,
 item_id bigint not null references public.inventory(id),dependency_key text not null,
 result jsonb not null,created_at timestamptz not null default clock_timestamp(),
 unique(item_id,dependency_key)
);
do $protect$
declare n text;
begin
 foreach n in array array['settlements','item_effects','coverage','comparisons'] loop
  execute format('alter table pos_inventory_shadow.%I enable row level security',n);
  execute format('create trigger immutable before update or delete on pos_inventory_shadow.%I for each row execute function pos_inventory_shadow.immutable()',n);
 end loop;
end $protect$;

-- Caller holds the version's stream; dependency records include relevant item
-- audit high-water marks, plans, physical evidence and preceding settlements.
create function pos_inventory_shadow.dependencies(p_version_id bigint) returns text
language sql stable set search_path=pg_catalog,public as $$
 with v as (select * from pos_inventory_shadow.versions where id=p_version_id),
 targets as (
  select physical_targets t from pos_inventory_shadow.plans where version_id=p_version_id order by id desc limit 1
 ), ids as (
  select (e->>'itemId')::bigint id from targets cross join lateral jsonb_array_elements(t) e
  union select (e->>'itemId')::bigint from v cross join lateral jsonb_array_elements(legacy_targets) e
  union select (e->>'itemId')::bigint from pos_inventory_shadow.settlements st
   join pos_inventory_shadow.versions pv on pv.id=st.version_id cross join lateral jsonb_array_elements(st.physical_targets) e
   where pv.stream_id=(select stream_id from v)
 )
 select encode(sha256(convert_to(jsonb_build_object(
  'engine','shadow-v1','plan',(select max(id) from pos_inventory_shadow.plans where version_id=p_version_id),
  'settlement',(select max(st.id) from pos_inventory_shadow.settlements st
    join pos_inventory_shadow.versions settled_v on settled_v.id=st.version_id
    where settled_v.stream_id=(select stream_id from v)
      or exists(select 1 from jsonb_array_elements(st.physical_targets) e where (e->>'itemId')::bigint in(select id from ids))),
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'quantity',i.quantity,
    'latestLog',(select max(id) from public.inventory_logs where item_id=x.id),
    'movement',(select max(id) from pos_inventory_shadow.movements where item_id=x.id),
    'coverage',(select max(c.id) from pos_inventory_shadow.coverage c join pos_inventory_shadow.movements m on m.id=c.movement_id where m.item_id=x.id)) order by x.id)
   from ids x left join public.inventory i on i.id=x.id),'[]'::jsonb))::text,'UTF8')),'hex');
$$;

-- A closed count anchors the signed book, independent of the operating quantity.
-- p_targets is the incoming version; latest settled targets of other streams
-- contribute once. Current POS logs are NOT added again as physical movements.
create function pos_inventory_shadow.item_book(p_item bigint,p_stream bigint default null,p_targets jsonb default null,p_version bigint default null)
returns jsonb language plpgsql stable set search_path=pg_catalog,public as $$
declare a pos_inventory_shadow.movements%rowtype; v_in numeric; v_out numeric;
 v_book numeric; v_actual numeric; v_reason text; v_complete boolean; v_pending boolean;
begin
 select * into a from pos_inventory_shadow.movements where item_id=p_item and kind='count'
 order by effective_at desc,id desc limit 1;
 if not found then return jsonb_build_object('itemId',p_item,'reason','stock_check_anchor_missing');end if;
 if exists(select 1 from public.inventory_logs l where l.item_id=p_item and l.reason='stock_check'
   and (l.created_at is null or l.created_at>=a.effective_at)
   and not exists(select 1 from pos_inventory_shadow.movements m where m.log_id=l.id and m.kind='count')) then
  return jsonb_build_object('itemId',p_item,'reason','unverified_stock_check');
 end if;
 if exists(select 1 from public.inventory_logs l where l.item_id=p_item and coalesce(l.source,'')<>'pos_sales'
   and l.reason is distinct from 'stock_check' and coalesce(l.change_quantity,0)<>0
   and (l.created_at is null or l.created_at>a.effective_at)
   and not exists(select 1 from pos_inventory_shadow.movements m where m.log_id=l.id)) then
  return jsonb_build_object('itemId',p_item,'reason','movement_time_unconfirmed');
 end if;
 select coalesce(sum(quantity),0) into v_in from pos_inventory_shadow.movements
 where item_id=p_item and kind<>'count' and effective_at>a.effective_at;
 with latest as (
  select distinct on(v.stream_id) v.stream_id,st.physical_targets t
  from pos_inventory_shadow.settlements st join pos_inventory_shadow.versions v on v.id=st.version_id
  where p_stream is null or v.stream_id<>p_stream order by v.stream_id,v.version_no desc
 ), all_targets as (
  select t from latest union all select p_targets where p_stream is not null
 )
 select coalesce(sum((e->>'quantity')::numeric),0) into v_out from all_targets
 cross join lateral jsonb_array_elements(t) e
 where (e->>'itemId')::bigint=p_item and (e->>'effectiveAt')::timestamptz>a.effective_at;
 v_book:=a.quantity+v_in-v_out;
 select quantity into v_actual from public.inventory where id=p_item;
 -- A claim of complete source coverage is explicit; a timestamp alone proves
 -- neither POS feed completeness nor that an unobserved receipt is unrelated.
 v_complete:=coalesce((a.evidence->>'coverageComplete')::boolean,false)
  or exists(select 1 from pos_inventory_shadow.coverage where movement_id=a.id);
 select exists(select 1 from public.pos_sales_receipts r where r.ref_date>a.effective_at
  and (r.payment_status=3 or r.is_canceled)
  and not exists(select 1 from pos_inventory_shadow.streams s where s.source=r.source and s.ref_id=r.ref_id
    and s.branch_key=coalesce(to_jsonb(r)->>'branch_id','')
    and (s.id=p_stream or exists(select 1 from pos_inventory_shadow.settlements st
      join pos_inventory_shadow.versions v on v.id=st.version_id where v.stream_id=s.id)))) into v_pending;
 v_pending:=v_pending or exists(select 1 from pos_inventory_shadow.jobs j
  join pos_inventory_shadow.versions pending_v on pending_v.id=j.version_id
  join pos_inventory_shadow.plans p on p.version_id=j.version_id
  where j.state<>'completed' and (p_version is null or j.version_id<>p_version)
   and p.id=(select max(pp.id) from pos_inventory_shadow.plans pp where pp.version_id=j.version_id)
   and (exists(select 1 from jsonb_array_elements(p.physical_targets) e where (e->>'itemId')::bigint=p_item)
    or exists(select 1 from pos_inventory_shadow.plans history
      join pos_inventory_shadow.versions history_v on history_v.id=history.version_id
      cross join lateral jsonb_array_elements(history.physical_targets) e
      where history_v.stream_id=pending_v.stream_id and (e->>'itemId')::bigint=p_item)));
 return jsonb_build_object('itemId',p_item,'boundaryLogId',a.log_id,'boundaryAt',a.effective_at,
  'countQuantity',a.quantity,'physicalMovement',v_in,'consumption',v_out,'bookQuantity',v_book,
  'available',greatest(v_book,0),'shortage',greatest(-v_book,0),'operatingQuantity',v_actual,
  'shortageReason',case when v_book<0 then 'confirmed_consumption_exceeds_count_and_movements' end,
  'bookDifference',v_book-v_actual,'projectionComplete',v_complete and not v_pending,
  'coverageReason',case when not v_complete then 'coverage_not_attested' when v_pending then 'unobserved_receipts' end,
  'reason',null);
end;$$;

create function public.pos_shadow_settle(p_job_id bigint,p_token uuid,p_actor text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare
 j pos_inventory_shadow.jobs%rowtype; v pos_inventory_shadow.versions%rowtype;
 s pos_inventory_shadow.streams%rowtype; p pos_inventory_shadow.plans%rowtype;
 prev pos_inventory_shadow.settlements%rowtype;
 v_old_physical jsonb; v_old_economic jsonb; v_items jsonb:='[]'; v_book jsonb;
 v_item bigint; v_delta numeric; v_economic numeric; v_legacy numeric; v_actual numeric;
 v_new_q numeric; v_old_q numeric; v_reason text; v_decision text:='would_apply';
 v_result jsonb; v_settlement bigint; v_dependency text; v_sale_at timestamptz; v_p1 jsonb;
begin
 perform pos_inventory_shadow.authorize(p_actor);
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'POS_SHADOW_REQUIRES_READ_COMMITTED';end if;
 select vv.* into v from pos_inventory_shadow.versions vv join pos_inventory_shadow.jobs jj on jj.version_id=vv.id where jj.id=p_job_id;
 if not found then return jsonb_build_object('result','job_not_found');end if;
 select * into s from pos_inventory_shadow.streams where id=v.stream_id for update;
 select * into j from pos_inventory_shadow.jobs where id=p_job_id for update;
 if j.state='completed' and j.lease_token is null
  and exists(select 1 from pos_inventory_shadow.attempts where job_id=j.id and token=p_token
    and generation=j.generation) then return j.result;end if;
 if j.state<>'leased' or j.lease_token<>p_token or j.lease_until<clock_timestamp() then
  return jsonb_build_object('result','lease_lost');end if;
 select * into p from pos_inventory_shadow.plans where version_id=v.id order by id desc limit 1;
 select st.* into prev from pos_inventory_shadow.settlements st
 join pos_inventory_shadow.versions pv on pv.id=st.version_id
 where pv.stream_id=s.id and pv.version_no<v.version_no order by pv.version_no desc limit 1;
 v_old_physical:=coalesce(prev.physical_targets,v.legacy_targets);
 v_old_economic:=coalesce(prev.economic_targets,v.legacy_targets);
 v_reason:=p.reason;
 if exists(select 1 from pos_inventory_shadow.jobs prior join pos_inventory_shadow.versions pv on pv.id=prior.version_id
   where pv.stream_id=s.id and pv.version_no<v.version_no and prior.state<>'completed') then v_reason:='previous_version_unsettled';end if;

 -- Sorted short item locks serialize with count publication and purchase writes.
 -- No external calls or operating DML occur in this critical section.
 perform i.id from public.inventory i where i.id in (
  select (e->>'itemId')::bigint from jsonb_array_elements(p.physical_targets||v_old_physical||v.economic_targets||v_old_economic) e
 ) order by i.id for update;
 if j.lease_until<clock_timestamp() then return jsonb_build_object('result','lease_lost');end if;
 v_dependency:=pos_inventory_shadow.dependencies(v.id);
 if v_reason is null then
  for v_item in select distinct (e->>'itemId')::bigint from jsonb_array_elements(p.physical_targets||v_old_physical||v.economic_targets||v_old_economic) e order by 1 loop
   if not exists(select 1 from public.inventory where id=v_item) then v_reason:='inventory_item_missing';exit;end if;
   v_book:=pos_inventory_shadow.item_book(v_item,s.id,p.physical_targets,v.id);
   if v_book->>'reason' is not null then v_reason:=v_book->>'reason';exit;end if;
   select coalesce(sum((e->>'quantity')::numeric),0) into v_new_q from jsonb_array_elements(p.physical_targets) e
    where (e->>'itemId')::bigint=v_item and (e->>'effectiveAt')::timestamptz>(v_book->>'boundaryAt')::timestamptz;
   select coalesce(sum((e->>'quantity')::numeric),0) into v_old_q from jsonb_array_elements(v_old_physical) e
    where (e->>'itemId')::bigint=v_item and (e->>'effectiveAt')::timestamptz>(v_book->>'boundaryAt')::timestamptz;
   v_delta:=v_old_q-v_new_q;
   select coalesce(sum((e->>'quantity')::numeric),0) into v_new_q from jsonb_array_elements(v.economic_targets) e where (e->>'itemId')::bigint=v_item;
   select coalesce(sum((e->>'quantity')::numeric),0) into v_old_q from jsonb_array_elements(v_old_economic) e where (e->>'itemId')::bigint=v_item;
   v_economic:=v_old_q-v_new_q;
   select coalesce(sum((e->>'quantity')::numeric),0) into v_old_q from jsonb_array_elements(v.legacy_targets) e where (e->>'itemId')::bigint=v_item;
   v_legacy:=v_old_q-v_new_q;
   select quantity into v_actual from public.inventory where id=v_item;
   if v_actual+v_legacy<0 then v_decision:='insufficient_stock_after_reversal';end if;
   v_items:=v_items||jsonb_build_array(v_book||jsonb_build_object('economicDelta',v_economic,
    'currentStockDelta',v_delta,'legacyRawDelta',v_legacy,'legacyRawAfter',v_actual+v_legacy,
    'movementDifference',v_delta-v_legacy,'classification',case when v_delta=0 and v_economic<>0 then 'absorbed_or_nonphysical'
      when v_delta=0 then 'no_movement' else 'current_period_delta' end));
  end loop;
 end if;
 select ref_date into v_sale_at from public.pos_sales_receipts where id=s.receipt_id;
 if v_decision='would_apply' and exists(select 1 from jsonb_array_elements(v_items) e where (e->>'legacyRawDelta')::numeric<>0)
  and (v_sale_at is null or exists(select 1 from public.inventory_logs l
   where l.source is distinct from 'pos_sales' and l.reason='stock_check'
    and l.item_id in(select (e->>'itemId')::bigint from jsonb_array_elements(v_items) e)
    and (l.created_at is null or l.created_at>=v_sale_at))) then v_decision:='stock_check_boundary_requires_review';end if;
 -- Reuse P1-1's persisted request/result evidence; never call its stock writer
 -- from shadow, and never manufacture another P1-1 preview for comparison.
 select coalesce(jsonb_agg(jsonb_build_object('deductionReceiptId',d.id,'requestKey',d.reprocess_request_key,
   'status',d.status,'reason',d.error_message,'result',d.reprocess_result) order by d.id),'[]') into v_p1
 from public.pos_inventory_deduction_receipts d where d.receipt_id=s.receipt_id
  and d.previewed_receipt_updated_at=v.receipt_updated_at and d.reprocess_request_key is not null;
 v_result:=jsonb_build_object('mode','shadow','result',case when v_reason is null then 'shadow_settled' else 'needs_review' end,
  'versionId',v.id,'version',v.version_no,'kind',v.kind,'items',v_items,
  'legacyDecision',v_decision,'p1Evidence',v_p1,'reason',v_reason,'operatingInventoryWritten',false);
 if j.lease_until<clock_timestamp() then return jsonb_build_object('result','lease_lost');end if;
 if v_reason is null then
  insert into pos_inventory_shadow.settlements(version_id,job_id,physical_targets,economic_targets,result)
  values(v.id,j.id,p.physical_targets,v.economic_targets,v_result) returning id into v_settlement;
  insert into pos_inventory_shadow.item_effects(settlement_id,item_id,economic_delta,current_stock_delta,boundary_log_id,book_quantity,shortage,shortage_reason,legacy_raw_delta,legacy_decision)
  select v_settlement,(e->>'itemId')::bigint,(e->>'economicDelta')::numeric,(e->>'currentStockDelta')::numeric,
   (e->>'boundaryLogId')::bigint,(e->>'bookQuantity')::numeric,(e->>'shortage')::numeric,e->>'shortageReason',(e->>'legacyRawDelta')::numeric,v_decision
  from jsonb_array_elements(v_items) e;
 end if;
 insert into pos_inventory_shadow.attempt_events(attempt_id,outcome,reason,retry_condition,result)
 select id,case when v_reason is null then 'completed' else 'needs_review' end,v_reason,
  case when v_reason is not null then 'new_boundary_movement_or_timing_evidence' end,v_result
 from pos_inventory_shadow.attempts where token=p_token;
 update pos_inventory_shadow.jobs set state=case when v_reason is null then 'completed' else 'needs_review' end,
  result=v_result,failure_reason=v_reason,retry_condition=case when v_reason is not null then 'new_boundary_movement_or_timing_evidence' end,
  last_dependency_key=v_dependency,lease_token=null,lease_until=null where id=j.id;
 return v_result;
end;$$;

create function public.pos_shadow_retry(p_job_id bigint,p_actor text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j pos_inventory_shadow.jobs%rowtype; k text;
begin
 perform pos_inventory_shadow.authorize(p_actor);
 select * into j from pos_inventory_shadow.jobs where id=p_job_id for update;
 if not found or j.state<>'needs_review' then return jsonb_build_object('result','not_waiting');end if;
 if (select reason from pos_inventory_shadow.plans where version_id=j.version_id order by id desc limit 1) is not null then
  return jsonb_build_object('result','waiting_for_evidence');end if;
 k:=pos_inventory_shadow.dependencies(j.version_id);
 if k is not distinct from j.last_dependency_key then return jsonb_build_object('result','waiting_for_dependency_change');end if;
 update pos_inventory_shadow.jobs set state='queued',next_run_at=clock_timestamp(),last_dependency_key=k where id=j.id;
 return jsonb_build_object('result','queued');
end;$$;

create function public.pos_shadow_resolve_timing(p_version bigint,p_times jsonb,p_evidence jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v pos_inventory_shadow.versions%rowtype; p pos_inventory_shadow.plans%rowtype; targets jsonb;
begin
 perform pos_inventory_shadow.authorize(p_actor);
 select * into v from pos_inventory_shadow.versions where id=p_version;
 if not found then raise exception 'POS_SHADOW_VERSION_NOT_FOUND';end if;
 perform id from pos_inventory_shadow.streams where id=v.stream_id for update;
 perform id from pos_inventory_shadow.jobs where version_id=p_version for update;
 if exists(select 1 from pos_inventory_shadow.settlements where version_id=p_version) then raise exception 'POS_SHADOW_ALREADY_SETTLED';end if;
 select * into p from pos_inventory_shadow.plans where version_id=p_version order by id desc limit 1;
 if p.reason is null or p.reason not in ('physical_time_unknown','physical_time_unproven','previous_timing_unresolved') then raise exception 'POS_SHADOW_TIMING_RESOLUTION_NOT_APPLICABLE';end if;
 if jsonb_typeof(p_times) is distinct from 'object' or nullif(p_evidence->>'proof','') is null
  or p_evidence->>'timeBasis' is null or p_evidence->>'timeBasis' not in ('physical_event','historical_correction') then raise exception 'POS_SHADOW_TIMING_EVIDENCE_REQUIRED';end if;
 if exists(select 1 from jsonb_object_keys(p_times) k where not exists(select 1 from jsonb_array_elements(p.physical_targets) e where e->>'effectKey'=k))
  or exists(select 1 from jsonb_array_elements(p.physical_targets) e where not pos_inventory_shadow.valid_time(p_times->>(e->>'effectKey'))
    or case when pos_inventory_shadow.valid_time(p_times->>(e->>'effectKey')) then (p_times->>(e->>'effectKey'))::timestamptz>clock_timestamp() else false end)
 then raise exception 'POS_SHADOW_INVALID_TIMING_RESOLUTION';end if;
 select coalesce(jsonb_agg(e||jsonb_build_object('effectiveAt',p_times->>(e->>'effectKey')) order by e->>'effectKey'),'[]') into targets from jsonb_array_elements(p.physical_targets) e;
 insert into pos_inventory_shadow.plans(version_id,physical_targets,reason,evidence) values(v.id,targets,null,p_evidence);
 return jsonb_build_object('result','evidence_recorded');
end;$$;

create function public.pos_shadow_confirm_coverage(p_log bigint,p_evidence jsonb,p_actor text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare m pos_inventory_shadow.movements%rowtype;
begin
 perform pos_inventory_shadow.authorize(p_actor);
 select * into m from pos_inventory_shadow.movements where log_id=p_log and kind='count';
 if not found or nullif(p_evidence->>'proof','') is null then raise exception 'POS_SHADOW_COVERAGE_EVIDENCE_REQUIRED';end if;
 perform id from public.inventory where id=m.item_id for update;
 insert into pos_inventory_shadow.coverage(movement_id,evidence) values(m.id,p_evidence);
 return jsonb_build_object('result','coverage_recorded');
end;$$;

-- Ambiguous additions spanning a count need separately evidenced physical
-- events. This may split timing attribution but cannot change the total demand.
create function public.pos_shadow_resolve_physical_plan(p_version bigint,p_targets jsonb,p_evidence jsonb,p_actor text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v pos_inventory_shadow.versions%rowtype;p pos_inventory_shadow.plans%rowtype;
begin
 perform pos_inventory_shadow.authorize(p_actor);
 select * into v from pos_inventory_shadow.versions where id=p_version;
 if not found then raise exception 'POS_SHADOW_VERSION_NOT_FOUND';end if;
 perform id from pos_inventory_shadow.streams where id=v.stream_id for update;
 perform id from pos_inventory_shadow.jobs where version_id=p_version for update;
 select * into p from pos_inventory_shadow.plans where version_id=p_version order by id desc limit 1;
 if p.reason is distinct from 'physical_change_needs_split_events'
  or exists(select 1 from pos_inventory_shadow.settlements where version_id=p_version) then raise exception 'POS_SHADOW_PLAN_RESOLUTION_NOT_APPLICABLE';end if;
 if jsonb_typeof(p_targets) is distinct from 'array' or nullif(p_evidence->>'proof','') is null then raise exception 'POS_SHADOW_PLAN_EVIDENCE_REQUIRED';end if;
 if exists(select 1 from jsonb_array_elements(p_targets) e where nullif(e->>'effectKey','') is null
   or (e->>'itemId')::bigint is null or (e->>'quantity')::numeric is null or (e->>'quantity')::numeric<0
   or (e->>'quantity')::numeric::text in ('NaN','Infinity','-Infinity')
   or not pos_inventory_shadow.valid_time(e->>'effectiveAt')
   or case when pos_inventory_shadow.valid_time(e->>'effectiveAt') then (e->>'effectiveAt')::timestamptz>clock_timestamp() else false end)
  or exists(select 1 from jsonb_array_elements(p_targets) e group by e->>'effectKey' having count(*)>1)
  or exists(with totals as(
    select (e->>'itemId')::bigint i,sum((e->>'quantity')::numeric) q from jsonb_array_elements(p.physical_targets) e group by 1
   ),new_totals as(
    select (e->>'itemId')::bigint i,sum((e->>'quantity')::numeric) q from jsonb_array_elements(p_targets) e group by 1
   )select 1 from totals full join new_totals using(i) where totals.q is distinct from new_totals.q)
 then raise exception 'POS_SHADOW_INVALID_PHYSICAL_PLAN';end if;
 insert into pos_inventory_shadow.plans(version_id,physical_targets,evidence) values(p_version,p_targets,p_evidence);
 return jsonb_build_object('result','evidence_recorded');
end;$$;

-- Refresh comparison after a count/purchase/return even when every sale job is
-- already completed. This recomputes the book; it does not reapply sales.
create function public.pos_shadow_compare_item(p_item bigint,p_actor text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare r jsonb; k text;
begin
 perform pos_inventory_shadow.authorize(p_actor);
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'POS_SHADOW_REQUIRES_READ_COMMITTED';end if;
 perform id from public.inventory where id=p_item for update;
 if not found then raise exception 'POS_SHADOW_INVENTORY_NOT_FOUND';end if;
 r:=pos_inventory_shadow.item_book(p_item);
 k:=encode(sha256(convert_to(r::text,'UTF8')),'hex');
 insert into pos_inventory_shadow.comparisons(item_id,dependency_key,result) values(p_item,k,r) on conflict do nothing;
 return r||jsonb_build_object('mode','shadow','operatingInventoryWritten',false);
end;$$;

create function public.pos_shadow_read_receipt(p_receipt bigint,p_actor text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare r jsonb;
begin
 perform pos_inventory_shadow.authorize(p_actor);
 r:=pos_inventory_shadow.receipt_snapshot(p_receipt);
 if r is null then raise exception 'POS_SHADOW_RECEIPT_NOT_FOUND';end if;
 return r||jsonb_build_object('snapshotKey',encode(sha256(convert_to((r->'snapshot')::text,'UTF8')),'hex'));
end;$$;

create function public.pos_shadow_job_status(p_job bigint,p_actor text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r jsonb;
begin
 perform pos_inventory_shadow.authorize(p_actor);
 select jsonb_build_object('jobId',j.id,'versionId',j.version_id,'state',j.state,
  'failureReason',j.failure_reason,'retryCondition',j.retry_condition,'nextRunAt',j.next_run_at,
  'leaseUntil',j.lease_until,'result',j.result,'mode','shadow',
  'attempts',coalesce((select jsonb_agg(jsonb_build_object('generation',a.generation,'worker',a.worker,
    'startedAt',a.started_at,'outcome',e.outcome,'reason',e.reason,'finishedAt',e.finished_at) order by a.generation)
   from pos_inventory_shadow.attempts a left join pos_inventory_shadow.attempt_events e on e.attempt_id=a.id
   where a.job_id=j.id),'[]'::jsonb)) into r from pos_inventory_shadow.jobs j where j.id=p_job;
 return coalesce(r,jsonb_build_object('result','job_not_found'));
end;$$;

revoke all on all tables in schema pos_inventory_shadow from public,anon,authenticated,service_role;
revoke all on all sequences in schema pos_inventory_shadow from public,anon,authenticated,service_role;
revoke all on all functions in schema pos_inventory_shadow from public,anon,authenticated,service_role;
revoke all on function public.pos_shadow_settle(bigint,uuid,text),public.pos_shadow_retry(bigint,text),
 public.pos_shadow_resolve_timing(bigint,jsonb,jsonb,text),public.pos_shadow_confirm_coverage(bigint,jsonb,text),
 public.pos_shadow_resolve_physical_plan(bigint,jsonb,jsonb,text),
 public.pos_shadow_compare_item(bigint,text),public.pos_shadow_read_receipt(bigint,text),
 public.pos_shadow_job_status(bigint,text) from public,anon,authenticated;
grant execute on function public.pos_shadow_settle(bigint,uuid,text),public.pos_shadow_retry(bigint,text),
 public.pos_shadow_resolve_timing(bigint,jsonb,jsonb,text),public.pos_shadow_confirm_coverage(bigint,jsonb,text),
 public.pos_shadow_resolve_physical_plan(bigint,jsonb,jsonb,text),
 public.pos_shadow_compare_item(bigint,text),public.pos_shadow_read_receipt(bigint,text),
 public.pos_shadow_job_status(bigint,text) to service_role;
commit;
