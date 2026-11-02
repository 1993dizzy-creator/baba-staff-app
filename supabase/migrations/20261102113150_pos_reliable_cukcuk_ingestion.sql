-- P1-2D: opt-in ingestion only. No inventory DML, trigger removal, backfill,
-- audit deletion, or migration-history writes. Local generation != POS version.
create schema pos_ingest_private;
revoke all on schema pos_ingest_private from public, anon, authenticated, service_role;

create table pos_ingest_private.runs (
  id uuid primary key, scope text not null, branch_id text not null,
  business_date date not null, window_from timestamptz not null, window_to timestamptz not null,
  generation bigint generated always as identity unique, owner_token uuid not null,
  status text not null check (status in ('collecting','committed','failed','expired')),
  started_at timestamptz not null default clock_timestamp(), lease_until timestamptz not null,
  finished_at timestamptz, payload_hash text, manifest jsonb, result jsonb,
  failure_code text, retry_condition text,
  check(window_from < window_to)
);
create unique index pos_ingest_active_scope on pos_ingest_private.runs(scope) where status='collecting';
create index pos_ingest_recovery on pos_ingest_private.runs(scope,business_date,generation desc);
create table pos_ingest_private.snapshots (
  id bigint generated always as identity primary key,
  scope text not null, ref_id text not null, content_hash text not null,
  payload jsonb not null, first_run uuid not null references pos_ingest_private.runs(id),
  observed_at timestamptz not null default clock_timestamp(),
  unique(scope,ref_id,content_hash)
);
create table pos_ingest_private.heads (
  -- Existing public identity is source+RefID, not Company+branch+RefID. Fail closed
  -- on company/branch collision instead of silently merging two restaurants.
  ref_id text primary key, scope text not null,
  receipt_id bigint not null references public.pos_sales_receipts(id),
  accepted_snapshot bigint references pos_ingest_private.snapshots(id),
  canonical_hash text not null
);
create table pos_ingest_private.observations (
  run_id uuid not null references pos_ingest_private.runs(id),
  snapshot_id bigint not null references pos_ingest_private.snapshots(id),
  outcome text not null check(outcome in ('accepted','duplicate','uncertain','admin_protected')),
  reason text, source_metadata jsonb not null default '{}', primary key(run_id,snapshot_id)
);
create table pos_ingest_private.resolutions (
  id bigint generated always as identity primary key,
  snapshot_id bigint not null references pos_ingest_private.snapshots(id),
  actor_id bigint not null references public.users(id), evidence text not null,
  expected_head bigint, expected_canonical_hash text not null,
  resolved_at timestamptz not null default clock_timestamp(), result jsonb not null
);
create table pos_ingest_private.baselines (
  receipt_id bigint primary key references public.pos_sales_receipts(id),
  snapshot jsonb not null, captured_at timestamptz not null default clock_timestamp()
);
alter table pos_ingest_private.runs enable row level security;
alter table pos_ingest_private.snapshots enable row level security;
alter table pos_ingest_private.heads enable row level security;
alter table pos_ingest_private.observations enable row level security;
alter table pos_ingest_private.resolutions enable row level security;
alter table pos_ingest_private.baselines enable row level security;
revoke all on all tables in schema pos_ingest_private from public,anon,authenticated,service_role;
revoke all on all sequences in schema pos_ingest_private from public,anon,authenticated,service_role;

