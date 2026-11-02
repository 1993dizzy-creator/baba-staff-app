-- P1-2C: shared audit-log interface only. No operating writer/trigger changes,
-- no audit rewrites, no automatic timestamp inference, no backfill.
begin;
create function pos_inventory_shadow.writer_log_snapshot(p_log bigint) returns jsonb
language sql stable set search_path=pg_catalog,public set timezone='UTC' as $$
 select jsonb_build_object('logId',l.id,'itemId',l.item_id,'reason',l.reason,'source',l.source,
  'changeQuantity',l.change_quantity,'previousQuantity',l.prev_quantity,'newQuantity',l.new_quantity,
  'unit',to_jsonb(l)->'unit','createdAt',l.created_at,'businessDate',l.business_date,
  'rootLogId',to_jsonb(l)->'correction_of_inventory_log_id',
  'receiptId',to_jsonb(l)->'related_receipt_id','deductionId',to_jsonb(l)->'related_deduction_id')
 from public.inventory_logs l where l.id=p_log;
$$;

create function public.pos_shadow_inventory_writer_contract(p_log bigint,p_actor text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare s jsonb; w text; k text; reason text; status text:='needs_evidence';q numeric;
begin
 perform pos_inventory_shadow.authorize(p_actor);
 s:=pos_inventory_shadow.writer_log_snapshot(p_log);
 if s is null then return jsonb_build_object('result','not_found');end if;
 q:=(s->>'changeQuantity')::numeric;
 if s->>'source'='pos_sales' then
  w:='pos_sales';status:='excluded';reason:='use_sale_version_ledger';
 elsif s->>'source'='photo' and q=0 then
  w:='metadata';status:='excluded';reason:='no_quantity_movement';
 elsif s->>'source'='keg_replace' and s->>'reason'='sale_deduction' and q=-1 then
  w:='keg_replace';k:='adjustment';
 elsif s->>'source' in ('quick_save','edit_form','create') then
  if s->>'reason'='stock_check' then w:='stock_check';k:='count';
  elsif s->>'reason'='purchase' then
   w:=case when s->>'rootLogId' is not null or q<0 then 'purchase_correction' else 'purchase' end;k:='purchase';
   if q<0 and s->>'rootLogId' is null then status:='blocked';reason:='purchase_correction_root_missing';end if;
   if s->>'rootLogId' is not null and not exists(select 1 from public.inventory_logs root
     where root.id=(s->>'rootLogId')::bigint and root.item_id=(s->>'itemId')::bigint
       and root.reason='purchase' and root.change_quantity>0 and to_jsonb(root)->>'correction_of_inventory_log_id' is null) then
    status:='blocked';reason:='purchase_correction_root_invalid';end if;
  elsif q=0 then w:='metadata';status:='excluded';reason:='no_quantity_movement';
  elsif s->>'reason' in ('other','service','sale_deduction') then w:='manual_adjustment';k:='adjustment';
  else w:='unknown';status:='blocked';reason:='writer_reason_unclassified';end if;
  if s->>'source'='create' and status='needs_evidence' then w:='inventory_create';end if;
 else w:='unknown';status:='blocked';reason:='writer_source_unclassified';end if;
 if q is null or q::text in ('NaN','Infinity','-Infinity') then status:='blocked';reason:='quantity_unknown';end if;
 return jsonb_build_object('result',status,'writer',w,'suggestedKind',k,'reason',reason,
  'audit',s,'sourceLogHash',encode(sha256(convert_to(s::text,'UTF8')),'hex'),
  'eventTimeInferred',false,'operatingInventoryWritten',false,
  'evidenceRequired',jsonb_build_array('physical_effective_at_with_offset','physical_event_proof'),
  'replacementAllowed',false);
end;$$;

create function public.pos_shadow_register_writer_movement(
 p_log bigint,p_expected_log_hash text,p_effective_at text,p_kind text,p_evidence jsonb,p_actor text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare c jsonb; item bigint;k text;
begin
 perform pos_inventory_shadow.authorize(p_actor);
 select item_id into item from public.inventory_logs where id=p_log;
 if not found then return jsonb_build_object('result','not_found');end if;
 -- Existing stock writers and count publication already lock this item. No
 -- source/month/receipt locks are introduced into those writers by this API.
 perform id from public.inventory where id=item for update;
 perform id from public.inventory_logs where id=p_log for share;
 c:=public.pos_shadow_inventory_writer_contract(p_log,p_actor);
 if c->>'sourceLogHash' is distinct from p_expected_log_hash then
  return jsonb_build_object('result','stale_source','reason','audit_log_changed');end if;
 if c->>'result'<>'needs_evidence' then return c;end if;
 k:=c->>'suggestedKind';
 if p_kind='physical_return' and c->>'writer'='manual_adjustment'
  and (c#>>'{audit,changeQuantity}')::numeric>0 and nullif(p_evidence->>'physicalEventRef','') is not null then
  k:='physical_return';
 elsif p_kind is distinct from k then
  return jsonb_build_object('result','needs_review','reason','writer_kind_mismatch');
 end if;
 if not pos_inventory_shadow.valid_time(p_effective_at) or nullif(p_evidence->>'proof','') is null then
  return jsonb_build_object('result','needs_review','reason','physical_time_evidence_required');end if;
 return public.pos_shadow_register_movement(p_log,k,p_effective_at,
  p_evidence||jsonb_build_object('writer',c->>'writer','sourceLogHash',c->>'sourceLogHash'),p_actor);
end;$$;

-- Existing logs can be reclassified by metadata routes. Never silently reuse a
-- stale quantity or fingerprint in a supposedly deterministic Shadow result.
create function pos_inventory_shadow.check_movement_sources(p_item bigint) returns text
language sql stable set search_path=pg_catalog,public set timezone='UTC' as $$
 select case when exists(
  select 1 from pos_inventory_shadow.movements m left join public.inventory_logs l on l.id=m.log_id
   left join public.inventory i on i.id=m.item_id
  where m.item_id=p_item and (l.id is null or l.item_id is distinct from m.item_id
    or (case when m.kind='count' then l.new_quantity else l.change_quantity end) is distinct from m.quantity
    or (m.kind='count' and l.reason is distinct from 'stock_check')
    or (m.kind='purchase' and l.reason is distinct from 'purchase')
    or (m.kind not in ('count','purchase') and (l.source='pos_sales' or l.reason in ('purchase','stock_check')))
    or (nullif(to_jsonb(l)->>'unit','') is not null and to_jsonb(l)->>'unit' is distinct from i.unit)
    or (m.evidence ? 'sourceLogHash' and m.evidence->>'sourceLogHash' is distinct from
      encode(sha256(convert_to(pos_inventory_shadow.writer_log_snapshot(l.id)::text,'UTF8')),'hex')))
 ) then 'shadow_source_audit_changed' else null end;
$$;

revoke all on all functions in schema pos_inventory_shadow from public,anon,authenticated,service_role;
revoke all on function public.pos_shadow_inventory_writer_contract(bigint,text),
 public.pos_shadow_register_writer_movement(bigint,text,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.pos_shadow_inventory_writer_contract(bigint,text),
 public.pos_shadow_register_writer_movement(bigint,text,text,text,jsonb,text) to service_role;

-- Fail closed if this function differs from the reviewed P1-2 definition.
do $contract$ begin
 if (select md5(replace(replace(prosrc,E'\r\n',E'\n'),E'\r',E'\n')) from pg_proc
   where oid='pos_inventory_shadow.item_book(bigint,bigint,jsonb,bigint)'::regprocedure) <> '27bbadcaa4c4ad61846b978d4f94895d' then
  raise exception 'POS_SHADOW_ITEM_BOOK_CONTRACT_MISMATCH';end if;
end $contract$;

create or replace function pos_inventory_shadow.item_book(p_item bigint,p_stream bigint default null,p_targets jsonb default null,p_version bigint default null)
returns jsonb language plpgsql stable set search_path=pg_catalog,public as $$
declare a pos_inventory_shadow.movements%rowtype; v_in numeric; v_out numeric;
 v_book numeric; v_actual numeric; v_reason text; v_complete boolean; v_pending boolean;
begin
 v_reason:=pos_inventory_shadow.check_movement_sources(p_item);
 if v_reason is not null then return jsonb_build_object('itemId',p_item,'reason',v_reason);end if;
 select * into a from pos_inventory_shadow.movements where item_id=p_item and kind='count'
 order by effective_at desc,log_id desc limit 1;
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


-- Evidence repair must invalidate a held job even when quantity/log ID did not change.
create or replace function pos_inventory_shadow.dependencies(p_version_id bigint) returns text
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
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'quantity',i.quantity,'unit',i.unit,
    'sourceIntegrity',pos_inventory_shadow.check_movement_sources(x.id),
    'latestLog',(select max(id) from public.inventory_logs where item_id=x.id),
    'movement',(select max(id) from pos_inventory_shadow.movements where item_id=x.id),
    'coverage',(select max(c.id) from pos_inventory_shadow.coverage c join pos_inventory_shadow.movements m on m.id=c.movement_id where m.item_id=x.id)) order by x.id)
   from ids x left join public.inventory i on i.id=x.id),'[]'::jsonb))::text,'UTF8')),'hex');
$$;
commit;