-- Only fields produced by the reviewed adapter may be written. Defaults, local
-- revisions, exclusions, notes, overrides, and audit IDs cannot enter through JSON.
create function pos_ingest_private.write_projection(p_table text,p_row jsonb,p_id bigint default null)
returns bigint language plpgsql set search_path=pg_catalog,public as $$
declare v_allowed text[]; v_columns text; v_result bigint;
begin
  if p_table='pos_sales_receipts' then
    v_allowed:=string_to_array('source,branch_id,branch_code,branch_name,ref_id,ref_no,business_date,ref_date,payment_status,is_canceled,total_amount,discount_amount,vat_amount,final_amount,receive_amount,return_amount,customer_name,table_name,raw_json,synced_at,updated_at',',');
  elsif p_table='pos_sales_receipt_lines' then
    v_allowed:=string_to_array('source,receipt_id,receipt_ref_id,ref_detail_id,parent_ref_detail_id,business_date,ref_date,sort_order,item_id,item_code,item_name,unit_id,unit_name,quantity,unit_price,amount,discount_amount,final_amount,tax_rate,tax_amount,pre_tax_amount,tax_reduction_amount,ref_detail_type,inventory_item_type,is_option,payment_status,is_canceled,raw_json,synced_at,updated_at',',');
  else raise exception 'ingest_projection_table_invalid' using errcode='22023'; end if;
  select string_agg(format('%I',key),',' order by key) into v_columns
    from jsonb_object_keys(p_row) key where key=any(v_allowed);
  if v_columns is null then raise exception 'ingest_projection_empty'; end if;
  if p_id is null then
    execute format('insert into public.%I(%s) select %s from jsonb_populate_record(null::public.%I,$1) returning id',p_table,v_columns,v_columns,p_table)
      into v_result using p_row;
  else
    -- Identity belongs to the historical row. Case-normalizing a provider GUID
    -- must not rewrite string references in completed deduction evidence.
    if p_table='pos_sales_receipts' then p_row:=p_row-'source'-'ref_id';
    else p_row:=p_row-'source'-'receipt_id'-'receipt_ref_id'-'ref_detail_id'; end if;
    select string_agg(format('%I',key),',' order by key) into v_columns from jsonb_object_keys(p_row) key where key=any(v_allowed);
    execute format('update public.%I set (%s)=(select %s from jsonb_populate_record(null::public.%I,$1)) where id=$2 returning id',p_table,v_columns,v_columns,p_table)
      into v_result using p_row,p_id;
  end if;
  return v_result;
end $$;

-- Hash all canonical receipt/line/payment columns, including local/admin state.
-- A later admin or legacy writer cannot be overwritten by a stale resolution.
create function pos_ingest_private.canonical_hash(p_id bigint)
returns text language sql stable set search_path=pg_catalog,public as $$
 select md5(jsonb_build_object('receipt',(select to_jsonb(r) from public.pos_sales_receipts r where r.id=p_id),
   'lines',(select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]') from public.pos_sales_receipt_lines l where l.receipt_id=p_id),
   'payments',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from public.pos_sales_receipt_payments p where p.receipt_id=p_id))::text)
$$;

create function pos_ingest_private.source_comparable(p_value jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
begin
 if jsonb_typeof(p_value)='object' then
   return (select coalesce(jsonb_object_agg(e.key,pos_ingest_private.source_comparable(e.value)),'{}') from jsonb_each(p_value) e
     where lower(regexp_replace(e.key,'[_[:space:]-]','','g')) not in ('modifieddate','modifieddateutc','updateddate','lastmodifieddate','lastupdateddate'));
 elsif jsonb_typeof(p_value)='array' then
   return (select coalesce(jsonb_agg(pos_ingest_private.source_comparable(a.value) order by a.ordinality),'[]') from jsonb_array_elements(p_value) with ordinality a);
 end if;
 return p_value;
end $$;

-- Bootstrap a legacy receipt automatically only when every projected value,
-- stable line identity and payment already matches. No canonical write or new
-- deduction eligibility occurs in this case. Partial old saves remain held.
create function pos_ingest_private.matches_projection(p_id bigint,p_payload jsonb)
returns boolean language sql stable set search_path=pg_catalog,public as $$
 select exists(select 1 from public.pos_sales_receipts r where r.id=p_id and r.is_modified is distinct from true
   and pos_ingest_private.source_comparable(to_jsonb(r)) @> pos_ingest_private.source_comparable((p_payload->'receipt')-'synced_at'-'updated_at'-'ref_id'))
 and (select count(*) from public.pos_sales_receipt_lines l where l.receipt_id=p_id and (l.is_excluded is distinct from true or
   exists(select 1 from jsonb_array_elements(p_payload->'lines') incoming where lower(incoming->>'ref_detail_id')=lower(l.ref_detail_id))))=jsonb_array_length(p_payload->'lines')
 and not exists(select 1 from jsonb_array_elements(p_payload->'lines') incoming where
   (select count(*) from public.pos_sales_receipt_lines l where l.receipt_id=p_id
      and lower(l.ref_detail_id)=lower(incoming->>'ref_detail_id')
      and pos_ingest_private.source_comparable(to_jsonb(l)) @> pos_ingest_private.source_comparable(incoming-'synced_at'-'updated_at'-'receipt_id'-'receipt_ref_id'-'ref_detail_id'))<>1)
 and (select count(*) from public.pos_sales_receipt_payments p where p.receipt_id=p_id)=jsonb_array_length(p_payload->'payments')
 and not exists(select 1 from jsonb_array_elements(p_payload->'payments') incoming where
   (select count(*) from public.pos_sales_receipt_payments p where p.receipt_id=p_id
      and pos_ingest_private.source_comparable(to_jsonb(p)) @> pos_ingest_private.source_comparable(incoming-'synced_at'-'updated_at'-'receipt_id'-'receipt_ref_id'))<>1)
 and not exists(select 1 from public.pos_sales_receipt_payments p where p.receipt_id=p_id and
   (select count(*) from jsonb_array_elements(p_payload->'payments') incoming where
     pos_ingest_private.source_comparable(to_jsonb(p)) @> pos_ingest_private.source_comparable(incoming-'synced_at'-'updated_at'-'receipt_id'-'receipt_ref_id'))<>1)
$$;

create function pos_ingest_private.projection_key(p_payload jsonb)
returns text language sql immutable set search_path=pg_catalog,public as $$
 select md5(pos_ingest_private.source_comparable(jsonb_build_object(
   'receipt',(p_payload->'receipt')-'synced_at'-'updated_at',
   'lines',(select coalesce(jsonb_agg(l-'synced_at'-'updated_at'-'receipt_id' order by l->>'ref_detail_id'),'[]') from jsonb_array_elements(p_payload->'lines') l),
   'payments',(select coalesce(jsonb_agg(p-'synced_at'-'updated_at'-'receipt_id' order by p::text),'[]') from jsonb_array_elements(p_payload->'payments') p)
 ))::text)
$$;

create function public.pos_ingest_claim(p_run_id uuid,p_owner_token uuid,p_scope text,p_branch_id text,
 p_business_date date,p_from timestamptz,p_to timestamptz)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r pos_ingest_private.runs%rowtype;
begin
  if p_run_id is null or p_owner_token is null or p_scope is null or p_scope !~ '^[a-f0-9]{64}:[a-zA-Z0-9-]+$' or nullif(p_branch_id,'') is null
    or p_from is null or p_to is null or p_from>=p_to or p_business_date is null or split_part(p_scope,':',2)<>p_branch_id then
    raise exception 'ingest_scope_invalid' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pos_ingest:'||p_scope,0));
  select * into r from pos_ingest_private.runs where id=p_run_id for update;
  if found then
    if r.owner_token<>p_owner_token or r.scope<>p_scope or r.branch_id<>p_branch_id or r.business_date<>p_business_date or r.window_from<>p_from or r.window_to<>p_to then
      raise exception 'ingest_run_conflict' using errcode='22023'; end if;
    return jsonb_build_object('status',r.status,'runId',r.id,'generation',r.generation,'result',r.result);
  end if;
  update pos_ingest_private.runs set status='expired',finished_at=clock_timestamp(),failure_code='lease_expired',retry_condition='new_run_full_rescan'
    where scope=p_scope and status='collecting' and lease_until<=clock_timestamp();
  if exists(select 1 from pos_ingest_private.runs where scope=p_scope and status='collecting') then
    return jsonb_build_object('status','busy','retryCondition','lease_release_or_expiry'); end if;
  insert into pos_ingest_private.runs(id,scope,branch_id,business_date,window_from,window_to,owner_token,status,lease_until)
    values(p_run_id,p_scope,p_branch_id,p_business_date,p_from,p_to,p_owner_token,'collecting',clock_timestamp()+interval '10 minutes') returning * into r;
  return jsonb_build_object('status','collecting','runId',r.id,'generation',r.generation);
end $$;

-- One receipt and all its child rows are published by the outer transaction.
-- Stable line IDs retain exclusions/admin notes; removed POS lines are excluded,
-- never deleted. Existing payment reconciliation enforces amounts and identities.
create function pos_ingest_private.publish(p_payload jsonb,p_receipt_id bigint)
returns bigint language plpgsql set search_path=pg_catalog,public as $$
declare v_id bigint:=p_receipt_id; v_line jsonb; v_line_id bigint; v_ref text:=p_payload->'receipt'->>'ref_id'; v_keep bigint[]:='{}'; v_payments jsonb;
begin
  if v_id is not null and exists(select 1 from public.pos_sales_receipts where id=v_id and is_modified=true) then
    raise exception 'ingest_admin_protected' using errcode='55000'; end if;
  if v_id is not null and exists(select 1 from public.pos_sales_receipt_lines where receipt_id=v_id and ref_detail_id is null) then
    raise exception 'ingest_legacy_line_identity_uncertain' using errcode='55000'; end if;
  if v_id is not null then select ref_id into v_ref from public.pos_sales_receipts where id=v_id; end if;
  v_id:=pos_ingest_private.write_projection('pos_sales_receipts',p_payload->'receipt',v_id);
  for v_line in select value from jsonb_array_elements(p_payload->'lines') order by value->>'ref_detail_id' loop
    if (select count(*) from public.pos_sales_receipt_lines where source='cukcuk' and lower(receipt_ref_id)=lower(v_ref) and lower(ref_detail_id)=lower(v_line->>'ref_detail_id'))>1 then
      raise exception 'ingest_line_identity_ambiguous' using errcode='55000'; end if;
    select id into v_line_id from public.pos_sales_receipt_lines where source='cukcuk' and lower(receipt_ref_id)=lower(v_ref) and lower(ref_detail_id)=lower(v_line->>'ref_detail_id') for update;
    v_line_id:=pos_ingest_private.write_projection('pos_sales_receipt_lines',v_line||jsonb_build_object('receipt_id',v_id,'receipt_ref_id',v_ref),v_line_id);
    v_keep:=array_append(v_keep,v_line_id);
  end loop;
  update public.pos_sales_receipt_lines set is_excluded=true,updated_at=clock_timestamp()
    where receipt_id=v_id and not(id=any(v_keep)) and is_excluded is distinct from true;
  select coalesce(jsonb_agg(pay||jsonb_build_object('receipt_ref_id',v_ref)),'[]') into v_payments from jsonb_array_elements(p_payload->'payments') pay;
  perform public.reconcile_sales_receipt_payments_v1(jsonb_build_array(jsonb_build_object('receiptRefId',v_ref,'payments',v_payments)));
  update public.pos_sales_receipts set inventory_deduction_auto_eligible_at=clock_timestamp(),
    inventory_deduction_last_checked_at=null,inventory_deduction_pending_fingerprint=null,inventory_deduction_pending_status=null,
    inventory_deduction_reprocess_required=case when p_receipt_id is not null then true else inventory_deduction_reprocess_required end where id=v_id;
  return v_id;
end $$;

create function public.pos_ingest_commit(p_run_id uuid,p_owner_token uuid,p_manifest jsonb,p_snapshots jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r pos_ingest_private.runs%rowtype; s jsonb; h pos_ingest_private.heads%rowtype;
  v_snapshot bigint; v_receipt bigint; v_outcome text; v_reason text; v_hash text;
  v_result jsonb; v_accepted integer:=0; v_duplicate integer:=0; v_uncertain integer:=0;
  v_missing jsonb; v_sync_run bigint; v_projection_count integer; v_projection_amount numeric;
begin
  select * into r from pos_ingest_private.runs where id=p_run_id;
  if not found then raise exception 'ingest_run_missing' using errcode='55000'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pos_ingest:'||r.scope,0));
  select * into r from pos_ingest_private.runs where id=p_run_id for update;
  v_hash:=md5(jsonb_build_array(p_manifest,p_snapshots)::text);
  if r.owner_token is distinct from p_owner_token then raise exception 'ingest_owner_invalid' using errcode='55000'; end if;
  if r.status='committed' then
    if r.payload_hash is distinct from v_hash then raise exception 'ingest_commit_payload_conflict' using errcode='22023'; end if;
    return r.result;
  end if;
  if r.status<>'collecting' or r.lease_until<=clock_timestamp() then raise exception 'ingest_lease_lost' using errcode='55000'; end if;
  if jsonb_typeof(p_snapshots) is distinct from 'array' or jsonb_typeof(p_manifest) is distinct from 'object'
    or jsonb_typeof(p_manifest->'total') is distinct from 'number' or (p_manifest->>'total')::integer<0
    or jsonb_typeof(p_manifest->'enumeratedCount') is distinct from 'number'
    or jsonb_typeof(p_manifest->'selectedCount') is distinct from 'number'
    or jsonb_typeof(p_manifest->'firstAmount') is distinct from 'number'
    or p_manifest->'firstAmount' is distinct from p_manifest->'secondAmount'
    or jsonb_typeof(p_manifest->'firstPages') is distinct from 'number' or (p_manifest->>'firstPages')::integer<1
    or p_manifest->'firstPages' is distinct from p_manifest->'secondPages'
    or jsonb_typeof(p_manifest->'entries') is distinct from 'array'
    or p_manifest->'collectionComplete' is distinct from 'true'::jsonb
    or p_manifest->'providerSequenceVerified' is distinct from 'false'::jsonb
    or p_manifest->'automaticConfirmation' is distinct from 'false'::jsonb
    or p_manifest->>'firstHash' is distinct from p_manifest->>'secondHash' or length(coalesce(p_manifest->>'firstHash',''))<>64
    or (p_manifest->>'total')::integer is distinct from (p_manifest->>'enumeratedCount')::integer
    or (p_manifest->>'selectedCount')::integer is distinct from jsonb_array_length(p_snapshots)
    or (p_manifest->>'total')::integer<jsonb_array_length(p_snapshots)
    then raise exception 'ingest_manifest_incomplete' using errcode='22023'; end if;
  if jsonb_array_length(p_manifest->'entries')<>(p_manifest->>'total')::integer
    or jsonb_array_length(p_manifest->'entries')<>(select count(distinct value->>'refId') from jsonb_array_elements(p_manifest->'entries'))
    or exists(select 1 from jsonb_array_elements(p_manifest->'entries') e where nullif(e->>'refId','') is null
      or coalesce(e->>'hash','') !~ '^[0-9a-f]{64}$' or jsonb_typeof(e->'amount') is distinct from 'number')
    or (select round(coalesce(sum((e->>'amount')::numeric),0),6) from jsonb_array_elements(p_manifest->'entries') e)<>round((p_manifest->>'firstAmount')::numeric,6) then
    raise exception 'ingest_manifest_entries_invalid' using errcode='22023'; end if;
  if jsonb_array_length(p_snapshots)<>(select count(distinct lower(value->'receipt'->>'ref_id')) from jsonb_array_elements(p_snapshots)) then
    raise exception 'ingest_duplicate_snapshot' using errcode='22023'; end if;
  for s in select value from jsonb_array_elements(p_snapshots) order by lower(value->'receipt'->>'ref_id') loop
    if s->'receipt'->>'source' is distinct from 'cukcuk' or s->'receipt'->>'branch_id' is distinct from r.branch_id
      or (s->'receipt'->>'business_date')::date is distinct from r.business_date
      or s->'receipt'->>'ref_date' is null
      or (s->'receipt'->>'ref_date')::timestamptz<r.window_from or (s->'receipt'->>'ref_date')::timestamptz>=r.window_to
      or nullif(s->'receipt'->>'ref_id','') is null or jsonb_typeof(s->'lines') is distinct from 'array'
      or jsonb_typeof(s->'payments') is distinct from 'array' or coalesce(s->>'contentHash','') !~ '^[0-9a-f]{64}$'
      or not exists(select 1 from jsonb_array_elements(p_manifest->'entries') e where e->>'refId'=s->'receipt'->>'ref_id' and e->>'hash'=s->>'contentHash') then
      raise exception 'ingest_snapshot_invalid' using errcode='22023'; end if;
    if exists(select 1 from jsonb_array_elements(s->'lines') l where nullif(l->>'ref_detail_id','') is null or l->>'source' is distinct from 'cukcuk' or l->>'receipt_ref_id' is distinct from s->'receipt'->>'ref_id')
      or jsonb_array_length(s->'lines')<>(select count(distinct lower(l->>'ref_detail_id')) from jsonb_array_elements(s->'lines') l) then
      raise exception 'ingest_line_identity_invalid' using errcode='22023'; end if;
    insert into pos_ingest_private.snapshots(scope,ref_id,content_hash,payload,first_run)
      values(r.scope,lower(s->'receipt'->>'ref_id'),s->>'contentHash',s,p_run_id) on conflict(scope,ref_id,content_hash) do nothing;
    select id into v_snapshot from pos_ingest_private.snapshots where scope=r.scope and ref_id=lower(s->'receipt'->>'ref_id') and content_hash=s->>'contentHash';
    if (select pos_ingest_private.projection_key(payload) from pos_ingest_private.snapshots where id=v_snapshot)
      is distinct from pos_ingest_private.projection_key(s) then
      raise exception 'ingest_projection_contract_changed' using errcode='55000'; end if;
    -- Identity locks include RefID so cross-company/branch collisions serialize.
    perform pg_advisory_xact_lock(hashtextextended('pos_ingest_receipt:'||lower(s->'receipt'->>'ref_id'),0));
    select * into h from pos_ingest_private.heads where ref_id=lower(s->'receipt'->>'ref_id') for update;
    if (select count(*) from public.pos_sales_receipts where source='cukcuk' and lower(ref_id)=lower(s->'receipt'->>'ref_id'))>1 then
      raise exception 'ingest_receipt_identity_ambiguous' using errcode='55000'; end if;
    select id into v_receipt from public.pos_sales_receipts where source='cukcuk' and lower(ref_id)=lower(s->'receipt'->>'ref_id') for update;
    v_reason:=null;
    if h.ref_id is not null and h.scope<>r.scope then raise exception 'ingest_identity_scope_collision' using errcode='55000'; end if;
    if v_receipt is null then
      v_receipt:=pos_ingest_private.publish(s,null); v_outcome:='accepted';
      insert into pos_ingest_private.heads(ref_id,scope,receipt_id,accepted_snapshot,canonical_hash)
        values(lower(s->'receipt'->>'ref_id'),r.scope,v_receipt,v_snapshot,pos_ingest_private.canonical_hash(v_receipt));
    else
      if h.ref_id is null then
        insert into pos_ingest_private.baselines(receipt_id,snapshot)
          select v_receipt,jsonb_build_object('receipt',to_jsonb(q),
            'lines',(select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]') from public.pos_sales_receipt_lines l where l.receipt_id=v_receipt),
            'payments',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from public.pos_sales_receipt_payments p where p.receipt_id=v_receipt))
          from public.pos_sales_receipts q where q.id=v_receipt on conflict(receipt_id) do nothing;
        insert into pos_ingest_private.heads(ref_id,scope,receipt_id,canonical_hash)
          values(lower(s->'receipt'->>'ref_id'),r.scope,v_receipt,pos_ingest_private.canonical_hash(v_receipt)) returning * into h;
      end if;
      if exists(select 1 from public.pos_sales_receipts where id=v_receipt and is_modified=true) then
        v_outcome:='admin_protected'; v_reason:='local_admin_resolution';
      elsif h.accepted_snapshot is null and pos_ingest_private.matches_projection(v_receipt,s) then
        update pos_ingest_private.heads set accepted_snapshot=v_snapshot,canonical_hash=pos_ingest_private.canonical_hash(v_receipt)
          where ref_id=h.ref_id;
        v_outcome:='duplicate';
      elsif h.accepted_snapshot=v_snapshot and pos_ingest_private.matches_projection(v_receipt,s) then
        v_outcome:='duplicate';
      else v_outcome:='uncertain'; v_reason:=case when h.accepted_snapshot is null then 'legacy_baseline_unverified' else 'provider_order_unverified' end;
      end if;
    end if;
    insert into pos_ingest_private.observations(run_id,snapshot_id,outcome,reason,source_metadata)
      values(p_run_id,v_snapshot,v_outcome,v_reason,coalesce(s->'sourceMetadata','{}'));
    if v_outcome='accepted' then v_accepted:=v_accepted+1;
    elsif v_outcome='duplicate' then v_duplicate:=v_duplicate+1;
    else v_uncertain:=v_uncertain+1; end if;
  end loop;
  -- Missing local IDs are an exception to investigate, never a cancellation or
  -- an authorization to delete. This also catches a same-count substitution.
  select coalesce(jsonb_agg(q.id order by q.id),'[]'),count(*),coalesce(sum(q.final_amount),0)
    into v_missing,v_projection_count,v_projection_amount
    from public.pos_sales_receipts q where q.source='cukcuk' and q.business_date=r.business_date
      and (lower(q.branch_id)=lower(r.branch_id) or q.branch_id is null)
      and not exists(select 1 from jsonb_array_elements(p_snapshots) snap where lower(snap->'receipt'->>'ref_id')=lower(q.ref_id));
  -- Keep the legacy close-client numeric run identity, but never advertise
  -- supplier completeness while snapshot/deletion/filter semantics are unknown.
  insert into public.pos_sales_sync_runs(source,business_date,branch_id,status,started_at,finished_at,request_params,
    source_complete,receipt_count,line_count,created_count,updated_count,canceled_count)
    values('cukcuk',r.business_date,r.branch_id,'success',r.started_at,clock_timestamp(),jsonb_build_object('ingestRunId',r.id,'engine','reliable_v1'),
      false,jsonb_array_length(p_snapshots),(select coalesce(sum(jsonb_array_length(snap->'lines')),0) from jsonb_array_elements(p_snapshots) snap),v_accepted,0,
      (select count(*) from jsonb_array_elements(p_snapshots) snap where snap->'receipt'->'is_canceled'='true'::jsonb)) returning id into v_sync_run;
  p_manifest:=p_manifest||jsonb_build_object('localMissingReceiptIds',v_missing,'localMissingAmount',v_projection_amount);
  v_result:=jsonb_build_object('status','committed','runId',p_run_id,'syncRunId',v_sync_run,'businessDate',r.business_date,
    'collectionComplete',true,'projectionComplete',v_uncertain=0 and v_projection_count=0,'sourceComplete',false,'shadowSourceComplete',false,
    'invoiceCount',jsonb_array_length(p_snapshots),'receiptCreatedCount',v_accepted,'localMissingCount',v_projection_count,
    'acceptedCount',v_accepted,'duplicateCount',v_duplicate,'uncertainCount',v_uncertain,
    'retryCondition',case when v_uncertain>0 then 'authoritative_snapshot_resolution' when v_projection_count>0 then 'provider_export_or_full_gap_rescan' else 'scheduled_full_rescan' end);
  update pos_ingest_private.runs set status='committed',payload_hash=v_hash,manifest=p_manifest,result=v_result,finished_at=clock_timestamp() where id=p_run_id;
  return v_result;
end $$;

-- Failure after an RPC rollback is a separate, fenced status write. Never convert
-- a committed response-loss retry to failed, and never advance completeness.
create function public.pos_ingest_fail(p_run_id uuid,p_owner_token uuid,p_code text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if p_code is null or p_code !~ '^[a-z0-9_]{1,80}$' then raise exception 'ingest_failure_invalid'; end if;
  update pos_ingest_private.runs set status='failed',failure_code=p_code,retry_condition='new_run_full_rescan',finished_at=clock_timestamp()
    where id=p_run_id and owner_token=p_owner_token and status='collecting';
  return jsonb_build_object('status','recorded');
end $$;

-- Operator approval is required only where current supplier evidence cannot
-- decide ordering. No generated sequence is promoted to a provider sequence.
create function public.pos_ingest_resolve(p_snapshot_id bigint,p_expected_head bigint,p_expected_canonical_hash text,p_actor_id bigint,p_evidence text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare s pos_ingest_private.snapshots%rowtype; h pos_ingest_private.heads%rowtype; v_result jsonb;
begin
  if not exists(select 1 from public.users where id=p_actor_id and lower(role::text) in ('owner','master') and is_active=true and app_login_enabled=true) then
    raise exception 'ingest_resolution_forbidden' using errcode='42501'; end if;
  if length(btrim(coalesce(p_evidence,'')))<10 then raise exception 'ingest_resolution_evidence_required' using errcode='22023'; end if;
  select * into s from pos_ingest_private.snapshots where id=p_snapshot_id;
  if not found then raise exception 'ingest_snapshot_missing' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pos_ingest:'||s.scope,0));
  perform pg_advisory_xact_lock(hashtextextended('pos_ingest_receipt:'||s.ref_id,0));
  select * into h from pos_ingest_private.heads where ref_id=s.ref_id for update;
  perform 1 from public.pos_sales_receipts where id=h.receipt_id for update;
  if not found or h.scope<>s.scope then raise exception 'ingest_head_missing'; end if;
  -- Retry after response loss returns the original immutable approval evidence.
  select result into v_result from pos_ingest_private.resolutions where snapshot_id=p_snapshot_id and expected_head is not distinct from p_expected_head
    and expected_canonical_hash=p_expected_canonical_hash and actor_id=p_actor_id and evidence=p_evidence order by id desc limit 1;
  if found then return v_result; end if;
  if h.accepted_snapshot is distinct from p_expected_head or pos_ingest_private.canonical_hash(h.receipt_id) is distinct from p_expected_canonical_hash then
    raise exception 'ingest_resolution_conflict' using errcode='40001'; end if;
  perform pos_ingest_private.publish(s.payload,h.receipt_id);
  update pos_ingest_private.heads set accepted_snapshot=s.id,canonical_hash=pos_ingest_private.canonical_hash(h.receipt_id) where ref_id=s.ref_id;
  v_result:=jsonb_build_object('status','resolved','snapshotId',s.id,'receiptId',h.receipt_id,'shadowSourceComplete',false);
  insert into pos_ingest_private.resolutions(snapshot_id,actor_id,evidence,expected_head,expected_canonical_hash,result)
    values(s.id,p_actor_id,p_evidence,p_expected_head,p_expected_canonical_hash,v_result);
  return v_result;
end $$;

-- Safe inspection and gap discovery; no raw customer payload is returned.
create function public.pos_ingest_inspect(p_scope text,p_since date)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('runs',(select coalesce(jsonb_agg(jsonb_build_object('runId',r.id,'businessDate',r.business_date,'status',r.status,
   'result',r.result,'manifest',r.manifest,'failureCode',r.failure_code,'retryCondition',r.retry_condition) order by r.generation desc),'[]')
   from pos_ingest_private.runs r where r.scope=p_scope and r.business_date>=p_since),
   'holds',(select coalesce(jsonb_agg(jsonb_build_object('snapshotId',s.id,'refId',s.ref_id,'contentHash',s.content_hash,
     'expectedHead',h.accepted_snapshot,'expectedCanonicalHash',pos_ingest_private.canonical_hash(h.receipt_id)) order by s.id),'[]')
     from pos_ingest_private.snapshots s join pos_ingest_private.heads h on h.ref_id=s.ref_id and h.scope=s.scope
     where s.scope=p_scope and (s.payload->'receipt'->>'business_date')::date>=p_since and s.id is distinct from h.accepted_snapshot
       and exists(select 1 from pos_ingest_private.observations ob join pos_ingest_private.runs rr on rr.id=ob.run_id
         where ob.snapshot_id=s.id and ob.outcome in ('uncertain','admin_protected') and not exists(
           select 1 from pos_ingest_private.resolutions resolved where resolved.snapshot_id=s.id and resolved.resolved_at>=rr.finished_at))),
   'retryDates',(select coalesce(jsonb_agg(last.business_date order by last.business_date),'[]') from (
     select distinct on (r.business_date) r.business_date,r.status,r.result from pos_ingest_private.runs r
       where r.scope=p_scope and r.business_date>=p_since order by r.business_date,r.generation desc
   ) last where last.status in ('failed','expired') or last.result->'projectionComplete'='false'::jsonb),
   'shadowSourceComplete',false)
$$;

-- Explicit P1-2E handoff. An observed content ID is never a provider sequence.
-- Even a stable complete enumeration cannot satisfy the unverified provider
-- snapshot/filter/tombstone contract or prove physical event timing.
create function public.pos_ingest_shadow_evidence(p_receipt_id bigint)
returns jsonb language sql security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('receiptId',p_receipt_id,'observedVersion',h.accepted_snapshot,
   'contentHash',snap.content_hash,'sourceSequence',null,'providerSequenceVerified',false,
   'sourceComplete',false,'automaticConfirmation',false,
   'latestOutcome',o.outcome,'collectionRunId',o.run_id,
   'blockingReason',case when h.ref_id is null then 'ingestion_evidence_missing'
     when o.outcome in ('uncertain','admin_protected') then 'source_order_uncertain'
     else 'provider_completeness_and_physical_time_unverified' end)
 from (values(1)) singleton(n)
 left join pos_ingest_private.heads h on h.receipt_id=p_receipt_id
 left join pos_ingest_private.snapshots snap on snap.id=h.accepted_snapshot
 left join lateral (
   select ob.* from pos_ingest_private.observations ob join pos_ingest_private.runs r on r.id=ob.run_id
   join pos_ingest_private.snapshots s on s.id=ob.snapshot_id
   where s.ref_id=h.ref_id and s.scope=h.scope order by r.generation desc limit 1
 ) o on true
$$;

revoke all on all functions in schema pos_ingest_private from public,anon,authenticated,service_role;
revoke all on function public.pos_ingest_claim(uuid,uuid,text,text,date,timestamptz,timestamptz),
 public.pos_ingest_commit(uuid,uuid,jsonb,jsonb),public.pos_ingest_fail(uuid,uuid,text),
 public.pos_ingest_resolve(bigint,bigint,text,bigint,text),public.pos_ingest_inspect(text,date),public.pos_ingest_shadow_evidence(bigint) from public,anon,authenticated,service_role;
grant execute on function public.pos_ingest_claim(uuid,uuid,text,text,date,timestamptz,timestamptz),
 public.pos_ingest_commit(uuid,uuid,jsonb,jsonb),public.pos_ingest_fail(uuid,uuid,text),
 public.pos_ingest_resolve(bigint,bigint,text,bigint,text),public.pos_ingest_inspect(text,date),public.pos_ingest_shadow_evidence(bigint) to service_role;
